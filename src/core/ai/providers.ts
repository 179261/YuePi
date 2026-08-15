// ============ AI 提供商接入（DeepSeek / 豆包火山方舟 / 自定义 OpenAI 兼容，如硅基流动） ============
import type { AISettings, AIProvider } from '../types'

export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | OpenAIContentPart[]
}

export interface ProviderDef {
  kind: AIProvider
  label: (s: AISettings) => string
  baseUrl: (s: AISettings) => string
  getKey: (s: AISettings) => string
  getModel: (s: AISettings) => string
  supportsVision: (s: AISettings) => boolean
  webUrl: (s: AISettings) => string
  signupUrl: (s: AISettings) => string
}

export const PROVIDERS: Record<AIProvider, ProviderDef> = {
  deepseek: {
    kind: 'deepseek',
    label: () => 'DeepSeek',
    baseUrl: () => 'https://api.deepseek.com',
    getKey: (s) => s.deepseekKey,
    getModel: (s) => s.deepseekModel,
    // deepseek-4v-flash / deepseek-vl 等视觉模型支持图片输入
    supportsVision: (s) => /(4v|vision|vl)/i.test(s.deepseekModel || ''),
    webUrl: () => 'https://chat.deepseek.com',
    signupUrl: () => 'https://platform.deepseek.com'
  },
  doubao: {
    kind: 'doubao',
    label: () => '豆包（火山方舟）',
    baseUrl: () => 'https://ark.cn-beijing.volces.com/api/v3',
    getKey: (s) => s.doubaoKey,
    getModel: (s) => s.doubaoModel,
    supportsVision: () => true,
    webUrl: () => 'https://www.doubao.com',
    signupUrl: () => 'https://console.volcengine.com/ark'
  },
  custom: {
    kind: 'custom',
    label: (s) => s.customName?.trim() || '自定义①',
    baseUrl: (s) => (s.customBaseUrl?.trim() || 'https://api.siliconflow.cn/v1').replace(/\/+$/, ''),
    getKey: (s) => s.customKey,
    getModel: (s) => s.customModel?.trim() || 'deepseek-ai/DeepSeek-V3',
    supportsVision: (s) => !!s.customVision,
    webUrl: (s) => s.customWebUrl?.trim() || '',
    signupUrl: () => ''
  },
  custom2: {
    kind: 'custom2',
    label: (s) => s.custom2Name?.trim() || '自定义②',
    baseUrl: (s) => (s.custom2BaseUrl?.trim() || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, ''),
    getKey: (s) => s.custom2Key,
    getModel: (s) => s.custom2Model?.trim() || 'glm-4-flash',
    supportsVision: (s) => !!s.custom2Vision,
    webUrl: (s) => s.custom2WebUrl?.trim() || '',
    signupUrl: () => ''
  }
}

export interface StreamOptions {
  provider: AIProvider
  settings: AISettings
  messages: OpenAIMessage[]
  temperature?: number
  signal?: AbortSignal
}

/**
 * 流式调用 OpenAI 兼容的 chat/completions 接口，逐段产出文本。
 * DeepSeek: https://api.deepseek.com/chat/completions
 * 豆包(火山方舟): https://ark.cn-beijing.volces.com/api/v3/chat/completions
 * 自定义(硅基流动等): <baseUrl>/chat/completions
 */
export async function* streamChat(opts: StreamOptions): AsyncGenerator<string> {
  const def = PROVIDERS[opts.provider]
  const key = def.getKey(opts.settings).trim()
  if (!key) {
    throw new Error(`未配置「${def.label(opts.settings)}」的 API Key，请到设置页填写（或使用网页版入口）`)
  }
  const res = await fetch(`${def.baseUrl(opts.settings)}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model: def.getModel(opts.settings),
      messages: opts.messages,
      stream: true,
      temperature: opts.temperature ?? 0.7
    }),
    signal: opts.signal
  })
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 400)
    } catch {
      /* ignore */
    }
    throw new Error(`API 请求失败 (HTTP ${res.status})：${detail || '未知错误'}`)
  }
  if (!res.body) throw new Error('网络响应异常')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const payload = t.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const json = JSON.parse(payload)
        const delta: unknown = json.choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta.length) yield delta
      } catch {
        /* 忽略无法解析的帧 */
      }
    }
  }
}

export async function chatOnce(opts: StreamOptions): Promise<string> {
  let acc = ''
  for await (const d of streamChat(opts)) acc += d
  return acc
}

export async function testConnection(
  provider: AIProvider,
  settings: AISettings
): Promise<{ ok: boolean; message: string }> {
  try {
    const reply = await chatOnce({
      provider,
      settings,
      messages: [{ role: 'user', content: '请只回复四个字：连接成功' }],
      temperature: 0
    })
    return { ok: true, message: reply.slice(0, 120) }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}
