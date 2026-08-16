// ============ AI 会话调度（提供商路由 / 图文组装 / 错误包装） ============
import { streamChat, PROVIDERS, type OpenAIMessage } from './providers'
import type { AISettings, AIProvider, ChatMessage } from '../types'

export interface RunAIResult {
  provider: AIProvider
  model: string
  content: string
}

export interface RunAIOptions {
  onDelta?: (text: string) => void
  signal?: AbortSignal
}

function toOpenAI(m: ChatMessage): OpenAIMessage {
  if (m.role === 'user' && m.images && m.images.length) {
    const parts: OpenAIMessage['content'] = [
      { type: 'text', text: m.content || '请分析这张图片' }
    ]
    for (const img of m.images) {
      parts.push({ type: 'image_url', image_url: { url: img } })
    }
    return { role: 'user', content: parts }
  }
  return { role: m.role, content: m.content }
}

function hasKey(settings: AISettings, p: AIProvider): boolean {
  return !!PROVIDERS[p].getKey(settings).trim()
}

function firstWithKey(settings: AISettings, order: AIProvider[]): AIProvider | null {
  for (const p of order) if (hasKey(settings, p)) return p
  return null
}

/**
 * 自动选择提供商：
 * - 文字路由：用户指定 → DeepSeek → 自定义① → 自定义② → 豆包（按有 Key 的优先）
 * - 图片路由：用户指定 → 豆包(视觉) → DeepSeek(若用视觉模型) → 自定义①(若开启视觉) → 自定义②(若开启视觉) → 其它有 Key 的
 * 指定了路由但缺 Key 时回退到自动链。
 */
export function pickProvider(settings: AISettings, hasImages: boolean): AIProvider {
  const want = hasImages
    ? (settings.imageRoute ?? settings.defaultProvider ?? 'auto')
    : (settings.textRoute ?? settings.defaultProvider ?? 'auto')
  if (want !== 'auto' && hasKey(settings, want)) return want
  if (hasImages) {
    return (
      firstWithKey(settings, ['doubao']) ??
      (PROVIDERS.deepseek.supportsVision(settings) ? firstWithKey(settings, ['deepseek']) : null) ??
      (PROVIDERS.custom.supportsVision(settings) ? firstWithKey(settings, ['custom']) : null) ??
      (PROVIDERS.custom2.supportsVision(settings) ? firstWithKey(settings, ['custom2']) : null) ??
      (PROVIDERS.other.supportsVision(settings) ? firstWithKey(settings, ['other']) : null) ??
      firstWithKey(settings, ['deepseek', 'custom', 'custom2', 'other']) ??
      'deepseek'
    )
  }
  return firstWithKey(settings, ['deepseek', 'custom', 'custom2', 'doubao', 'other']) ?? 'deepseek'
}

/**
 * 执行一次 AI 问答（流式），返回最终结果。
 * 抛错信息对用户友好（未配置 Key / 网络跨域 / 图片路由提示）。
 */
export async function runAI(
  settings: AISettings,
  messages: ChatMessage[],
  opts: RunAIOptions = {}
): Promise<RunAIResult> {
  const hasImages = messages.some((m) => (m.images?.length ?? 0) > 0)
  const provider = pickProvider(settings, hasImages)
  const def = PROVIDERS[provider]
  const label = def.label(settings)

  if (hasImages && !def.supportsVision(settings)) {
    throw new Error(
      `「${label}」当前配置不支持图片。请使用支持视觉的提供商（豆包视觉模型，或自定义提供商里勾选"支持图片"），或点击「打开豆包网页版」在浏览器里传图提问。`
    )
  }

  if (!def.getKey(settings).trim()) {
    if (hasImages && provider === 'doubao') {
      throw new Error(
        '提问包含图片，需要「豆包」的 API Key（DeepSeek 文本接口不支持图片）。请在设置页填写豆包 Key，或点击「打开豆包网页版」在浏览器里传图提问。'
      )
    }
    throw new Error(`未配置「${label}」的 API Key，请在设置页填写（或使用网页版入口）。`)
  }

  const oai = messages.filter((m) => m.role !== 'system').map(toOpenAI)
  let acc = ''
  try {
    for await (const d of streamChat({
      provider,
      settings,
      messages: oai,
      temperature: settings.temperature,
      signal: opts.signal
    })) {
      acc += d
      opts.onDelta?.(d)
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw wrapError(e, label)
  }
  return { provider, model: def.getModel(settings), content: acc }
}

function wrapError(e: unknown, label: string): Error {
  const msg = e instanceof Error ? e.message : String(e)
  if (/Failed to fetch|NetworkError|load failed|ERR_/i.test(msg)) {
    return new Error(
      `无法连接「${label}」服务器（可能是网络或跨域限制）。请检查网络；也可点击「打开网页版」在浏览器中使用。`
    )
  }
  return e instanceof Error ? e : new Error(msg)
}
