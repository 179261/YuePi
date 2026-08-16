// ============ PDF 阅读 + 手写批注视图（虚拟滚动 + 两级渲染 + 位图缓存） ============
// 性能设计：
//  - 页面尺寸"分批并行测量"：首批并发测 48 页立即上屏，其余页后台继续测，不再串行等全部测完
//  - DOM 虚拟化：只挂载可视区 ± VIRTUAL_BUFFER 页的节点，几百页文档也只渲染几十个节点
//  - 两级渲染：翻页/打开时当前页先以低清快速上屏（不白屏），80ms 后再离屏高清升级替换
//  - LRU 位图缓存：渲染结果缓存最近若干页，翻页回看直接显示，不重新渲染
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import * as pdfEngine from '../core/pdfEngine'
import { Annotator } from '../core/annotate'
import * as db from '../core/db'
import { flattenAnnotations } from '../core/exportPdf'
import { downloadBlob, downloadDataURL } from '../core/download'
import type { PDFDocMeta, Tool } from '../core/types'

export interface PdfViewerHandle {
  getCurrentPageSnapshot: () => Promise<{ dataUrl: string; pageNum: number } | null>
  getCurrentPageText: () => Promise<string>
  getFullText: () => Promise<string>
  exportAnnotatedPDF: () => Promise<void>
  exportCurrentPNG: () => Promise<void>
  /** 显示/隐藏 PDF 工具栏（供顶栏按钮调用） */
  toggleToolbar: () => void
}

interface Props {
  meta: PDFDocMeta
  onToast: (msg: string) => void
  onAskImage: (dataUrl: string, label: string) => void
  onAskText: (text: string, label: string) => void
  onToBoard?: () => void
  boardOverlayOpen?: boolean
  onToggleBoard?: () => void
  /** 文档加载完成后上报页数（用于列表回填，导入阶段不再解析） */
  onPagesLoaded?: (count: number) => void
  /** 当前页变化（用于保存阅读位置） */
  onPageChange?: (page: number) => void
}

const COLORS = [
  '#e11d48', '#ef4444', '#f97316', '#facc15', '#22c55e', '#06b6d4',
  '#3b82f6', '#8b5cf6', '#ec4899', '#111827', '#ffffff'
]

interface RectSel { x: number; y: number; w: number; h: number }

