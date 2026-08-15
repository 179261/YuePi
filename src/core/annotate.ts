// ============ 手写批注引擎（压力感应笔画 / 荧光笔 / 橡皮 / 撤销重做） ============
import type { PageAnnotation, Stroke, StrokePoint, Tool } from './types'
import { uid } from './types'

export interface AnnotatorOptions {
  canvas: HTMLCanvasElement
  /** 页面 CSS 尺寸（缩放=1 时），批注坐标以此为基准 */
  width: number
  height: number
  /** 当前缩放倍率（用于把指针坐标换算回基准坐标） */
  getZoom: () => number
  /** 一笔结束后回调（用于持久化 / 刷新） */
  onCommit: (ann: PageAnnotation) => void
}

interface Point { x: number; y: number; p: number }

export class Annotator {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private opts: AnnotatorOptions
  private ann: PageAnnotation
  private dpr = 1

  tool: Tool = 'pen'
  color = '#e11d48'
  penWidth = 3
  highlighterWidth = 20
  eraserRadius = 10

  private drawing: Stroke | null = null
  private drawingIds = new Set<string>()
  private undoStack: PageAnnotation[] = []
  private redoStack: PageAnnotation[] = []
  private pointers = new Map<number, Point>()
  private raf = 0
  private disposed = false

  constructor(opts: AnnotatorOptions) {
    this.opts = opts
    this.canvas = opts.canvas
    this.ctx = opts.canvas.getContext('2d')!
    this.ann = { strokes: [], width: opts.width, height: opts.height }
    this.resize()
    this.canvas.addEventListener('pointerdown', this.onDown)
    this.canvas.addEventListener('pointermove', this.onMove)
    this.canvas.addEventListener('pointerup', this.onUp)
    this.canvas.addEventListener('pointercancel', this.onUp)
    this.canvas.addEventListener('pointerleave', this.onUp)
  }

  dispose() {
    this.disposed = true
    this.canvas.removeEventListener('pointerdown', this.onDown)
    this.canvas.removeEventListener('pointermove', this.onMove)
    this.canvas.removeEventListener('pointerup', this.onUp)
    this.canvas.removeEventListener('pointercancel', this.onUp)
    this.canvas.removeEventListener('pointerleave', this.onUp)
  }

  setAnnotations(ann: PageAnnotation) {
    this.ann = { strokes: [...ann.strokes], width: ann.width, height: ann.height }
    this.undoStack = []
    this.redoStack = []
    this.render()
  }

  getAnnotations(): PageAnnotation {
    return {
      strokes: [...this.ann.strokes],
      width: this.ann.width,
      height: this.ann.height
    }
  }

  resize() {
    this.dpr = Math.max(1, window.devicePixelRatio || 1)
    this.canvas.width = Math.max(1, Math.floor(this.opts.width * this.dpr))
    this.canvas.height = Math.max(1, Math.floor(this.opts.height * this.dpr))
    this.canvas.style.width = `${this.opts.width}px`
    this.canvas.style.height = `${this.opts.height}px`
    this.render()
  }

  private localPoint(e: PointerEvent): Point {
    const rect = this.canvas.getBoundingClientRect()
    const zoom = Math.max(0.05, this.opts.getZoom())
    const x = (e.clientX - rect.left) / zoom
    const y = (e.clientY - rect.top) / zoom
    const rawP = typeof e.pressure === 'number' && e.pressure > 0 ? e.pressure : 0.5
    const p = Math.max(0, Math.min(1, rawP))
    return { x, y, p }
  }

  private onDown = (e: PointerEvent) => {
    if (this.disposed) return
    if (this.tool === 'select' || this.tool === 'pan') return // 框选/平移由外层处理
    e.preventDefault()
    const pt = this.localPoint(e)
    this.pointers.set(e.pointerId, pt)
    if (this.tool === 'pen' || this.tool === 'highlighter') {
      this.canvas.setPointerCapture(e.pointerId)
      this.startStroke(e.pointerId, pt)
    } else if (this.tool === 'eraser') {
      this.canvas.setPointerCapture(e.pointerId)
      this.eraseAt(pt)
    }
  }

