// ============ PDF 渲染引擎（pdf.js v3.11，经典 Worker，兼容旧内核如鸿蒙 4.2 平板浏览器） ============
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.js?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorker

/** 渲染清晰度倍率（canvas 物理分辨率相对 CSS 尺寸） */
export const BASE_QUALITY = 1.5

/** 单页画布最大边长（px），超大页（CAD/长图等）强制降采样，避免画布过大导致崩溃 */
export const MAX_CANVAS_DIM = 4096

export async function loadPDF(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  // pdf.js 会通过 postMessage 转移（置空）传入的 ArrayBuffer，这里传副本保留原数据；
  // isEvalSupported=false 提高兼容性；cMapUrl 提供中文等非内嵌字体的字符映射
  return pdfjsLib.getDocument({
    data: data.slice(0),
    isEvalSupported: false,
    cMapUrl: 'cmaps/',
    cMapPacked: true
  }).promise
}

/** 页面在 scale=1 时的尺寸（单位：PDF 点 ≈ CSS px，可直接映射批注坐标） */
export function pageSize1(page: PDFPageProxy): { width: number; height: number } {
  const vp = page.getViewport({ scale: 1 })
  return { width: vp.width, height: vp.height }
}

/**
 * 并行测量一批页面的尺寸。
 * getPage(i) 只解析页字典（不渲染），很快，但串行 await 几百次在平板上仍要数秒。
 * 这里用固定并发数批量并行，显著缩短打开/滚动到未测页的等待。
 * @param pageNums 1-based 页码数组
 */
export async function measurePageSizes(
  pdf: PDFDocumentProxy,
  pageNums: number[],
  concurrency = 16
): Promise<Map<number, { width: number; height: number }>> {
  const out = new Map<number, { width: number; height: number }>()
  if (!pageNums.length) return out
  let idx = 0
  const n = Math.min(concurrency, pageNums.length)
  const workers = Array.from({ length: n }, async () => {
    while (idx < pageNums.length) {
      const pn = pageNums[idx++]
      try {
        const page = await pdf.getPage(pn)
        out.set(pn - 1, pageSize1(page))
      } catch {
        /* 个别页解析失败跳过，不阻塞整批 */
      }
    }
  })
  await Promise.all(workers)
  return out
}

export interface RenderResult {
  page: PDFPageProxy
  width: number // CSS px
  height: number
}

export interface RenderHandle {
  cancel: () => void
  done: Promise<RenderResult>
}

/**
 * 将某页渲染到 canvas，返回可取消的句柄（缩放/滚动时需取消旧任务，避免并发渲染报错）。
 * quality: canvas 物理分辨率相对 CSS 尺寸的倍率。
 */
export function renderPageToCanvasEx(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  quality: number
): RenderHandle {
  const vp1 = page.getViewport({ scale: 1 })
  // 按 CSS 尺寸适配（一般 vp1 就是页面原始尺寸），并限制画布最大边长
  const fit = Math.min(cssWidth / vp1.width, cssHeight / vp1.height)
  let scale = fit * quality
  const maxDim = Math.max(vp1.width, vp1.height)
  if (maxDim * scale > MAX_CANVAS_DIM) scale = MAX_CANVAS_DIM / maxDim
  const vp = page.getViewport({ scale })
  canvas.width = Math.max(1, Math.floor(vp.width))
  canvas.height = Math.max(1, Math.floor(vp.height))
  // 关键：显式设置 CSS 尺寸，否则画布按物理分辨率显示（会放大溢出）
  canvas.style.width = `${cssWidth}px`
  canvas.style.height = `${cssHeight}px`
  const ctx = canvas.getContext('2d', { alpha: false })!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const task = page.render({ canvasContext: ctx, viewport: vp })
  return {
    cancel: () => task.cancel(),
    done: task.promise.then(
      () => ({ page, width: vp1.width, height: vp1.height }),
      (err: unknown) => {
        throw err
      }
    )
  }
}

/** 提取单页文本 */
export async function getPageText(pdf: PDFDocumentProxy, pageNum: number): Promise<string> {
  const page = await pdf.getPage(pageNum)
  const tc = await page.getTextContent()
  return tc.items
    .map((it) => ('str' in it ? (it.str as string) : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 提取全文文本（用于发给 DeepSeek 理解文档） */
export async function getAllText(pdf: PDFDocumentProxy, maxPages = 200): Promise<string> {
  const n = Math.min(pdf.numPages, maxPages)
  const parts: string[] = []
  for (let i = 1; i <= n; i++) {
    parts.push(`【第 ${i} 页】\n${await getPageText(pdf, i)}`)
  }
  return parts.join('\n\n')
}