/** 框选覆盖层：在页面上拖拽框选区域，松手回调（坐标已换算为页面基准坐标） */
function SelectOverlay({
  active,
  zoom,
  onSelect,
  onCancel
}: {
  active: boolean
  zoom: number
  onSelect: (r: RectSel) => void
  onCancel: () => void
}) {
  const [sel, setSel] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)

  const toLocal = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const z = Math.max(0.05, zoom)
    return { x: (e.clientX - rect.left) / z, y: (e.clientY - rect.top) / z }
  }

  return (
    <div
      className={active ? 'select-overlay active' : 'select-overlay'}
      onPointerDown={(e) => {
        if (!active) return
        e.preventDefault()
        const p = toLocal(e)
        startRef.current = p
        setSel({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (!startRef.current) return
        const p = toLocal(e)
        setSel((s) => (s ? { ...s, x1: p.x, y1: p.y } : s))
      }}
      onPointerUp={(e) => {
        const s = startRef.current
        if (!s) return
        const p = toLocal(e)
        startRef.current = null
        const x0 = Math.min(s.x, p.x)
        const y0 = Math.min(s.y, p.y)
        const x1 = Math.max(s.x, p.x)
        const y1 = Math.max(s.y, p.y)
        setSel(null)
        if (x1 - x0 > 6 && y1 - y0 > 6) onSelect({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
        else onCancel()
      }}
      onPointerCancel={() => {
        startRef.current = null
        setSel(null)
      }}
    >
      {sel && (
        <div
          className="select-rect"
          style={{
            left: Math.min(sel.x0, sel.x1),
            top: Math.min(sel.y0, sel.y1),
            width: Math.abs(sel.x1 - sel.x0),
            height: Math.abs(sel.y1 - sel.y0)
          }}
        />
      )}
    </div>
  )
}

// ---------- 渲染参数 ----------
type PageSize = { width: number; height: number }
type SizeOrNull = PageSize | null

/**
 * 渲染策略（单级渲染，消除"低清先行 + 高清升级"的二次渲染，总渲染时间几乎减半）：
 *  - 当前页：直接渲染最高清（用户可调的精度档位，默认 2.0 = 平板屏幕 1:1 物理像素）
 *  - 邻居页（cur±RENDER_WINDOW）：低清 LOW_QUALITY，滚动进入视口时已有内容
 *  - 滚动中：限流渲染当前页低清（PREVIEW_QUALITY），保证滑动时页面有内容
 *  - 位图缓存：已看过的页翻回直接恢复，零等待
 */
/** 渲染窗口：当前页前后各预渲染的页数（缩小窗口 → 渲染总量更少，当前页高清独占优先） */
const RENDER_WINDOW = 1
/** 虚拟化缓冲：可视区前后额外挂载的页面数（必须 ≥ RENDER_WINDOW，预渲染的页才有 DOM） */
const VIRTUAL_BUFFER = 3
/** 邻居页清晰度 */
const LOW_QUALITY = 1.25
/** 滚动中当前页的"跟随"清晰度（快速上屏，停止后升级最高清） */
const PREVIEW_QUALITY = 1.25
/** 同时渲染的页数上限（2 路：当前页高清优先，避免被邻居页争抢 CPU） */
const CONCURRENCY = 2
/** 位图缓存：页数上限与总像素预算（A4@1.75 ≈ 2.8M 像素/页，预算 ≈ 7 页） */
const MAX_CACHE_PAGES = 10
const MAX_CACHE_PIXELS = 20 * 1024 * 1024
/** 页面纵向间距与上下留白（与 CSS 保持一致） */
const PAGE_GAP = 14
const PAD_TOP = 12
const PAD_BOTTOM = 12
/** 首批并发测量的页数（首屏 + 滚动缓冲） */
const FIRST_MEASURE = 96
/** 后续每批测量的页数 */
const MEASURE_BATCH = 32
const MEASURE_CONCURRENCY = 16

/** 每页顶部偏移（相对滚动内容顶部；未测页用估算高度） */
function computeOffsets(sizes: readonly SizeOrNull[], estH: number, zoom: number): number[] {
  const o: number[] = []
  let acc = PAD_TOP
  for (let i = 0; i < sizes.length; i++) {
    o.push(acc)
    acc += (sizes[i] ? sizes[i]!.height : estH) * zoom + PAGE_GAP
  }
  return o
}

/** 根据滚动位置求当前页索引（0-based） */
function pageIndexAt(offs: readonly number[], mid: number): number {
  if (!offs.length) return 0
  let lo = 0
  let hi = offs.length - 1
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1
    if (offs[m] <= mid) lo = m
    else hi = m - 1
  }
  return lo
}

// ============ 单个 PDF 页面节点 ============
// memo 化：滚动只改变「挂载/卸载哪些页」，已挂载页面的 props（尺寸/缩放/偏移/工具等）不变，
// 因此滚动中 React 会跳过它们的重渲染（此前每帧重建所有页面 JSX 是滑动卡顿的主因之一）。
const PageItem = memo(function PageItem({
  i,
  size,
  estW,
  estH,
  zoom,
  top,
  drawActive,
  tool,
  onCrop,
  onCanvasMounted,
  pageEls,
  pdfCanvases,
  annoCanvases
}: {
  i: number
  size: PageSize | null
  estW: number
  estH: number
  zoom: number
  top: number
  drawActive: boolean
  tool: Tool
  onCrop: (pageNum: number, r: RectSel) => void
  /** canvas 挂载时通知父组件（虚拟化回收后重新挂载的是全新画布，需撤销"已渲染"记录，否则会被误跳过 → 空白页） */
  onCanvasMounted: (i: number) => void
  pageEls: (HTMLDivElement | null)[]
  pdfCanvases: (HTMLCanvasElement | null)[]
  annoCanvases: (HTMLCanvasElement | null)[]
}) {
  // ref 回调在组件内创建并依赖固定 i：跨渲染保持同一引用，配合 memo 不会使子组件失效
  const setPageEl = useCallback((el: HTMLDivElement | null) => { pageEls[i] = el }, [i, pageEls])
  const setPdfCanvas = useCallback(
    (el: HTMLCanvasElement | null) => {
      pdfCanvases[i] = el
      if (el) onCanvasMounted(i)
    },
    [i, pdfCanvases, onCanvasMounted]
  )
  const setAnnoCanvas = useCallback((el: HTMLCanvasElement | null) => { annoCanvases[i] = el }, [i, annoCanvases])
  const w = (size ? size.width : estW) * zoom
  const h = (size ? size.height : estH) * zoom
  return (
    <div ref={setPageEl} className="page-wrap v" style={{ top, width: w, height: h }}>
      <div
        className="page-scale"
        style={{
          transform: `scale(${zoom})`,
          transformOrigin: 'top left',
          width: size ? size.width : estW,
          height: size ? size.height : estH
        }}
      >
        {size ? (
          <>
            {/* CSS 尺寸必须显式设置：渲染在离屏画布完成后拷贝到可见画布，可见画布本身不再被引擎设置尺寸 */}
            <canvas ref={setPdfCanvas} className="pdf-canvas" style={{ width: size.width, height: size.height }} />
            <canvas ref={setAnnoCanvas} className={drawActive ? 'anno-canvas draw' : 'anno-canvas'} />
            <SelectOverlay active={tool === 'select'} zoom={zoom} onSelect={(r) => onCrop(i + 1, r)} onCancel={() => {}} />
          </>
        ) : (
          <div className="page-ph">正在解析…</div>
        )}
      </div>
    </div>
  )
})

const PdfViewer = forwardRef<PdfViewerHandle, Props>(function PdfViewer(
  { meta, onToast, onAskImage, onAskText, onToBoard, boardOverlayOpen, onToggleBoard, onPagesLoaded, onPageChange },
  ref
) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [sizes, setSizes] = useState<SizeOrNull[]>([])
  const [zoom, setZoom] = useState(1)
  /** 渲染精度档位（canvas 物理分辨率倍率）：默认跟随设备像素密度（高清屏 2.5/3 也能 1:1 显示）；
   *  2x 偏低通常是因为平板 dpr>2（如 2.5/3），档位最高到 4x，可显著提升清晰度 */
  const [quality, setQuality] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('yuepi.quality')
      if (saved) {
        const v = parseFloat(saved)
        if (v >= 1.25 && v <= 4) return v
      }
    } catch {
      /* ignore */
    }
    // 默认至少 2x；高 dpr 屏幕（华为/小米平板常见 2.25~3）跟随 dpr，保证 1:1 物理像素
    return Math.max(2, Math.min(4, Math.round((window.devicePixelRatio || 2) * 2) / 2))
  })
  const [tool, setTool] = useState<Tool>('pan')
  const [color, setColor] = useState(COLORS[0])
  const [penWidth, setPenWidth] = useState(3)
  const [hlWidth, setHlWidth] = useState(20)
  const [eraserRadius, setEraserRadius] = useState(10)
  const [curPage, setCurPage] = useState(1)
  const [renderTick, setRenderTick] = useState(0)
  const [openMenu, setOpenMenu] = useState<'pen' | 'ai' | 'export' | null>(null)
  const [toolbarOpen, setToolbarOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('yuepi.pdftoolbar') !== '0'
    } catch {
      return true
    }
  })
  const [autoHidden, setAutoHidden] = useState(false)
  const [jumpPage, setJumpPage] = useState('')
  /** 滚动容器的当前 scrollTop（rAF 节流更新，驱动虚拟化与渲染） */
  const [viewTop, setViewTop] = useState(0)
  /** 滚动停止计数（停止时 +1，用于触发批注器窗口整理等"停止后"任务） */
  const [settleTick, setSettleTick] = useState(0)
  const toolbarRef = useRef<HTMLDivElement>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const pageElsRef = useRef<(HTMLDivElement | null)[]>([])
  const pdfCanvasRefs = useRef<(HTMLCanvasElement | null)[]>([])
  const annoCanvasRefs = useRef<(HTMLCanvasElement | null)[]>([])
  const annotatorsRef = useRef(new Map<number, Annotator>())
  const renderTasksRef = useRef(new Map<number, { cancel: () => void }>())
  const renderedQualityRef = useRef(new Map<number, number>())
  /** LRU 位图缓存：key=页索引，value=已渲染的离屏 canvas（插入序 = 使用序） */
  const bitmapCacheRef = useRef(new Map<number, HTMLCanvasElement>())
  const cacheQualityRef = useRef(new Map<number, number>())
  const cachePixelsRef = useRef(0)
  const renderGenRef = useRef(0)
  const curIdxRef = useRef(0)
  const zoomRef = useRef(1)
  const qualityRef = useRef(2)
  const curPageRef = useRef(1)
  const pdfRef = useRef<PDFDocumentProxy | null>(null)
  const metaRef = useRef(meta)
  const sizesRef = useRef<SizeOrNull[]>([])
  const estHRef = useRef(842)
  const viewTopRef = useRef(0)
  const pendingScrollRef = useRef<number | null>(null)
  const onPagesLoadedRef = useRef(onPagesLoaded)
  const onPageChangeRef = useRef(onPageChange)
  const renderErrShownRef = useRef(false)
  const scrollRafRef = useRef(0)
  const scheduleTimerRef = useRef(0)
  const selfHealTimerRef = useRef(0)
  /** 正在快速滚动：滚动中不调度渲染（避免滚动途中的渲染任务占满 worker，拖慢停止后的目标页） */
  const rollingRef = useRef(false)
  /** 滚动停止判定定时器（120ms 无滚动事件 = 停止） */
  const rollingTimerRef = useRef(0)
  /** 程序化滚动（恢复位置/跳页）：跳过 rolling 逻辑，立即按目标窗口渲染 */
  const suppressRollingRef = useRef(false)
  /** 滚动中限流渲染的时间戳（250ms 内最多渲染一次当前页低清，避免滑动中页面全空白） */
  const lastScrollRenderRef = useRef(0)
  const lastScrollTopRef = useRef(0)
  metaRef.current = meta
  onPagesLoadedRef.current = onPagesLoaded
  onPageChangeRef.current = onPageChange
  zoomRef.current = zoom
  qualityRef.current = quality
  curPageRef.current = curPage

  // ---------- 加载 PDF：尺寸"分批并行测量"，首批上屏后后台续测 ----------
  useEffect(() => {
    if (!meta.data) {
      onToast('文件数据缺失，请重新导入')
      return
    }
    let cancelled = false
    let doc: PDFDocumentProxy | null = null
    ;(async () => {
      try {
        doc = await pdfEngine.loadPDF(meta.data as ArrayBuffer)
        if (cancelled) {
          void doc.destroy()
          return
        }
        pdfRef.current = doc
        const total = doc.numPages
        const arr: SizeOrNull[] = new Array(total).fill(null)
        // 第一批并发测量 → 立即渲染上屏
        const firstNums = Array.from({ length: Math.min(FIRST_MEASURE, total) }, (_, i) => i + 1)
        const first = await pdfEngine.measurePageSizes(doc, firstNums, MEASURE_CONCURRENCY)
        for (const [i, s] of first) arr[i] = s
        if (cancelled) return
        sizesRef.current = arr
        pendingScrollRef.current = Math.min(Math.max(1, metaRef.current.lastPage ?? 1), total)
        setPdf(doc)
        setSizes([...arr])
        onPagesLoadedRef.current?.(total)
        // 剩余页"按需优先"测量：每次取离当前阅读页最近的 32 页并发测，
        // 快速滑到未测页时优先补测该页附近，避免停在"正在解析…"上等顺序批次
        const remaining = new Set<number>()
        for (let i = FIRST_MEASURE; i < total; i++) remaining.add(i)
        while (remaining.size) {
          if (cancelled) return
          // 滚动中暂停测量：避免并发 getPage 回调抢占主线程导致滑动卡顿（停止后自动继续）
          if (rollingRef.current) {
            await new Promise((r) => setTimeout(r, 60))
            continue
          }
          const cur = curIdxRef.current
          const sorted = [...remaining].sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur))
          const batch = sorted.slice(0, MEASURE_BATCH)
          for (const i of batch) remaining.delete(i)
          const nums = batch.map((i) => i + 1)
          const res = await pdfEngine.measurePageSizes(doc, nums, MEASURE_CONCURRENCY)
          if (cancelled) return
          for (const [i, s] of res) arr[i] = s
          sizesRef.current = arr
          setSizes([...arr])
        }
      } catch (e) {
        onToast('PDF 加载失败：' + (e instanceof Error ? e.message : String(e)))
      }
    })()
    return () => {
      cancelled = true
      if (doc) void doc.destroy()
      pdfRef.current = null
      sizesRef.current = []
      for (const t of renderTasksRef.current.values()) {
        try {
          t.cancel()
        } catch {
          /* ignore */
        }
      }
      renderTasksRef.current.clear()
      renderedQualityRef.current.clear()
      bitmapCacheRef.current.clear()
      cacheQualityRef.current.clear()
      cachePixelsRef.current = 0
      renderErrShownRef.current = false
      if (scheduleTimerRef.current) window.clearTimeout(scheduleTimerRef.current)
      if (selfHealTimerRef.current) window.clearTimeout(selfHealTimerRef.current)
      if (rollingTimerRef.current) window.clearTimeout(rollingTimerRef.current)
      rollingRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.id])

  // ---------- 派生布局：估算高度 / 顶部偏移 / 总高 / 可视页范围 ----------
  const estH = useMemo(() => {
    let sum = 0
    let n = 0
    for (const s of sizes) {
      if (s) {
        sum += s.height
        n++
      }
    }
    estHRef.current = n ? sum / n : 842
    return estHRef.current
  }, [sizes])

  const estW = useMemo(() => {
    for (const s of sizes) if (s) return s.width
    return 595
  }, [sizes])

  const offsets = useMemo(() => computeOffsets(sizes, estH, zoom), [sizes, estH, zoom])

  const totalHeight = useMemo(() => {
    const n = sizes.length
    if (!n) return 0
    const last = n - 1
    return offsets[last] + (sizes[last] ? sizes[last]!.height : estH) * zoom + PAGE_GAP + PAD_BOTTOM
  }, [offsets, sizes, estH, zoom])

  const visibleRange = useMemo(() => {
    const n = sizes.length
    if (!n) return { first: 0, last: -1 }
    const el = containerRef.current
    const vh = el ? el.clientHeight : 800
    const top = Math.max(0, viewTop)
    const bottom = top + vh
    let first = 0
    for (let i = 0; i < n; i++) {
      const h = (sizes[i] ? sizes[i]!.height : estH) * zoom
      if (offsets[i] + h < top) first = i + 1
      else break
    }
    let last = first
    for (let i = first; i < n; i++) {
      const h = (sizes[i] ? sizes[i]!.height : estH) * zoom
      if (offsets[i] <= bottom) last = i
      else break
    }
    return {
      first: Math.max(0, first - VIRTUAL_BUFFER),
      last: Math.min(n - 1, last + VIRTUAL_BUFFER)
    }
  }, [sizes, estH, zoom, viewTop, offsets])

  // ---------- 打开时恢复上次阅读位置（目标页测到后执行） ----------
  useEffect(() => {
    if (!pdf || !sizes.length) return
    const target = pendingScrollRef.current
    if (target == null) return
    const s = sizes[target - 1]
    if (!s) return // 该页还没测到，等下一批尺寸
    pendingScrollRef.current = null
    const top = Math.max(0, offsets[target - 1] - 8)
    const el = containerRef.current
    suppressRollingRef.current = true // 程序化滚动：不让 onScroll 进入"滚动中"状态
    if (el) el.scrollTop = top
    viewTopRef.current = top
    setViewTop(top)
    curPageRef.current = target
    setCurPage(target)
    curIdxRef.current = target - 1
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, sizes])

  // ---------- 当前页变化时上报（用于保存阅读位置） ----------
  useEffect(() => {
    onPageChangeRef.current?.(curPage)
  }, [curPage])

  // ---------- 位图缓存（LRU） ----------
  const touchCache = useCallback((i: number) => {
    const map = bitmapCacheRef.current
    const c = map.get(i)
    if (c) {
      map.delete(i)
      map.set(i, c)
    }
  }, [])

  const putCache = useCallback((i: number, canvas: HTMLCanvasElement, q: number) => {
    const map = bitmapCacheRef.current
    const prev = map.get(i)
    if (prev) {
      cachePixelsRef.current -= prev.width * prev.height
      map.delete(i)
    }
    cachePixelsRef.current += canvas.width * canvas.height
    map.set(i, canvas)
    cacheQualityRef.current.set(i, q)
    // 超预算淘汰最久未使用的页
    while (map.size > MAX_CACHE_PAGES || cachePixelsRef.current > MAX_CACHE_PIXELS) {
      const oldestKey = map.keys().next().value as number | undefined
      if (oldestKey === undefined) break
      const c = map.get(oldestKey)!
      cachePixelsRef.current -= c.width * c.height
      map.delete(oldestKey)
      cacheQualityRef.current.delete(oldestKey)
    }
  }, [])

  const drawBitmap = useCallback((src: HTMLCanvasElement, dst: HTMLCanvasElement) => {
    if (dst.width !== src.width || dst.height !== src.height) {
      dst.width = src.width
      dst.height = src.height
    }
    const ctx = dst.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, dst.width, dst.height)
    ctx.drawImage(src, 0, 0)
  }, [])

  /**
   * canvas 重新挂载（虚拟化回收后挂载的是全新 300×150 默认画布）：
   * 撤销该页的"已渲染"记录。否则 renderedQualityRef 里的旧记录会让 renderWindow
   * 误判"已渲染"而跳过 → 页面长时间空白（划走再回来才显示）。
   */
  const onCanvasMounted = useCallback((i: number) => {
    renderedQualityRef.current.delete(i)
  }, [])

  // ---------- 渲染窗口（单级）：当前页最高清 / 邻居低清 / 缓存复用 ----------
  const renderWindow = useCallback(
    (gen: number, lo: number, hi: number, mode: 'current' | 'scroll' | 'full', cur: number, sizesArr: SizeOrNull[]) => {
      const pending: { i: number; q: number }[] = []
      for (let i = lo; i <= hi; i++) {
        const canvas = pdfCanvasRefs.current[i]
        if (!canvas || renderTasksRef.current.has(i)) continue
        const s = sizesArr[i]
        if (!s) continue // 尺寸未测到，等后续批次
        // 当前页：scroll 模式（滚动中）用低清跟随，其余模式直接最高清（一次渲染到位，无二次升级）。
        // 质量 = 用户可调的精度档位 × zoom（物理/CSS 像素比保持恒定，缩放查看细节不模糊；上限 4 由画布 4096 兜底）
        const targetQ = i === cur
          ? (mode === 'scroll' ? PREVIEW_QUALITY : Math.min(4, Math.max(1.25, qualityRef.current * zoomRef.current)))
          : LOW_QUALITY
        // 画布为 1×1 说明是"虚拟化回收后重新挂载"或刚被重建清空：
        // 必须撤销"已渲染"记录，否则会被下面的 renderedQ >= targetQ 误判为已渲染而跳过 → 空白页
        if (canvas.width <= 1) renderedQualityRef.current.delete(i)
        const renderedQ = renderedQualityRef.current.get(i)
        if (renderedQ !== undefined && renderedQ >= targetQ) continue // 已有足够质量，跳过
        // 尝试直接复用位图缓存（翻回已缓存页零等待；若缓存质量不足则先恢复显示、再排队升级）
        if (renderedQ === undefined) {
          const cached = bitmapCacheRef.current.get(i)
          const cachedQ = cacheQualityRef.current.get(i)
          if (cached && cachedQ !== undefined) {
            drawBitmap(cached, canvas)
            renderedQualityRef.current.set(i, cachedQ)
            touchCache(i)
            if (cachedQ >= targetQ) continue
          }
        }
        pending.push({ i, q: targetQ })
      }
      // 离当前页越近越先渲染（当前页第一个，独占最先的渲染资源）
      pending.sort((a, b) => Math.abs(a.i - cur) - Math.abs(b.i - cur))
      let idx = 0
      const worker = async () => {
        while (idx < pending.length) {
          const { i, q } = pending[idx++]
          if (renderGenRef.current !== gen) return
          const canvas = pdfCanvasRefs.current[i]
          const s = sizesArr[i]
          if (!canvas || !s) continue
          let page: PDFPageProxy
          try {
            page = await pdfRef.current!.getPage(i + 1)
          } catch {
            continue
          }
          if (renderGenRef.current !== gen) return
          // 统一离屏渲染 → 结果同时入缓存 + 上屏（一次渲染，多处复用）
          const temp = document.createElement('canvas')
          let handle: ReturnType<typeof pdfEngine.renderPageToCanvasEx>
          try {
            handle = pdfEngine.renderPageToCanvasEx(page, temp, s.width, s.height, q)
          } catch {
            continue
          }
          renderTasksRef.current.set(i, { cancel: handle.cancel })
          try {
            await handle.done
            if (renderTasksRef.current.get(i)?.cancel !== handle.cancel) return
            putCache(i, temp, q)
            // 页仍在 DOM 且任务仍最新 → 一帧内上屏（无白屏闪现）
            const c = pdfCanvasRefs.current[i]
            if (c) drawBitmap(temp, c)
            renderedQualityRef.current.set(i, q)
            renderTasksRef.current.delete(i)
          } catch (e) {
            const isCurrent = renderTasksRef.current.get(i)?.cancel === handle.cancel
            if (!isCurrent) {
              // 非当前任务的迟到取消：canvas 可能已被新渲染占用，绝不能重置
              return
            }
            renderTasksRef.current.delete(i)
            const msg = e instanceof Error ? e.message : String(e)
            // "Rendering cancelled" 是缩放/快速滑动时主动取消，属正常现象，不提示
            if (/cancel/i.test(msg)) return
            if (!renderErrShownRef.current) {
              renderErrShownRef.current = true
              onToast('页面渲染失败：' + msg)
            }
          }
        }
      }
      for (let w = 0; w < CONCURRENCY; w++) void worker()
    },
    [drawBitmap, putCache, onToast]
  )

  /**
   * 渲染当前可视窗口：
   *  - 'current'：只渲染当前页（最高清，独占渲染资源，最快出结果）
   *  - 'scroll'：滚动中，当前页低清跟随（保持页面有内容）
   *  - 'full'：当前页最高清 + 邻居页低清（完整窗口）
   */
  const renderViewport = useCallback(
    (gen: number, mode: 'current' | 'scroll' | 'full') => {
      const sizesArr = sizesRef.current
      const n = sizesArr.length
      if (!pdfRef.current || !n) return
      const el = containerRef.current
      const vh = el ? el.clientHeight : 600
      const offs = computeOffsets(sizesArr, estHRef.current, zoomRef.current)
      const cur = pageIndexAt(offs, viewTopRef.current + vh / 2)
      curIdxRef.current = cur
      if (mode === 'current' || mode === 'scroll') {
        renderWindow(gen, cur, cur, mode, cur, sizesArr)
      } else {
        const lo = Math.max(0, cur - RENDER_WINDOW)
        const hi = Math.min(n - 1, cur + RENDER_WINDOW)
        renderWindow(gen, lo, hi, 'full', cur, sizesArr)
      }
    },
    [renderWindow]
  )

  /** 调度一轮渲染：先只渲染当前页最高清（独占资源）→ 250ms 后补邻居低清 → 1.2s 自愈兜底 */
  const scheduleWindow = useCallback(
    (gen: number) => {
      if (!pdfRef.current || !sizesRef.current.length) return
      if (scheduleTimerRef.current) window.clearTimeout(scheduleTimerRef.current)
      if (selfHealTimerRef.current) window.clearTimeout(selfHealTimerRef.current)
      renderViewport(gen, 'current')
      scheduleTimerRef.current = window.setTimeout(() => renderViewport(gen, 'full'), 250)
      selfHealTimerRef.current = window.setTimeout(() => renderViewport(gen, 'full'), 1200)
    },
    [renderViewport]
  )

  /** 重建渲染状态（文档切换 / 缩放变化） */
  const resetRenderState = useCallback(() => {
    for (const t of renderTasksRef.current.values()) {
      try {
        t.cancel()
      } catch {
        /* ignore */
      }
    }
    renderTasksRef.current.clear()
    renderedQualityRef.current.clear()
    bitmapCacheRef.current.clear()
    cacheQualityRef.current.clear()
    cachePixelsRef.current = 0
    for (let i = 0; i < pdfCanvasRefs.current.length; i++) {
      const c = pdfCanvasRefs.current[i]
      if (c) c.width = 1
    }
  }, [])

  /** 取消所有未完成的渲染任务（滚动停止后调用，让目标窗口的任务立即排上，不被滚动途中的旧任务阻塞） */
  const cancelAllTasks = useCallback(() => {
    for (const t of renderTasksRef.current.values()) {
      try {
        t.cancel()
      } catch {
        /* ignore */
      }
    }
    renderTasksRef.current.clear()
  }, [])

  // 文档加载或缩放变化 → 重建渲染状态并按新参数调度
  useEffect(() => {
    if (!pdf || !sizes.length) return
    const gen = ++renderGenRef.current
    resetRenderState()
    scheduleWindow(gen)
    return () => {
      renderGenRef.current++
      for (const t of renderTasksRef.current.values()) {
        try {
          t.cancel()
        } catch {
          /* ignore */
        }
      }
      renderTasksRef.current.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, renderTick])

  // 滚动位置变化 → 补渲染新窗口内缺失/需升级的页（不重建）
  // 滚动中跳过（由 onScroll 的停止定时器在停下后统一调度，避免滚动途中的任务阻塞目标页）
  useEffect(() => {
    if (!pdf || !sizes.length) return
    if (rollingRef.current) return
    scheduleWindow(renderGenRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewTop])

  // 尺寸批次测量完成 → 窗口内新测到的页补渲染（不重建）
  useEffect(() => {
    if (!pdf || !sizes.length) return
    if (rollingRef.current) return
    scheduleWindow(renderGenRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizes])

  // ---------- 创建批注器（窗口化：只为视口附近的页分配批注画布，离开即释放，内存关键） ----------
  // 滚动中跳过（每帧释放/补建 + 读库会拖慢滑动）；滚动停止（settleTick +1）后整理一次
  useEffect(() => {
    if (!pdf) return
    if (rollingRef.current) return
    const annotators = annotatorsRef.current
    const sizesArr = sizesRef.current
    const lo = Math.max(0, curPageRef.current - 1 - 2)
    const hi = Math.min(sizesArr.length - 1, curPageRef.current - 1 + 2)
    // 释放窗口外的批注器（每个批注画布按整页大小分配内存）
    for (const [i, a] of annotators) {
      if (i < lo || i > hi) {
        a.dispose()
        annotators.delete(i)
      }
    }
    // 补建窗口内缺失的批注器（增量：已有的不重建，保留撤销栈）
    for (let i = lo; i <= hi; i++) {
      if (annotators.has(i)) continue
      const canvas = annoCanvasRefs.current[i]
      const s = sizesArr[i]
      if (!canvas || !s) continue
      const ann = new Annotator({
        canvas,
        width: s.width,
        height: s.height,
        getZoom: () => zoomRef.current,
        quality: qualityRef.current, // 批注物理分辨率与 PDF 渲染精度对齐
        onCommit: (a) => {
          void db.putAnnotations(metaRef.current.id, i + 1, a)
        }
      })
      void (async () => {
        const saved = await db.getAnnotations(metaRef.current.id, i + 1)
        if (saved && annotators.get(i) === ann) ann.setAnnotations(saved)
      })()
      annotators.set(i, ann)
    }
    return () => {
      for (const a of annotators.values()) a.dispose()
      annotators.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, meta.id, curPage, sizes, settleTick])

  // ---------- 同步工具参数到批注器 ----------
  useEffect(() => {
    for (const a of annotatorsRef.current.values()) {
      a.tool = tool
      a.color = color
      a.penWidth = penWidth
      a.highlighterWidth = hlWidth
      a.eraserRadius = eraserRadius
      a.setQuality(quality)
    }
  }, [tool, color, penWidth, hlWidth, eraserRadius, sizes, quality])

  // ---------- 缩放变化时重渲染（防抖；跳过首次挂载，避免打开文档时重复渲染） ----------
  const zoomFirstRef = useRef(true)
  useEffect(() => {
    if (zoomFirstRef.current) {
      zoomFirstRef.current = false
      return
    }
    const t = setTimeout(() => setRenderTick((n) => n + 1), 250)
    return () => clearTimeout(t)
  }, [zoom])

  // ---------- 渲染精度变化时重渲染（防抖；跳过首次挂载） ----------
  const qualityFirstRef = useRef(true)
  useEffect(() => {
    if (qualityFirstRef.current) {
      qualityFirstRef.current = false
      return
    }
    const t = setTimeout(() => setRenderTick((n) => n + 1), 200)
    return () => clearTimeout(t)
  }, [quality])

  // ---------- 下拉菜单：点击外部关闭 ----------
  useEffect(() => {
    if (!openMenu) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement
      if (toolbarRef.current && !toolbarRef.current.contains(t)) setOpenMenu(null)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [openMenu])

  // ---------- 滚动：滚动中只更新可视区/当前页（不渲染）；停止 120ms 后取消旧任务并重排渲染 ----------
  const onScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    // 程序化滚动（恢复位置/跳页）：直接放行，让 [viewTop] effect 立即调度目标窗口渲染
    if (suppressRollingRef.current) {
      suppressRollingRef.current = false
      return
    }
    const st = el.scrollTop
    const delta = st - lastScrollTopRef.current
    lastScrollTopRef.current = st
    if (delta > 10) setAutoHidden(true)
    else if (delta < -10) setAutoHidden(false)
    // 进入滚动状态：滚动中不触发渲染（[viewTop] effect 会跳过），避免滚动途中的低清任务占满 worker；
    // 同时给容器加 scrolling 标记，CSS 里关闭大 canvas 的 box-shadow（阴影重绘是滑动卡顿来源之一）
    rollingRef.current = true
    el.classList.add('scrolling')
    if (rollingTimerRef.current) window.clearTimeout(rollingTimerRef.current)
    rollingTimerRef.current = window.setTimeout(() => {
      rollingTimerRef.current = 0
      rollingRef.current = false
      const c = containerRef.current
      if (c) c.classList.remove('scrolling')
      // 滚动停止：取消滚动途中遗留的任务，立即按目标窗口重排（低清先行 → 完成后升级高清）
      cancelAllTasks()
      scheduleWindow(renderGenRef.current)
      setSettleTick((t) => t + 1) // 触发批注器窗口整理
    }, 120)
    if (scrollRafRef.current) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0
      const el2 = containerRef.current
      if (!el2) return
      const st2 = el2.scrollTop
      viewTopRef.current = st2
      setViewTop(st2)
      // 限流：滚动中渲染当前页低清（250ms 内最多一次），保持页面有内容，又不拖慢滑动
      const now = Date.now()
      if (now - lastScrollRenderRef.current > 250) {
        lastScrollRenderRef.current = now
        renderViewport(renderGenRef.current, 'scroll')
      }
      const sizesArr = sizesRef.current
      if (sizesArr.length) {
        const vh = el2.clientHeight
        const offs = computeOffsets(sizesArr, estHRef.current, zoomRef.current)
        const cur = pageIndexAt(offs, st2 + vh / 2)
        curIdxRef.current = cur
        if (cur + 1 !== curPageRef.current) {
          curPageRef.current = cur + 1
          setCurPage(cur + 1)
        }
      }
    })
  }, [cancelAllTasks, scheduleWindow, renderViewport])

  // ---------- 导出 & 截图 ----------
  const composePage = useCallback(
    async (pageNum: number): Promise<{ dataUrl: string; pageNum: number } | null> => {
      const pdfCanvas = pdfCanvasRefs.current[pageNum - 1]
      const annoCanvas = annoCanvasRefs.current[pageNum - 1]
      let base: HTMLCanvasElement | null = null
      if (pdfCanvas && pdfCanvas.width > 1) {
        base = pdfCanvas
      } else if (pdfRef.current) {
        // 页面不在视口/未渲染：临时离屏高清渲染（截图/框选发 AI 可能用到远页）
        const s = sizesRef.current[pageNum - 1] ?? { width: 595, height: 842 }
        try {
          const page = await pdfRef.current.getPage(pageNum)
          const temp = document.createElement('canvas')
          await pdfEngine.renderPageToCanvasEx(page, temp, s.width, s.height, 2).done
          base = temp
        } catch {
          return null
        }
      }
      if (!base) return null
      const out = document.createElement('canvas')
      out.width = base.width
      out.height = base.height
      const ctx = out.getContext('2d')!
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, out.width, out.height)
      ctx.drawImage(base, 0, 0)
      if (annoCanvas && annoCanvas.width > 0) {
        // annoCanvas 物理宽度与 base 不同（dpr vs quality），按比例缩放合成
        const scale = out.width / annoCanvas.width
        ctx.drawImage(annoCanvas, 0, 0, annoCanvas.width * scale, annoCanvas.height * scale)
      }
      return { dataUrl: out.toDataURL('image/png'), pageNum }
    },
    []
  )

  const exportAnnotatedPDF = useCallback(async () => {
    try {
      const data = metaRef.current.data
      if (!data) {
        onToast('文件数据缺失，请重新导入')
        return
      }
      const anns = await db.getAnnotationsAll(metaRef.current.id)
      if (!anns.some((a) => a.strokes.length)) {
        onToast('当前文档还没有批注')
        return
      }
      const bytes = await flattenAnnotations(data, anns)
      downloadBlob(
        metaRef.current.name.replace(/\.pdf$/i, '') + '-批注版.pdf',
        new Blob([bytes as BlobPart], { type: 'application/pdf' })
      )
      onToast('已导出带批注的 PDF')
    } catch (e) {
      onToast('导出失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }, [onToast])

  const exportCurrentPNG = useCallback(async () => {
    try {
      const shot = await composePage(curPageRef.current)
      if (!shot) return
      downloadDataURL(`${metaRef.current.name.replace(/\.pdf$/i, '')}-p${shot.pageNum}.png`, shot.dataUrl)
      onToast('已导出当前页 PNG')
    } catch (e) {
      onToast('导出失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }, [composePage, onToast])

  useImperativeHandle(ref, () => ({
    getCurrentPageSnapshot: () => composePage(curPageRef.current),
    getCurrentPageText: () => (pdfRef.current ? pdfEngine.getPageText(pdfRef.current, curPageRef.current) : Promise.resolve('')),
    getFullText: () => (pdfRef.current ? pdfEngine.getAllText(pdfRef.current) : Promise.resolve('')),
    exportAnnotatedPDF,
    exportCurrentPNG,
    toggleToolbar
  }))

  const askImage = useCallback(async () => {
    const shot = await composePage(curPageRef.current)
    if (!shot) return
    onAskImage(shot.dataUrl, `PDF第${shot.pageNum}页截图`)
  }, [composePage, onAskImage])

  /** 框选区域 → 裁剪 → 发送给 AI */
  const cropAndAsk = useCallback(
    async (pageNum: number, r: RectSel) => {
      try {
        const full = await composePage(pageNum)
        if (!full) return
        const img = new Image()
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = () => reject(new Error('图片解码失败'))
          img.src = full.dataUrl
        })
        const cssW = sizesRef.current[pageNum - 1]?.width ?? 1
        const scale = img.naturalWidth / cssW
        const sw = Math.max(2, r.w * scale)
        const sh = Math.max(2, r.h * scale)
        const out = document.createElement('canvas')
        out.width = Math.round(sw)
        out.height = Math.round(sh)
        const ctx = out.getContext('2d')!
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, out.width, out.height)
        ctx.drawImage(img, r.x * scale, r.y * scale, sw, sh, 0, 0, out.width, out.height)
        onAskImage(out.toDataURL('image/png'), `PDF第${pageNum}页框选区域`)
      } catch (e) {
        onToast('框选截图失败：' + (e instanceof Error ? e.message : String(e)))
      }
    },
    [composePage, onAskImage, onToast]
  )

  const askText = useCallback(async () => {
    if (!pdfRef.current) return
    const text = await pdfEngine.getPageText(pdfRef.current, curPageRef.current)
    if (!text.trim()) {
      onToast('本页没有可提取的文字（可能是扫描版），请改用「截图发AI」')
      return
    }
    onAskText(text, `PDF第${curPageRef.current}页文字`)
  }, [onAskText, onToast])

  /** 框选回调（传给 PageItem，引用稳定以配合 memo） */
  const handleCrop = useCallback(
    (pageNum: number, r: RectSel) => {
      void cropAndAsk(pageNum, r)
      setTool('pen')
    },
    [cropAndAsk]
  )

  const askFullText = useCallback(async () => {
    if (!pdfRef.current) return
    const text = await pdfEngine.getAllText(pdfRef.current)
    if (!text.trim()) {
      onToast('没有可提取的文字（可能是扫描版），请改用「截图发AI」')
      return
    }
    onAskText(text, `《${metaRef.current.name}》全文`)
  }, [onAskText, onToast])

  const zoomIn = () => setZoom((z) => Math.min(4, +(z * 1.25).toFixed(2)))
  const zoomOut = () => setZoom((z) => Math.max(0.4, +(z / 1.25).toFixed(2)))

  /** 循环切换渲染精度档位（1.5 → 2 → 2.5 → 3 → 4 → 1.5…），档位越高越清晰、渲染越慢 */
  const cycleQuality = () => {
    setQuality((q) => {
      const levels = [1.5, 2, 2.5, 3, 4]
      const next = levels[(levels.indexOf(q) + 1) % levels.length] ?? 2
      try {
        localStorage.setItem('yuepi.quality', String(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }

  const toggleToolbar = () => {
    setAutoHidden(false)
    setToolbarOpen((v) => {
      const nv = !v
      try {
        localStorage.setItem('yuepi.pdftoolbar', nv ? '1' : '0')
      } catch {
        /* ignore */
      }
      return nv
    })
  }

  const goToPage = (n: number) => {
    const sizesArr = sizesRef.current
    if (!sizesArr.length) return
    const target = Math.min(Math.max(1, Math.floor(n) || 1), sizesArr.length)
    const offs = computeOffsets(sizesArr, estHRef.current, zoomRef.current)
    const top = Math.max(0, offs[target - 1] - 8)
    const el = containerRef.current
    suppressRollingRef.current = true // 程序化跳页：立即按目标窗口渲染，不走滚动停止延迟
    if (el) el.scrollTop = top
    viewTopRef.current = top
    setViewTop(top)
    curPageRef.current = target
    setCurPage(target)
    curIdxRef.current = target - 1
    setJumpPage('')
  }

  const drawActive = tool === 'pen' || tool === 'highlighter' || tool === 'eraser'
  const toolbarVisible = toolbarOpen && !autoHidden

  // 虚拟化：只挂载可视区 ± VIRTUAL_BUFFER 的页面
  const visiblePages: number[] = []
  for (let i = visibleRange.first; i <= visibleRange.last; i++) visiblePages.push(i)

  return (
    <div className="pdf-view">
      {toolbarVisible ? (
      <div className="pdf-toolbar" ref={toolbarRef}>
        <div className="tb-group">
          <button className={tool === 'pan' ? 'tb-btn active' : 'tb-btn'} onClick={() => setTool('pan')} title="阅读/滚动模式（退出书写）">👆</button>
        </div>

        {/* 画笔组：点击展开 画笔/荧光笔/橡皮/颜色/粗细/撤销重做；按钮随当前工具显示对应名称与图标 */}
        <div className="tb-group tb-dropdown">
          <button
            className={drawActive ? 'tb-btn active' : 'tb-btn'}
            onClick={() => setOpenMenu(openMenu === 'pen' ? null : 'pen')}
            title="书写工具（画笔/荧光笔/橡皮）"
          >
            {tool === 'highlighter' ? '🖍️ 荧光笔 ▾' : tool === 'eraser' ? '🧽 橡皮 ▾' : '✏️ 画笔 ▾'}
          </button>
          {openMenu === 'pen' && (
            <div className="tb-menu">
              <div className="tb-menu-row">
                <button className={tool === 'pen' ? 'tb-btn active' : 'tb-btn'} onClick={() => setTool(tool === 'pen' ? 'pan' : 'pen')}>✏️ 画笔</button>
                <button className={tool === 'highlighter' ? 'tb-btn active' : 'tb-btn'} onClick={() => setTool(tool === 'highlighter' ? 'pan' : 'highlighter')}>🖍️ 荧光笔</button>
                <button className={tool === 'eraser' ? 'tb-btn active' : 'tb-btn'} onClick={() => setTool(tool === 'eraser' ? 'pan' : 'eraser')}>🧽 橡皮</button>
              </div>
              <div className="tb-menu-row colors">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    className={color === c ? 'color-dot active' : 'color-dot'}
                    style={{ background: c }}
                    onClick={() => setColor(c)}
                    title={c}
                  />
                ))}
              </div>
              <div className="tb-menu-row">
                <label className="tb-range">
                  粗细
                  <input
                    type="range" min={tool === 'highlighter' ? 10 : 1}
                    max={tool === 'highlighter' ? 40 : 10} step={1}
                    value={tool === 'highlighter' ? hlWidth : penWidth}
                    onChange={(e) => (tool === 'highlighter' ? setHlWidth(+e.target.value) : setPenWidth(+e.target.value))}
                  />
                </label>
                <button className="tb-btn" onClick={() => annotatorsRef.current.get(curPageRef.current - 1)?.undo()} title="撤销">↩️</button>
                <button className="tb-btn" onClick={() => annotatorsRef.current.get(curPageRef.current - 1)?.redo()} title="重做">↪️</button>
              </div>
            </div>
          )}
        </div>

        <div className="tb-group">
          <button
            className={tool === 'select' ? 'tb-btn act active' : 'tb-btn act'}
            onClick={() => setTool(tool === 'select' ? 'pan' : 'select')}
            title="拖拽框选页面区域，松手即发送给 AI"
          >
            ✂️ 框选发AI
          </button>
          {tool === 'select' && <span className="tb-hint">拖拽框选，松手发AI</span>}
          {onToBoard && (
            <button className="tb-btn act" onClick={onToBoard} title="把当前页截图存入新白板">📋 到白板</button>
          )}
          {onToggleBoard && (
            <button
              className={boardOverlayOpen ? 'tb-btn act active' : 'tb-btn act'}
              onClick={onToggleBoard}
              title="在 PDF 上叠加显示/隐藏白板"
            >
              🧻 白板
            </button>
          )}
        </div>

        {/* AI 发送组 */}
        <div className="tb-group tb-dropdown">
          <button className="tb-btn act" onClick={() => setOpenMenu(openMenu === 'ai' ? null : 'ai')} title="把当前页内容发给 AI">🤖 发AI ▾</button>
          {openMenu === 'ai' && (
            <div className="tb-menu">
              <button className="tb-menu-btn" onClick={() => { setOpenMenu(null); void askImage() }}>🖼️ 当前页截图</button>
              <button className="tb-menu-btn" onClick={() => { setOpenMenu(null); void askText() }}>📄 本页文字</button>
              <button className="tb-menu-btn" onClick={() => { setOpenMenu(null); void askFullText() }}>📚 全文文字</button>
            </div>
          )}
        </div>

        {/* 导出组 */}
        <div className="tb-group tb-dropdown">
          <button className="tb-btn" onClick={() => setOpenMenu(openMenu === 'export' ? null : 'export')} title="导出">💾 导出 ▾</button>
          {openMenu === 'export' && (
            <div className="tb-menu">
              <button className="tb-menu-btn" onClick={() => { setOpenMenu(null); void exportAnnotatedPDF() }}>📄 导出带批注 PDF</button>
              <button className="tb-menu-btn" onClick={() => { setOpenMenu(null); void exportCurrentPNG() }}>🖼️ 导出当前页 PNG</button>
            </div>
          )}
        </div>

        <div className="tb-group">
          <button className="tb-btn" onClick={zoomOut} title="缩小">−</button>
          <span className="zoom-label">{Math.round(zoom * 100)}%</span>
          <button className="tb-btn" onClick={zoomIn} title="放大">＋</button>
          <button className="tb-btn" onClick={() => setZoom(1)} title="适应">1:1</button>
        </div>

        <div className="tb-group">
          {/* 渲染精度：越高越清晰、渲染越慢；低档位可明显提速（尤其图片密集的 PDF） */}
          <button className="tb-btn" onClick={cycleQuality} title="渲染精度（越高越清晰、越慢）：点击切换">
            💠 {quality.toFixed(2).replace(/\.?0+$/, '')}x
          </button>
        </div>

        <span className="page-indicator">
          第 {curPage} / {sizes.length || '?'} 页
          <input
            className="page-jump"
            type="number" min={1} max={sizes.length || 1}
            value={jumpPage} placeholder="跳页"
            onChange={(e) => setJumpPage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') goToPage(+jumpPage)
            }}
          />
          <button className="tb-btn" onClick={() => goToPage(+jumpPage)} title="跳转到指定页">GO</button>
          <button className="tb-btn" onClick={toggleToolbar} title="收起工具栏">▾ 收起</button>
        </span>
      </div>
      ) : (
        <div className="pdf-toolbar-mini">
          <button className="tb-btn" onClick={toggleToolbar} title="展开工具栏">✏️ ▴ 工具栏</button>
          <span className="page-indicator">第 {curPage} / {sizes.length || '?'} 页</span>
        </div>
      )}
      <div className="pdf-scroll" ref={containerRef} onScroll={onScroll}>
        <div className="pdf-pages v" style={{ height: totalHeight }}>
          {visiblePages.map((i) => (
            <PageItem
              key={i}
              i={i}
              size={sizes[i]}
              estW={estW}
              estH={estH}
              zoom={zoom}
              top={offsets[i]}
              drawActive={drawActive}
              tool={tool}
              onCrop={handleCrop}
              onCanvasMounted={onCanvasMounted}
              pageEls={pageElsRef.current}
              pdfCanvases={pdfCanvasRefs.current}
              annoCanvases={annoCanvasRefs.current}
            />
          ))}
        </div>
      </div>
    </div>
  )
})

export default PdfViewer
