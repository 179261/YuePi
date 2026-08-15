// 把 pdfjs-dist 自带的 cmaps（中文等非内嵌字体 PDF 渲染必需）复制到 public/cmaps
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'node_modules', 'pdfjs-dist', 'cmaps')
const dst = join(root, 'public', 'cmaps')
mkdirSync(dst, { recursive: true })
cpSync(src, dst, { recursive: true })
console.log('cmaps copied to public/cmaps')
