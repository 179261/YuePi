// ============ Markdown 渲染（XSS 净化） ============
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: true })

export function renderMd(src: string): string {
  const html = marked.parse(src) as string
  return DOMPurify.sanitize(html)
}
