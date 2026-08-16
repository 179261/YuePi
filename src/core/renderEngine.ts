// ============ PDF 渲染引擎抽象：APK（Capacitor + 原生 Pdfium）与网页（pdf.js）双引擎 ============
// APK 环境（Android WebView）用 pdf.js 渲染又慢又不稳定（canvas 资源耗尽 → 只能渲染前几页），
// 因此 APK 里通过自定义 Capacitor 插件走原生 Pdfium 渲染（页面 → 位图 → 网页显示），
// 浏览器/网页版仍用 pdf.js。PdfViewer 只依赖本文件的统一接口，不关心底层实现。
import * as pdfEngine from './pdfEngine'
import type { PDFDocumentProxy } from 'pdfjs-dist'

export interface EnginePageSize {
  width: number
  height: number
}

export interface RenderEngine {
  /**
   * 打开 PDF，返回页数与全部页面尺寸（尺寸一次到位，批注坐标直接映射）。
   * APK 大文件：nativePath 存在时原生直接读文件（不走 base64/IndexedDB），data 可为空。
   */
  open(data: ArrayBuffer | null, name: string, nativePath?: string): Promise<{ pageCount: number; pages: EnginePageSize[] }>
  /** 渲染一页：结果画入 canvas（canvas 物理尺寸 = cssWidth*scale，CSS 尺寸 = cssWidth） */
  renderPage(pageIndex: number, canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number, scale: number): Promise<void>
  getPageText(pageNum: number): Promise<string>
  getAllText(maxPages?: number): Promise<string>
  /** 原始 PDF 字节（导出带批注 PDF 用）；不可用返回 null */
  getBytes(): Promise<ArrayBuffer | null>
  close(): void
  isNative(): boolean
}

// ---------- 工具 ----------
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(binary)
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

// ---------- 原生引擎（APK：Capacitor 插件 → Pdfium 渲染；文本用 pdf.js） ----------
class NativeEngine implements RenderEngine {
  private plugin: any
  private pdfData: ArrayBuffer | null = null
  /** 文本提取：PdfiumAndroid 1.9.0 无文本 API，用 pdf.js（JS 侧已有原始字节，仅解析文本不渲染） */
  private textEngine: PdfJsEngine | null = null

  constructor(plugin: any) {
    this.plugin = plugin
  }

  isNative() {
    return true
  }

  async open(data: ArrayBuffer | null, name: string, nativePath?: string) {
    if (nativePath) {
      // 大文件：原生直接读文件（不经 JS 数据传输）
      const info = await this.plugin.openByPath({ path: nativePath })
      const pages: EnginePageSize[] = []
      for (const p of info.pages) {
        pages.push({
          width: p.width > 0 ? p.width : 595,
          height: p.height > 0 ? p.height : 842
        })
      }
      return { pageCount: info.pageCount, pages }
    }
    if (!data) throw new Error('缺少 PDF 数据')
    this.pdfData = data
    // base64 传给原生（中小文件可用；大文件请走 pickFile/openByPath）
    const b64 = arrayBufferToBase64(data)
    await this.plugin.open({ data: b64 })
    const info = await this.plugin.getInfo({})
    const pages: EnginePageSize[] = []
    for (const p of info.pages) {
      // 防御：尺寸为 0（异常）时用 A4 默认值兜底，避免页面容器塌陷
      pages.push({
        width: p.width > 0 ? p.width : 595,
        height: p.height > 0 ? p.height : 842
      })
    }
    return { pageCount: info.pageCount, pages }
  }

  async renderPage(pageIndex: number, canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number, scale: number) {
    const r = await this.plugin.renderPage({ page: pageIndex, scale })
    canvas.width = r.width
    canvas.height = r.height
    canvas.style.width = `${cssWidth}px`
    canvas.style.height = `${cssHeight}px`
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('页面图片解码失败'))
      img.src = r.data
    })
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0)
  }

  private async ensureTextEngine() {
    if (!this.textEngine) {
      if (!this.pdfData) throw new Error('文档未打开')
      this.textEngine = new PdfJsEngine()
      await this.textEngine.open(this.pdfData)
    }
    return this.textEngine
  }

  async getPageText(pageNum: number) {
    try {
      const te = await this.ensureTextEngine()
      return await te.getPageText(pageNum)
    } catch {
      return ''
    }
  }

  async getAllText(maxPages = 200) {
    try {
      const te = await this.ensureTextEngine()
      return await te.getAllText(maxPages)
    } catch {
      return ''
    }
  }

  async getBytes() {
    const r = await this.plugin.getBytes({})
    if (!r.data) return null
    return base64ToArrayBuffer(r.data)
  }

  close() {
    try {
      void this.plugin.close({})
    } catch {
      /* ignore */
    }
    if (this.textEngine) {
      this.textEngine.close()
      this.textEngine = null
    }
    this.pdfData = null
  }
}

// ---------- 网页引擎（pdf.js） ----------
class PdfJsEngine implements RenderEngine {
  private doc: PDFDocumentProxy | null = null
  private pdfBytes: ArrayBuffer | null = null
  private pages: EnginePageSize[] = []

  isNative() {
    return false
  }

  async open(data: ArrayBuffer | null) {
    if (!data) throw new Error('网页引擎需要 PDF 数据')
    const doc = await pdfEngine.loadPDF(data)
    this.doc = doc
    this.pdfBytes = data
    const total = doc.numPages
    // 并发测量全部页面尺寸（失败页用估算，避免个别页挂起卡住）
    const nums: number[] = []
    for (let i = 1; i <= total; i++) nums.push(i)
    const res = await pdfEngine.measurePageSizes(doc, nums, 16, 3000)
    const pages: EnginePageSize[] = []
    for (let i = 0; i < total; i++) {
      const s = res.get(i)
      pages.push(s ?? { width: 595, height: 842 })
    }
    this.pages = pages
    return { pageCount: total, pages }
  }

  async renderPage(pageIndex: number, canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number, scale: number) {
    if (!this.doc) throw new Error('文档未打开')
    const page = await this.doc.getPage(pageIndex + 1)
    const handle = pdfEngine.renderPageToCanvasEx(page, canvas, cssWidth, cssHeight, scale)
    await handle.done
  }

  async getPageText(pageNum: number) {
    if (!this.doc) return ''
    return pdfEngine.getPageText(this.doc, pageNum)
  }

  async getAllText(maxPages = 200) {
    if (!this.doc) return ''
    return pdfEngine.getAllText(this.doc, maxPages)
  }

  async getBytes() {
    return this.pdfBytes
  }

  close() {
    if (this.doc) {
      void this.doc.destroy()
      this.doc = null
    }
  }
}

// ---------- 引擎选择 ----------
import { Capacitor } from '@capacitor/core'

function detectNativePlugin(): any {
  try {
    // 用 @capacitor/core 的 Capacitor 实例（比 window 全局更可靠，不受注入时序影响）
    const native = (Capacitor as unknown as { Plugins?: Record<string, unknown> }).Plugins?.YuepiPDF
    return native ?? null
  } catch {
    return null
  }
}

/**
 * 获取当前环境的渲染引擎（APK → 原生 Pdfium；浏览器 → pdf.js）。
 * 不缓存：每次调用重新检测并新建（Capacitor 桥可能在应用早期才就绪，
 * 缓存单例会导致 APK 误用 pdf.js 引擎 → 打开极慢/纯背景）。
 */
export function getRenderEngine(): RenderEngine {
  const native = detectNativePlugin()
  return native ? new NativeEngine(native) : new PdfJsEngine()
}
