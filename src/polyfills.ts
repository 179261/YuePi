// ============ 旧浏览器 API 兼容补丁（必须在任何业务代码前加载） ============
// pdf.js v4 需要 Promise.withResolvers；华为平板（HarmonyOS 4.2）浏览器内核较旧，
// 此处补上 withResolvers / structuredClone / Array.prototype.at 等。

declare global {
  interface PromiseConstructor {
    withResolvers<T>(): {
      promise: Promise<T>
      resolve: (value: T | PromiseLike<T>) => void
      reject: (reason?: unknown) => void
    }
  }
}

// ---------- Promise.withResolvers ----------
if (typeof Promise.withResolvers !== 'function') {
  ;(Promise as unknown as { withResolvers: unknown }).withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
}

// ---------- structuredClone（处理 ArrayBuffer/TypedArray 的深拷贝） ----------
if (typeof globalThis.structuredClone !== 'function') {
  function deepClone<T>(value: T, seen: Map<unknown, unknown> = new Map()): T {
    if (value === null || typeof value !== 'object') return value
    if (seen.has(value)) return seen.get(value) as T
    if (value instanceof ArrayBuffer) {
      return value.slice(0) as T
    }
    if (ArrayBuffer.isView(value)) {
      const buf = (value as unknown as { buffer: ArrayBuffer }).buffer
      const copy = new (value.constructor as new (b: ArrayBuffer) => unknown)(deepClone(buf, seen) as ArrayBuffer)
      ;(copy as unknown as { set: (v: unknown) => void }).set(value as unknown)
      return copy as T
    }
    if (value instanceof Date) return new Date(value.getTime()) as T
    if (value instanceof RegExp) return new RegExp(value.source, value.flags) as T
    if (value instanceof Blob) return (value as unknown as T) // Blob 不可克隆时原样返回
    const out: Record<string, unknown> = Array.isArray(value) ? ([] as unknown as Record<string, unknown>) : {}
    seen.set(value, out)
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = deepClone((value as Record<string, unknown>)[key], seen)
    }
    return out as T
  }
  ;(globalThis as unknown as { structuredClone: unknown }).structuredClone = deepClone
}

// ---------- Array.prototype.at ----------
if (typeof Array.prototype.at !== 'function') {
  ;(Array.prototype as unknown as { at: unknown }).at = function at(this: unknown[], index: number) {
    const n = Number(index) || 0
    return n >= 0 ? this[n] : this[this.length + n]
  }
}

export {}