  private onMove = (e: PointerEvent) => {
    if (this.disposed || !this.pointers.has(e.pointerId)) return
    const pt = this.localPoint(e)
    this.pointers.set(e.pointerId, pt)
    if (this.tool === 'pen' || this.tool === 'highlighter') {
      const s = this.drawing
      if (s) {
        const last = s.points[s.points.length - 1]
        if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 0.5) return
        s.points.push(pt)
        this.scheduleRender()
      }
    } else if (this.tool === 'eraser') {
      this.eraseAt(pt)
    }
  }

  private onUp = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return
    this.pointers.delete(e.pointerId)
    if (this.tool === 'pen' || this.tool === 'highlighter') {
      if (this.drawing) {
        this.drawingIds.delete(this.drawing.id)
        if (this.drawing.points.length > 1) {
          this.ann.strokes.push(this.drawing)
          this.commit()
        }
        this.drawing = null
        this.scheduleRender()
      }
    } else if (this.tool === 'eraser') {
      this.commit()
    }
  }

  private startStroke(pointerId: number, pt: Point) {
    const isHl = this.tool === 'highlighter'
    this.drawing = {
      id: uid(),
      tool: isHl ? 'highlighter' : 'pen',
      color: this.color,
      width: isHl ? this.highlighterWidth : this.penWidth,
      opacity: isHl ? 0.35 : 1,
      points: [pt]
    }
    this.drawingIds.add(this.drawing.id)
  }

  private eraseAt(pt: Point) {
    const r = this.eraserRadius / Math.max(0.05, this.opts.getZoom())
    const before = this.ann.strokes.length
    this.ann.strokes = this.ann.strokes.filter((s) => !strokeNear(s, pt, r))
    if (this.ann.strokes.length !== before) {
      this.scheduleRender()
    }
  }

  private commit() {
    this.undoStack.push(this.cloneAnn(this.ann))
    if (this.undoStack.length > 200) this.undoStack.shift()
    this.redoStack = []
    this.opts.onCommit(this.getAnnotations())
  }

  undo() {
    if (!this.undoStack.length) return
    this.redoStack.push(this.cloneAnn(this.ann))
    const prev = this.undoStack.pop()!
    this.ann = prev
    this.render()
    this.opts.onCommit(this.getAnnotations())
  }

  redo() {
    if (!this.redoStack.length) return
    this.undoStack.push(this.cloneAnn(this.ann))
    const next = this.redoStack.pop()!
    this.ann = next
    this.render()
    this.opts.onCommit(this.getAnnotations())
  }

  canUndo() {
    return this.undoStack.length > 0
  }
  canRedo() {
    return this.redoStack.length > 0
  }

  private cloneAnn(a: PageAnnotation): PageAnnotation {
    return {
      strokes: a.strokes.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p })) })),
      width: a.width,
      height: a.height
    }
  }

  private scheduleRender() {
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.render()
    })
  }

  render() {
    const ctx = this.ctx
    const dpr = this.dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, this.opts.width, this.opts.height)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const s of this.ann.strokes) {
      if (!s.points.length) continue
      if (s.tool === 'highlighter') {
        ctx.globalAlpha = s.opacity
        ctx.strokeStyle = s.color
        ctx.lineWidth = s.width
        ctx.beginPath()
        ctx.moveTo(s.points[0].x, s.points[0].y)
        for (const p of s.points.slice(1)) ctx.lineTo(p.x, p.y)
        ctx.stroke()
        ctx.globalAlpha = 1
      } else {
        // 压力感应：逐段绘制，线宽随压力变化
        ctx.strokeStyle = s.color
        ctx.globalAlpha = s.opacity
        for (let i = 1; i < s.points.length; i++) {
          const a = s.points[i - 1]
          const b = s.points[i]
          const w = s.width * (0.35 + 0.65 * b.p)
          ctx.lineWidth = Math.max(0.6, w)
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }
        ctx.globalAlpha = 1
      }
    }
    if (this.drawing && this.drawing.points.length) {
      const s = this.drawing
      if (s.tool === 'highlighter') {
        ctx.globalAlpha = s.opacity
        ctx.strokeStyle = s.color
        ctx.lineWidth = s.width
        ctx.beginPath()
        ctx.moveTo(s.points[0].x, s.points[0].y)
        for (const p of s.points.slice(1)) ctx.lineTo(p.x, p.y)
        ctx.stroke()
        ctx.globalAlpha = 1
      } else {
        ctx.strokeStyle = s.color
        for (let i = 1; i < s.points.length; i++) {
          const a = s.points[i - 1]
          const b = s.points[i]
          ctx.lineWidth = Math.max(0.6, s.width * (0.35 + 0.65 * b.p))
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }
      }
    }
  }
}

function strokeNear(s: Stroke, pt: Point, radius: number): boolean {
  for (let i = 1; i < s.points.length; i++) {
    const a = s.points[i - 1]
    const b = s.points[i]
    if (distToSegment(pt, a, b) <= radius) return true
  }
  if (s.points.length === 1) {
    const a = s.points[0]
    if (Math.hypot(pt.x - a.x, pt.y - a.y) <= radius) return true
  }
  return false
}

function distToSegment(p: Point, a: StrokePoint, b: StrokePoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const cx = a.x + t * dx
  const cy = a.y + t * dy
  return Math.hypot(p.x - cx, p.y - cy)
}
