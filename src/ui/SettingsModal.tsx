// ============ 设置弹窗（外观背景 / AI 路由 + 按需显示配置 / 历史对话） ============
// 交互：路由里选了哪个 AI，下方才显示该 AI 的配置；路由全为「自动」时显示全部便于初次配置。
import { useState } from 'react'
import type { AISettings, AIProvider, ChatSession } from '../core/types'
import { CUSTOM2_MODELS, CUSTOM_MODELS, DEEPSEEK_MODELS, DOUBAO_MODELS } from '../core/types'
import { testConnection } from '../core/ai/providers'

const ALL_PROVIDERS: AIProvider[] = ['deepseek', 'doubao', 'custom', 'custom2', 'other']

/** 路由选项（固定显示名） */
const ROUTE_OPTIONS: { value: AIProvider; label: string }[] = [
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'doubao', label: '火山方舟' },
  { value: 'custom', label: '硅基流动' },
  { value: 'custom2', label: '智谱AI' },
  { value: 'other', label: '其它' }
]

/** 各 AI 的配置区块元数据（字段名 / 建议模型 / 官网链接） */
interface BlockMeta {
  title: string
  keyField: keyof AISettings
  modelField: keyof AISettings
  baseUrlField: keyof AISettings
  visionField?: keyof AISettings
  nameField?: keyof AISettings
  models: string[]
  signupLabel: string
  signupUrl: string
  webLabel: string
  webUrl: string
}

const BLOCKS: Record<AIProvider, BlockMeta> = {
  deepseek: {
    title: 'DeepSeek',
    keyField: 'deepseekKey',
    modelField: 'deepseekModel',
    baseUrlField: 'deepseekBaseUrl',
    visionField: undefined,
    models: [...DEEPSEEK_MODELS],
    signupLabel: 'platform.deepseek.com',
    signupUrl: 'https://platform.deepseek.com',
    webLabel: '打开 DeepSeek 网页版',
    webUrl: 'https://chat.deepseek.com'
  },
  doubao: {
    title: '火山方舟',
    keyField: 'doubaoKey',
    modelField: 'doubaoModel',
    baseUrlField: 'doubaoBaseUrl',
    models: [...DOUBAO_MODELS],
    signupLabel: 'console.volcengine.com/ark',
    signupUrl: 'https://console.volcengine.com/ark',
    webLabel: '打开豆包网页版',
    webUrl: 'https://www.doubao.com'
  },
  custom: {
    title: '硅基流动',
    keyField: 'customKey',
    modelField: 'customModel',
    baseUrlField: 'customBaseUrl',
    visionField: 'customVision',
    models: [...CUSTOM_MODELS],
    signupLabel: 'cloud.siliconflow.cn',
    signupUrl: 'https://cloud.siliconflow.cn',
    webLabel: '打开网页版',
    webUrl: 'https://siliconflow.cn'
  },
  custom2: {
    title: '智谱AI',
    keyField: 'custom2Key',
    modelField: 'custom2Model',
    baseUrlField: 'custom2BaseUrl',
    visionField: 'custom2Vision',
    models: [...CUSTOM2_MODELS],
    signupLabel: 'open.bigmodel.cn',
    signupUrl: 'https://open.bigmodel.cn',
    webLabel: '打开网页版',
    webUrl: 'https://open.bigmodel.cn'
  },
  other: {
    title: '其它',
    keyField: 'otherKey',
    modelField: 'otherModel',
    baseUrlField: 'otherBaseUrl',
    visionField: 'otherVision',
    nameField: 'otherName',
    models: [],
    signupLabel: '',
    signupUrl: '',
    webLabel: '',
    webUrl: ''
  }
}

const BG_THEMES = [
  { key: '纸黄', color: '#fbf3d9', label: '纸黄' },
  { key: '米白', color: '#faf6ec', label: '米白' },
  { key: '浅绿', color: '#eef4e4', label: '浅绿' },
  { key: '浅蓝', color: '#e8f0f7', label: '浅蓝' }
]

