// ============ 把批注"压平"导出为带批注的 PDF（pdf-lib） ============
import { PDFDocument, rgb } from 'pdf-lib'
import type { PageAnnotation } from './types'

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return { r: 0.88, g: 0.11, b: 0.28 }
  const n = parseInt(m[1], 16)
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }
}

/**
 * 将批注叠加到原始 PDF 上（批注坐标基于 scale=1 的 viewport，单位≈PDF 点）。
 * 注意 pdf.js 坐标原点在左上，pdf-lib 原点在左下，需要翻转 Y。
 */
export async function flattenAnnotations(
  pdfBytes: ArrayBuffer,
  annotations: PageAnnotation[]
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes)
  const pages = doc.getPages()
  for (let i = 0; i < annotations.length; i++) {
    const ann = annotations[i]
    const page = pages[i]
    if (!page || !ann.strokes.length) continue
    const pw = page.getWidth()
    const ph = page.getHeight()
    const sx = ann.width > 0 ? pw / ann.width : 1
    const sy = ann.height > 0 ? ph / ann.height : 1
    const scale = Math.min(sx, sy)
    for (const s of ann.strokes) {
      const col = hexToRgb(s.color)
      const opacity = s.tool === 'highlighter' ? 0.35 : 1
      const pts = s.points
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1]
        const b = pts[k]
        const w = Math.max(0.4, s.width * (0.35 + 0.65 * b.p) * scale)
        page.drawLine({
          start: { x: a.x * sx, y: ph - a.y * sy },
          end: { x: b.x * sx, y: ph - b.y * sy },
          thickness: w,
          color: rgb(col.r, col.g, col.b),
          opacity
        })
      }
    }
  }
  return doc.save()
}
