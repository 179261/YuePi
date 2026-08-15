// ============ PDF 阅读 + 手写批注视图 ============
import {
  forwardRef,
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

const PdfViewer = forwardRef<PdfViewerHandle, Props>(function PdfViewer(
  { meta, onToast, onAskImage, onAskText, onToBoard, boardOverlayOpen, onToggleBoard, onPagesLoaded, onPageChange },
  ref
) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [sizes, setSizes] = useState<{ width: number; height: number }[]>([])
  const [zoom, setZoom] = useState(1)
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
  const toolbarRef = useRef<HTMLDivElement>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const pageElsRef = useRef<(HTMLDivElement | null)[]>([])
  const pdfCanvasRefs = useRef<(HTMLCanvasElement | null)[]>([])
  const annoCanvasRefs = useRef<(HTMLCanvasElement | null)[]>([])
  const annotatorsRef = useRef(new Map<number, Annotator>())
  const renderTasksRef = useRef(new Map<number, { cancel: () => void }>())
  const renderedRef = useRef(new Set<number>())
  const renderedQualityRef = useRef(new Map<number, number>())
  const renderGenRef = useRef(0)
  const tickRef = useRef(0)
  const zoomRef = useRef(1)
  const curPageRef = useRef(1)
  const pdfRef = useRef<PDFDocumentProxy | null>(null)
  const metaRef = useRef(meta)
  const onPagesLoadedRef = useRef(onPagesLoaded)
  const onPageChangeRef = useRef(onPageChange)
  const renderErrShownRef = useRef(false)
  const settleTimerRef = useRef<number>(0)
  metaRef.current = meta
  onPagesLoadedRef.current = onPagesLoaded
  onPageChangeRef.current = onPageChange
  zoomRef.current = zoom
  curPageRef.current = curPage

  // ---------- 加载 PDF ----------
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
        const arr: { width: number; height: number }[] = []
        for (let i = 1; i <= doc.numPages; i++) {
          const p = await doc.getPage(i)
          arr.push(pdfEngine.pageSize1(p))
        }
        if (!cancelled) {
          setPdf(doc)
          setSizes(arr)
          setCurPage(1)
          curPageRef.current = 1
          onPagesLoadedRef.current?.(doc.numPages)
        }
      } catch (e) {
        onToast('PDF 加载失败：' + (e instanceof Error ? e.message : String(e)))
      }
    })()
    return () => {
      cancelled = true
      if (doc) void doc.destroy()
      pdfRef.current = null
      renderedRef.current.clear()
      renderTasksRef.current.clear()
      renderErrShownRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.id])

  // ---------- 打开时恢复上次阅读位置 ----------
  useEffect(() => {
    if (!sizes.length) return
    const target = Math.min(Math.max(1, metaRef.current.lastPage ?? 1), sizes.length)
    setCurPage(target)
    curPageRef.current = target
    requestAnimationFrame(() => {
      const el = containerRef.current
      const pageEl = pageElsRef.current[target - 1]
      if (el && pageEl) el.scrollTop = Math.max(0, pageEl.offsetTop - 12)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizes])

  // ---------- 当前页变化时上报（用于保存阅读位置） ----------
  useEffect(() => {
    onPageChangeRef.current?.(curPage)
  }, [curPage])

  // ---------- 渲染：窗口化 + 可取消 + 并发限流；当前页高清、周边页低清 ----------
  const RENDER_WINDOW = 2 // 当前页前后各渲染的页数
  const CONCURRENCY = 2 // 同时渲染的页数上限（手机/平板更省）
  const LOW_QUALITY = 1.5
  const sharpQuality = () => Math.min(2, Math.max(1.5, window.devicePixelRatio || 1.5))

  /**
   * 渲染窗口内缺失/需升清的页。
   * currentOnly=true 时只处理当前页（翻页时立即渲染当前页，邻居页等滚动停下再补）。
   * 高清升级使用离屏画布，完成后一帧内替换可见画布，避免"清空→重画"期间的白屏。
   */
  const renderWindow = useCallback(
    (gen: number, lo: number, hi: number, currentOnly = false) => {
      if (!pdf || !sizes.length) return
      const cur = curPageRef.current - 1
      const pending: { i: number; q: number; upgrade: boolean }[] = []
      for (let i = lo; i <= hi; i++) {
        if (currentOnly && i !== cur) continue
        const canvas = pdfCanvasRefs.current[i]
        if (!canvas || renderTasksRef.current.has(i)) continue
        const q = i === cur ? sharpQuality() : LOW_QUALITY
        const renderedQ = renderedRef.current.has(i) ? renderedQualityRef.current.get(i) : undefined
        if (renderedQ === q) continue
        const upgrade = renderedQ !== undefined && q > renderedQ
        if (!upgrade && renderedRef.current.has(i)) {
          // 需要降清（例如窗口边缘的页离开当前页）：直接按新分辨率重渲即可
          renderedRef.current.delete(i)
          renderedQualityRef.current.delete(i)
          if (canvas.width > 1) canvas.width = 1
        }
        pending.push({ i, q, upgrade })
      }
      // 离当前页越近越先渲染，首屏更快
      pending.sort((a, b) => Math.abs(a.i - cur) - Math.abs(b.i - cur))
      let idx = 0
      const worker = async () => {
        while (idx < pending.length) {
          const { i, q, upgrade } = pending[idx++]
          if (renderGenRef.current !== gen) return
          const canvas = pdfCanvasRefs.current[i]
          if (!canvas) continue
          let page: PDFPageProxy
          try {
            page = await pdf.getPage(i + 1)
          } catch {
            continue
          }
          if (renderGenRef.current !== gen) return
          // 高清升级 → 先渲染到离屏画布，再一帧内替换，避免白屏
          const target = upgrade ? document.createElement('canvas') : canvas
          let handle: ReturnType<typeof pdfEngine.renderPageToCanvasEx>
          try {
            handle = pdfEngine.renderPageToCanvasEx(page, target, sizes[i].width, sizes[i].height, q)
          } catch {
            continue
          }
          renderTasksRef.current.set(i, { cancel: handle.cancel })
          try {
            await handle.done
            // 只有"仍是最新任务"才标记完成，防止旧任务的迟到回调污染新渲染
            if (renderTasksRef.current.get(i)?.cancel === handle.cancel) {
              if (upgrade) {
                // 同步替换可见画布（同一帧内完成，无白屏闪现）
                canvas.width = target.width
                canvas.height = target.height
                const ctx = canvas.getContext('2d')!
                ctx.fillStyle = '#ffffff'
                ctx.fillRect(0, 0, canvas.width, canvas.height)
                ctx.drawImage(target, 0, 0)
              }
              renderedRef.current.add(i)
              renderedQualityRef.current.set(i, q)
              renderTasksRef.current.delete(i)
            }
          } catch (e) {
            const isCurrent = renderTasksRef.current.get(i)?.cancel === handle.cancel
            if (!isCurrent) {
              // 非当前任务的迟到取消：canvas 可能已被新渲染占用，绝不能重置（否则出现黑页）
              return
            }
            renderTasksRef.current.delete(i)
            // 取消或失败：非升级路径才重置画布（升级用的是离屏画布，可见画布未被碰过）
            if (!upgrade && canvas.width > 1) canvas.width = 1
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
    [pdf, sizes, onToast]
  )

  // 效果一：文档或缩放变化 → 重建（取消旧任务、清空记录、按新参数渲染窗口）
  useEffect(() => {
    if (!pdf || !sizes.length) return
    const gen = ++renderGenRef.current
    tickRef.current = renderTick
    renderedRef.current.clear()
    renderedQualityRef.current.clear()
    for (const t of renderTasksRef.current.values()) {
      try {
        t.cancel()
      } catch {
        /* ignore */
      }
    }
    renderTasksRef.current.clear()
    for (let i = 0; i < sizes.length; i++) {
      const c = pdfCanvasRefs.current[i]
      if (c) c.width = 1
    }
    const lo = Math.max(0, curPageRef.current - 1 - RENDER_WINDOW)
    const hi = Math.min(sizes.length - 1, curPageRef.current - 1 + RENDER_WINDOW)
    renderWindow(gen, lo, hi)
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
  }, [pdf, sizes, renderTick])

  // 效果二：滚动 → 只补渲染新窗口内缺失的页、释放窗口外资源；渲染防抖避免快速滑动调度风暴
  useEffect(() => {
    if (!pdf || !sizes.length) return
    const gen = renderGenRef.current
    const lo = Math.max(0, curPage - 1 - RENDER_WINDOW)
    const hi = Math.min(sizes.length - 1, curPage - 1 + RENDER_WINDOW)
    // 取消窗口外任务
    for (const [i, t] of renderTasksRef.current) {
      if (i < lo || i > hi) {
        try {
          t.cancel()
        } catch {
          /* ignore */
        }
        renderTasksRef.current.delete(i)
      }
    }
    // 释放窗口外位图（含边缘外一页），滚动回来时重新渲染
    for (let i = 0; i < sizes.length; i++) {
      if (i < lo - 1 || i > hi + 1) {
        const c = pdfCanvasRefs.current[i]
        if (c && c.width > 1) c.width = 1
        renderedRef.current.delete(i)
        renderedQualityRef.current.delete(i)
      }
    }
    // 当前页立即渲染（翻页不白屏）；邻居页防抖 80ms（滚动停下再补，减少卡顿）
    renderWindow(gen, lo, hi, true)
    const t = window.setTimeout(() => {
      renderWindow(gen, lo, hi)
      // 自愈：稍后再查一次窗口，兜住偶发的"迟到取消误清画布"等黑页情况
      const t2 = window.setTimeout(() => renderWindow(gen, lo, hi), 500)
      settleTimerRef.current = t2
    }, 80)
    return () => {
      window.clearTimeout(t)
      if (settleTimerRef.current) {
        window.clearTimeout(settleTimerRef.current)
        settleTimerRef.current = 0
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curPage])

  // ---------- 创建批注器（窗口化：只为视口附近的页分配批注画布，离开即释放，内存关键） ----------
  useEffect(() => {
    if (!pdf || !sizes.length) return
    const annotators = annotatorsRef.current
    const lo = Math.max(0, curPageRef.current - 1 - 2)
    const hi = Math.min(sizes.length - 1, curPageRef.current - 1 + 2)
    let disposed = false
    const createFor = async (i: number) => {
      const canvas = annoCanvasRefs.current[i]
      if (!canvas || disposed) return
      const ann = new Annotator({
        canvas,
        width: sizes[i].width,
        height: sizes[i].height,
        getZoom: () => zoomRef.current,
        onCommit: (a) => {
          void db.putAnnotations(metaRef.current.id, i + 1, a)
        }
      })
      const saved = await db.getAnnotations(metaRef.current.id, i + 1)
      if (saved) ann.setAnnotations(saved)
      if (disposed) {
        ann.dispose()
        return
      }
      annotators.set(i, ann)
    }
    // 补建窗口内缺失的批注器
    for (let i = lo; i <= hi; i++) {
      if (!annotators.has(i)) void createFor(i)
    }
    // 释放窗口外的批注器（每个批注画布按整页大小分配内存）
    for (const [i, a] of annotators) {
      if (i < lo || i > hi) {
        a.dispose()
        annotators.delete(i)
      }
    }
    return () => {
      disposed = true
      for (const a of annotators.values()) a.dispose()
      annotators.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, meta.id, sizes, curPage])

  // ---------- 同步工具参数到批注器 ----------
  useEffect(() => {
    for (const a of annotatorsRef.current.values()) {
      a.tool = tool
      a.color = color
      a.penWidth = penWidth
      a.highlighterWidth = hlWidth
      a.eraserRadius = eraserRadius
    }
  }, [tool, color, penWidth, hlWidth, eraserRadius, sizes])

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

  // ---------- 当前页跟踪 + 滚动自动隐藏工具栏 ----------
  const lastScrollTopRef = useRef(0)
  const onScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const st = el.scrollTop
    const delta = st - lastScrollTopRef.current
    lastScrollTopRef.current = st
    if (delta > 10) setAutoHidden(true)
    else if (delta < -10) setAutoHidden(false)
    requestAnimationFrame(() => {
      const mid = el.scrollTop + el.clientHeight / 2
      for (let i = 0; i < pageElsRef.current.length; i++) {
        const p = pageElsRef.current[i]
        if (!p) continue
        if (p.offsetTop <= mid && mid < p.offsetTop + p.offsetHeight) {
          if (curPageRef.current !== i + 1) setCurPage(i + 1)
          break
        }
      }
    })
  }, [])

  // ---------- 导出 & 截图 ----------
  const composePage = useCallback(
    async (pageNum: number): Promise<{ dataUrl: string; pageNum: number } | null> => {
      const pdfCanvas = pdfCanvasRefs.current[pageNum - 1]
      const annoCanvas = annoCanvasRefs.current[pageNum - 1]
      if (!pdfCanvas) return null
      const out = document.createElement('canvas')
      out.width = pdfCanvas.width
      out.height = pdfCanvas.height
      const ctx = out.getContext('2d')!
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, out.width, out.height)
      ctx.drawImage(pdfCanvas, 0, 0)
      if (annoCanvas && annoCanvas.width > 0) {
        // annoCanvas 物理宽度与 pdfCanvas 不同（dpr vs quality），按比例缩放合成
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
        const cssW = sizes[pageNum - 1]?.width ?? 1
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
    [composePage, sizes, onAskImage, onToast]
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
    if (!sizes.length) return
    const target = Math.min(Math.max(1, Math.floor(n) || 1), sizes.length)
    const el = containerRef.current
    const pageEl = pageElsRef.current[target - 1]
    if (el && pageEl) el.scrollTop = Math.max(0, pageEl.offsetTop - 12)
    setCurPage(target)
    curPageRef.current = target
    setJumpPage('')
  }

  const drawActive = tool === 'pen' || tool === 'highlighter' || tool === 'eraser'
  const toolbarVisible = toolbarOpen && !autoHidden

  return (
    <div className="pdf-view">
      {toolbarVisible ? (
      <div className="pdf-toolbar" ref={toolbarRef}>
        <div className="tb-group">
          <button className={tool === 'pan' ? 'tb-btn active' : 'tb-btn'} onClick={() => setTool('pan')} title="阅读/滚动模式（退出书写）">👆</button>
        </div>

        {/* 画笔组：点击展开 画笔/荧光笔/橡皮/颜色/粗细/撤销重做 */}
        <div className="tb-group tb-dropdown">
          <button
            className={drawActive ? 'tb-btn active' : 'tb-btn'}
            onClick={() => setOpenMenu(openMenu === 'pen' ? null : 'pen')}
            title="书写工具（画笔/荧光笔/橡皮）"
          >
            ✏️ 画笔 ▾
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
        <div className="pdf-pages" style={{ padding: 12 }}>
          {sizes.map((s, i) => (
            <div
              key={i}
              ref={(el) => { pageElsRef.current[i] = el }}
              className="page-wrap"
              style={{
                width: s.width * zoom,
                height: s.height * zoom,
                marginBottom: 14
              }}
            >
              <div
                className="page-scale"
                style={{ transform: `scale(${zoom})`, transformOrigin: 'top left', width: s.width, height: s.height }}
              >
                <canvas ref={(el) => { pdfCanvasRefs.current[i] = el }} className="pdf-canvas" />
                <canvas
                  ref={(el) => { annoCanvasRefs.current[i] = el }}
                  className={drawActive ? 'anno-canvas draw' : 'anno-canvas'}
                />
                <SelectOverlay
                  active={tool === 'select'}
                  zoom={zoom}
                  onSelect={(r) => {
                    void cropAndAsk(i + 1, r)
                    setTool('pen')
                  }}
                  onCancel={() => {}}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
})

export default PdfViewer
