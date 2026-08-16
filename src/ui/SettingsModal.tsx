// ============ 设置弹窗（外观背景 / 4 个 AI 提供商精简配置 / 双路由 / 历史对话） ============
import { useState } from 'react'
import type { AISettings, AIProvider, ChatSession } from '../core/types'
import { CUSTOM2_MODELS, CUSTOM_MODELS, DEEPSEEK_MODELS, DOUBAO_MODELS } from '../core/types'
import { PROVIDERS, testConnection } from '../core/ai/providers'

const ALL_PROVIDERS: AIProvider[] = ['deepseek', 'doubao', 'custom', 'custom2']
/** 路由下拉的固定显示名（不随自定义名称变化，简洁直观） */
const PROVIDER_LABEL: Record<AIProvider, string> = {
  deepseek: 'DeepSeek',
  doubao: '豆包',
  custom: '硅基流动',
  custom2: '智谱AI'
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
  /** 更换背景主题（即时生效并持久化） */
  onBgChange: (key: string) => void
  onSave: (s: AISettings) => void
  onClose: () => void
  onToast: (msg: string) => void
  /** 从设置里打开一条历史对话（App 会关闭设置并切换到该对话） */
  onOpenChat: (id: string) => void
}

export default function SettingsModal({ settings, chats, bgTheme, onBgChange, onSave, onClose, onToast, onOpenChat }: Props) {
  const [draft, setDraft] = useState<AISettings>({ ...settings })
  const [testing, setTesting] = useState<AIProvider | null>(null)
  const [showChats, setShowChats] = useState(true)

  const set = (patch: Partial<AISettings>) => setDraft((d) => ({ ...d, ...patch }))

  const doTest = async (p: AIProvider) => {
    setTesting(p)
    const r = await testConnection(p, draft)
    setTesting(null)
    onToast(r.ok ? `「${PROVIDER_LABEL[p]}」连接成功：${r.message}` : `「${PROVIDER_LABEL[p]}」失败：${r.message}`)
  }

  const open = (url: string) => {
    if (url) window.open(url, '_blank')
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

          {/* DeepSeek */}
          <h3>DeepSeek（文字理解 / 全文问答）</h3>
          <label className="field">
            <span>API Key（<a onClick={() => open(PROVIDERS.deepseek.signupUrl(draft))}>platform.deepseek.com</a> 获取）</span>
            <input type="password" value={draft.deepseekKey} placeholder="sk-…" onChange={(e) => set({ deepseekKey: e.target.value })} />
          </label>
          <label className="field">
            <span>模型（v4-flash / v4-pro；v4-flash 支持图片提问，也可手填）</span>
            <input type="text" list="deepseek-models" value={draft.deepseekModel} onChange={(e) => set({ deepseekModel: e.target.value })} />
            <datalist id="deepseek-models">
              {DEEPSEEK_MODELS.map((m) => <option key={m} value={m} />)}
            </datalist>
          </label>
          <div className="field-row">
            <button className="tb-btn act" disabled={testing === 'deepseek' || !draft.deepseekKey.trim()} onClick={() => void doTest('deepseek')}>
              {testing === 'deepseek' ? '测试中…' : '测试连接'}
            </button>
            <button className="tb-btn act" onClick={() => open(PROVIDERS.deepseek.webUrl(draft))}>打开 DeepSeek 网页版</button>
          </div>

          {/* 豆包 */}
          <h3>豆包 / 火山方舟（视觉模型，支持图片提问）</h3>
          <label className="field">
            <span>API Key（<a onClick={() => open(PROVIDERS.doubao.signupUrl(draft))}>console.volcengine.com/ark</a> 获取）</span>
            <input type="password" value={draft.doubaoKey} placeholder="…（火山方舟的 API Key）" onChange={(e) => set({ doubaoKey: e.target.value })} />
          </label>
          <label className="field">
            <span>模型 / 推理接入点（填模型名或 ep-xxx）</span>
            <select value={draft.doubaoModel} onChange={(e) => set({ doubaoModel: e.target.value })}>
              {DOUBAO_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <div className="field-row">
            <button className="tb-btn act" disabled={testing === 'doubao' || !draft.doubaoKey.trim()} onClick={() => void doTest('doubao')}>
              {testing === 'doubao' ? '测试中…' : '测试连接'}
            </button>
            <button className="tb-btn act" onClick={() => open(PROVIDERS.doubao.webUrl(draft))}>打开豆包网页版</button>
          </div>

          {/* 硅基流动 */}
          <h3>硅基流动（OpenAI 兼容，接口自动填充）</h3>
          <div className="settings-note" style={{ fontSize: 11 }}>
            接口地址：https://api.siliconflow.cn/v1（已自动填充）· 网页版：siliconflow.cn
          </div>
          <label className="field">
            <span>API Key（<a onClick={() => open('https://cloud.siliconflow.cn')}>cloud.siliconflow.cn</a> 获取）</span>
            <input type="password" value={draft.customKey} placeholder="sk-…" onChange={(e) => set({ customKey: e.target.value })} />
          </label>
          <label className="field">
            <span>模型（常用见建议列表）</span>
            <input type="text" list="custom-models" value={draft.customModel} onChange={(e) => set({ customModel: e.target.value })} />
            <datalist id="custom-models">
              {CUSTOM_MODELS.map((m) => <option key={m} value={m} />)}
            </datalist>
          </label>
          <label className="field row">
            <input type="checkbox" checked={draft.customVision} onChange={(e) => set({ customVision: e.target.checked })} />
            <span>该模型支持图片输入（视觉模型，如 Qwen2.5-VL）</span>
          </label>
          <div className="field-row">
            <button className="tb-btn act" disabled={testing === 'custom' || !draft.customKey.trim()} onClick={() => void doTest('custom')}>
              {testing === 'custom' ? '测试中…' : '测试连接'}
            </button>
            <button className="tb-btn act" onClick={() => open('https://siliconflow.cn')}>打开网页版</button>
          </div>

          {/* 智谱AI */}
          <h3>智谱AI（OpenAI 兼容，接口自动填充）</h3>
          <div className="settings-note" style={{ fontSize: 11 }}>
            接口地址：https://open.bigmodel.cn/api/paas/v4（已自动填充）· 网页版：open.bigmodel.cn
          </div>
          <label className="field">
            <span>API Key（<a onClick={() => open('https://open.bigmodel.cn')}>open.bigmodel.cn</a> 获取）</span>
            <input type="password" value={draft.custom2Key} placeholder="…" onChange={(e) => set({ custom2Key: e.target.value })} />
          </label>
          <label className="field">
            <span>模型（常用见建议列表）</span>
            <input type="text" list="custom2-models" value={draft.custom2Model} onChange={(e) => set({ custom2Model: e.target.value })} />
            <datalist id="custom2-models">
              {CUSTOM2_MODELS.map((m) => <option key={m} value={m} />)}
            </datalist>
          </label>
          <label className="field row">
            <input type="checkbox" checked={draft.custom2Vision} onChange={(e) => set({ custom2Vision: e.target.checked })} />
            <span>该模型支持图片输入（视觉模型，如 glm-4v-flash）</span>
          </label>
          <div className="field-row">
            <button className="tb-btn act" disabled={testing === 'custom2' || !draft.custom2Key.trim()} onClick={() => void doTest('custom2')}>
              {testing === 'custom2' ? '测试中…' : '测试连接'}
            </button>
            <button className="tb-btn act" onClick={() => open('https://open.bigmodel.cn')}>打开网页版</button>
          </div>

          {/* 提问路由（文字 / 图片分别指定） */}
          <h3>提问路由</h3>
          <label className="field">
            <span>文字提问 → 路由到</span>
            <select value={draft.textRoute ?? 'auto'} onChange={(e) => set({ textRoute: e.target.value as AIProvider | 'auto' })}>
              <option value="auto">自动</option>
              {ALL_PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}
            </select>
          </label>
          <label className="field">
            <span>图片提问 → 路由到（需支持视觉的模型）</span>
            <select value={draft.imageRoute ?? 'auto'} onChange={(e) => set({ imageRoute: e.target.value as AIProvider | 'auto' })}>
              <option value="auto">自动</option>
              {ALL_PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}
            </select>
          </label>
          <label className="field">
            <span>温度：{draft.temperature.toFixed(1)}</span>
            <input type="range" min={0} max={1.5} step={0.1} value={draft.temperature} onChange={(e) => set({ temperature: +e.target.value })} />
          </label>

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
