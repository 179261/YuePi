// ============ 基础类型定义 ============

export type Tool = 'pen' | 'highlighter' | 'eraser' | 'pan' | 'select'

export interface StrokePoint {
  x: number // 页面坐标（CSS px，缩放为1时的坐标）
  y: number
  p: number // 压力 0~1（手指无压力时给默认值）
}

export interface Stroke {
  id: string
  tool: 'pen' | 'highlighter'
  color: string
  width: number // 基准线宽（页面坐标单位）
  opacity: number
  points: StrokePoint[]
}

/** 单页批注（坐标基于缩放为1时的页面 CSS 尺寸） */
export interface PageAnnotation {
  strokes: Stroke[]
  width: number
  height: number
}

export interface PDFDocMeta {
  id: string
  name: string
  addedAt: number
  size: number
  pageCount: number
  /** 上次阅读到的页码（重新打开时恢复到该位置） */
  lastPage?: number
  /** PDF 原始字节。列表/元信息中不含（避免大文件常驻内存），打开文档时才加载 */
  data?: ArrayBuffer
}

export interface WhiteboardMeta {
  id: string
  name: string
  updatedAt: number
  /** tldraw 快照（editor.getSnapshot()） */
  snapshot: unknown
}

export type ChatRole = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  /** 用户消息附带的图片 dataURL 列表 */
  images?: string[]
  provider?: string
  model?: string
  time: number
}

export interface ChatSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
}

export type AIProvider = 'deepseek' | 'doubao' | 'custom' | 'custom2'

export interface AISettings {
  deepseekKey: string
  deepseekModel: string
  doubaoKey: string
  /** 豆包模型名或推理接入点 ep-xxx */
  doubaoModel: string
  /** 自定义 OpenAI 兼容提供商①（如硅基流动 / Kimi / OpenRouter） */
  customName: string
  customBaseUrl: string
  customKey: string
  customModel: string
  customVision: boolean
  customWebUrl: string
  /** 自定义 OpenAI 兼容提供商②（如智谱 / 通义等） */
  custom2Name: string
  custom2BaseUrl: string
  custom2Key: string
  custom2Model: string
  custom2Vision: boolean
  custom2WebUrl: string
  /** 提问路由：文字与图片可分别指定提供商（'auto' = 自动选择） */
  textRoute: AIProvider | 'auto'
  imageRoute: AIProvider | 'auto'
  defaultProvider: AIProvider | 'auto'
  temperature: number
}

export const DEFAULT_SETTINGS: AISettings = {
  deepseekKey: '',
  deepseekModel: 'deepseek-v4-flash',
  doubaoKey: '',
  doubaoModel: 'doubao-1.5-vision-pro-32k-250115',
  customName: '硅基流动',
  customBaseUrl: 'https://api.siliconflow.cn/v1',
  customKey: '',
  customModel: 'deepseek-ai/DeepSeek-V3',
  customVision: false,
  customWebUrl: 'https://siliconflow.cn',
  custom2Name: '智谱AI',
  custom2BaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  custom2Key: '',
  custom2Model: 'glm-4-flash',
  custom2Vision: false,
  custom2WebUrl: 'https://open.bigmodel.cn',
  textRoute: 'auto',
  imageRoute: 'auto',
  defaultProvider: 'auto',
  temperature: 0.7
}

export const DOUBAO_MODELS = [
  'doubao-1.5-vision-pro-32k-250115',
  'doubao-1.5-vision-pro-256k-250423',
  'doubao-seed-1.6-vision-250815',
  'doubao-1.5-pro-32k-250115',
  'doubao-pro-32k',
  'doubao-lite-32k'
] as const

export const DEEPSEEK_MODELS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-chat',
  'deepseek-reasoner',
  'deepseek-4v-flash',
  'deepseek-pro'
] as const

/** 常用自定义提供商（硅基流动等）模型名建议 */
export const CUSTOM_MODELS = [
  'deepseek-ai/DeepSeek-V3',
  'deepseek-ai/DeepSeek-R1',
  'Qwen/Qwen2.5-72B-Instruct',
  'Qwen/Qwen2.5-VL-32B-Instruct',
  'THUDM/GLM-4-9B-Chat',
  'moonshotai/Kimi-K2-0905-Preview'
] as const

/** 常用自定义提供商②（智谱等）模型名建议 */
export const CUSTOM2_MODELS = [
  'glm-4-flash',
  'glm-4-plus',
  'glm-4v-flash',
  'glm-4v-plus',
  'glm-4.5'
] as const

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9)
}