interface Props {
  settings: AISettings
  chats: ChatSession[]
  bgTheme: string
  onBgChange: (key: string) => void
  onSave: (s: AISettings) => void
  onClose: () => void
  onToast: (msg: string) => void
  onOpenChat: (id: string) => void
}

export default function SettingsModal({ settings, chats, bgTheme, onBgChange, onSave, onClose, onToast, onOpenChat }: Props) {
  const [draft, setDraft] = useState<AISettings>({ ...settings })
  const [testing, setTesting] = useState<AIProvider | null>(null)
  const [showChats, setShowChats] = useState(true)

  const set = (patch: Partial<AISettings>) => setDraft((d) => ({ ...d, ...patch }))

  /** 动态字段赋值（keyof AISettings，避免可选字段作计算属性名的 TS 报错） */
  const setField = (field: keyof AISettings, value: string | boolean) => {
    setDraft((d) => ({ ...d, [field]: value }) as AISettings)
  }

  const val = (p: AIProvider, field: keyof AISettings) => draft[field] as string

  /** 路由选中了哪些 AI（文字+图片去重）；全 auto → 显示全部 */
  const visible: AIProvider[] = (() => {
    const picked = new Set<AIProvider>()
    if (draft.textRoute !== 'auto') picked.add(draft.textRoute as AIProvider)
    if (draft.imageRoute !== 'auto') picked.add(draft.imageRoute as AIProvider)
    if (picked.size === 0) return [...ALL_PROVIDERS]
    return ROUTE_OPTIONS.map((o) => o.value).filter((v) => picked.has(v))
  })()

  /** 当前路由指向的提供商标记 */
  const routeMark = (p: AIProvider) => {
    const marks: string[] = []
    if (draft.textRoute === p) marks.push('文字路由')
    if (draft.imageRoute === p) marks.push('图片路由')
    return marks.length ? `（当前：${marks.join('、')}）` : ''
  }

  const doTest = async (p: AIProvider) => {
    setTesting(p)
    const r = await testConnection(p, draft)
    setTesting(null)
    onToast(r.ok ? `「${BLOCKS[p].title}」连接成功：${r.message}` : `「${BLOCKS[p].title}」失败：${r.message}`)
  }

  const open = (url: string) => {
    if (url) window.open(url, '_blank')
  }

  /** 渲染单个 AI 的配置区块 */
  const renderBlock = (p: AIProvider) => {
    const b = BLOCKS[p]
    return (
      <div key={p}>
        <h3>{b.title} {routeMark(p)}</h3>
        {b.nameField && (
          <label className="field">
            <span>显示名称（如"Kimi"、"OpenRouter"等）</span>
            <input type="text" value={val(p, b.nameField)} onChange={(e) => setField(b.nameField!, e.target.value)} />
          </label>
        )}
        <label className="field">
          <span>接口地址（OpenAI 兼容，可修改）</span>
          <input type="text" value={val(p, b.baseUrlField)} placeholder="https://…/v1" onChange={(e) => setField(b.baseUrlField, e.target.value)} />
        </label>
        <label className="field">
          <span>API Key{b.signupUrl ? `（${b.signupLabel} 获取）` : '（填写后生效）'}</span>
          <input type="password" value={val(p, b.keyField)} placeholder="sk-…" onChange={(e) => setField(b.keyField, e.target.value)} />
        </label>
        <label className="field">
          <span>模型（点建议或手填其它模型名）</span>
          <input
            type="text"
            list={`models-${p}`}
            value={val(p, b.modelField)}
            placeholder={p === 'other' ? '如 gpt-4o / claude-… / 其它任意模型' : '模型名'}
            onChange={(e) => setField(b.modelField, e.target.value)}
          />
          {b.models.length > 0 && (
            <datalist id={`models-${p}`}>
              {b.models.map((m) => <option key={m} value={m} />)}
            </datalist>
          )}
        </label>
        {b.visionField && (
          <label className="field row">
            <input type="checkbox" checked={!!draft[b.visionField]} onChange={(e) => setField(b.visionField!, e.target.checked)} />
            <span>该模型支持图片输入（视觉模型，图片提问可走此提供商）</span>
          </label>
        )}
        <div className="field-row">
          <button className="tb-btn act" disabled={testing === p || !val(p, b.keyField).trim()} onClick={() => void doTest(p)}>
            {testing === p ? '测试中…' : '测试连接'}
          </button>
          {b.webUrl && <button className="tb-btn act" onClick={() => open(b.webUrl)}>{b.webLabel}</button>}
        </div>
      </div>
    )
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>⚙️ 设置</span>
          <button className="tb-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="settings-note">
            应用完全本地运行、无广告。AI 使用你自己的 API Key（Key 仅保存在本机）；不填 Key 也可用「网页版」入口。
          </div>

          {/* 外观：背景颜色 */}
          <h3>🎨 外观</h3>
          <div className="field">
            <span>背景颜色</span>
            <div className="bg-themes">
              {BG_THEMES.map((t) => (
                <button
                  key={t.key}
                  className={bgTheme === t.key ? 'bg-theme active' : 'bg-theme'}
                  style={{ background: t.color }}
                  title={t.label}
                  onClick={() => onBgChange(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* AI 路由 */}
          <h3>🤖 AI 路由</h3>
          <div className="settings-note" style={{ fontSize: 11, marginBottom: 8 }}>
            文字 / 图片提问分别指定走哪个 AI；下方只显示被选中的 AI 配置（全为「自动」时显示全部）。选「其它」可自由配置任意 OpenAI 兼容接口。
          </div>
          <label className="field">
            <span>文字提问 → 路由到</span>
            <select value={draft.textRoute ?? 'auto'} onChange={(e) => set({ textRoute: e.target.value as AIProvider | 'auto' })}>
              <option value="auto">自动</option>
              {ROUTE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>图片提问 → 路由到（需支持视觉的模型）</span>
            <select value={draft.imageRoute ?? 'auto'} onChange={(e) => set({ imageRoute: e.target.value as AIProvider | 'auto' })}>
              <option value="auto">自动</option>
              {ROUTE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>温度：{draft.temperature.toFixed(1)}</span>
            <input type="range" min={0} max={1.5} step={0.1} value={draft.temperature} onChange={(e) => set({ temperature: +e.target.value })} />
          </label>

          {/* AI 配置：只显示路由选中的 */}
          <div className="settings-section">
            <div className="settings-section-head">
              <span className="settings-section-title">⚙️ AI 配置{visible.length !== ALL_PROVIDERS.length ? `（${visible.length} 个）` : ''}</span>
            </div>
            {visible.map(renderBlock)}
          </div>

          {/* 历史对话 */}
          <div className="settings-section">
            <div className="settings-section-head">
              <span className="settings-section-title">📋 历史对话（{chats.length} 条）</span>
              <button className="tb-btn" onClick={() => setShowChats((v) => !v)}>{showChats ? '收起' : '展开'}</button>
            </div>
            {showChats && (
              <div className="settings-chats">
                {chats.length === 0 ? (
                  <div className="sidebar-empty">还没有对话记录，点「🤖 AI助手」开始提问</div>
                ) : (
                  chats.map((c) => (
                    <button key={c.id} className="chat-item" onClick={() => onOpenChat(c.id)}>
                      <span className="chat-item-title">{c.title || '未命名对话'}</span>
                      <span className="chat-item-meta">{c.messages.length} 条 · {new Date(c.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
        <div className="modal-footer">
          <button className="tb-btn act" onClick={onClose}>取消</button>
          <button className="send-btn" onClick={() => { onSave(draft); onClose() }}>保存</button>
        </div>
      </div>
    </div>
  )
}
