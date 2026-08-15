// 生成 PWA 图标（纯 Node，无依赖）：public/icons/icon-192.png 与 icon-512.png
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'public', 'icons')
mkdirSync(outDir, { recursive: true })

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function makePNG(size, pixelFn) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y)
      const o = y * (size * 4 + 1) + 1 + x * 4
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const idat = deflateSync(raw, { level: 9 })
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// ---------- 图案：深色圆角底 + 斜向"笔迹" + 下划线 ----------
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx)
  const dy = Math.abs(py - cy)
  if (dx > hw - r || dy > hh - r) return false
  if (dx <= hw - r || dy <= hh - r) return true
  const ox = dx - (hw - r)
  const oy = dy - (hh - r)
  return ox * ox + oy * oy <= r * r
}

// 线段到点的距离（用于抗锯齿）
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function pixel(size, x, y) {
  const s = size / 512
  const r = 96 * s
  // 圆角矩形内
  if (!sdRoundRect(x + 0.5, y + 0.5, 256 * s, 256 * s, 256 * s - 2, 256 * s - 2, r)) {
    return [0, 0, 0, 0]
  }
  // 背景
  let bg = [15, 23, 42] // #0f172a
  const cx = 256 * s
  const cy = 256 * s
  const d = Math.hypot(x - cx, y - cy) / (256 * s)
  if (d < 1) {
    const t = d * 0.25
    bg = [15 + t * 8, 23 + t * 12, 42 + t * 20]
  }
  // 斜向主笔迹
  const dMain = distToSeg(x, y, 110 * s, 410 * s, 400 * s, 120 * s)
  // 第二条细线
  const dSub = distToSeg(x, y, 150 * s, 410 * s, 440 * s, 120 * s)
  // 下划线
  const dLine = Math.abs(y - 430 * s)
  const inLine = x > 130 * s && x < 390 * s && dLine < 7 * s

  let col = null
  let aa = 0
  if (dMain < 26 * s) {
    col = [56, 189, 248] // #38bdf8
    aa = Math.min(1, (26 * s - dMain) / (2 * s))
  } else if (dSub < 14 * s) {
    col = [99, 102, 241] // #6366f1
    aa = Math.min(1, (14 * s - dSub) / (2 * s))
  } else if (inLine) {
    col = [56, 189, 248]
    aa = Math.min(1, (7 * s - dLine) / (2 * s))
  }
  if (col) {
    return [
      Math.round(bg[0] + (col[0] - bg[0]) * aa),
      Math.round(bg[1] + (col[1] - bg[1]) * aa),
      Math.round(bg[2] + (col[2] - bg[2]) * aa),
      255
    ]
  }
  return [bg[0], bg[1], bg[2], 255]
}

for (const size of [192, 512]) {
  const buf = makePNG(size, (x, y) => pixel(size, x, y))
  writeFileSync(join(outDir, `icon-${size}.png`), buf)
  console.log(`icon-${size}.png: ${buf.length} bytes`)
}
