// ============ AI 助手页的精简设置：AI 路由 + 对话选择/删除 ============
import { useState } from 'react'
import type { AISettings, AIProvider, ChatSession } from '../core/types'

const ALL_PROVIDERS: AIProvider[] = ['deepseek', 'doubao', 'custom', 'custom2']
const PROVIDER_LABEL: Record<AIProvider, string> = {
  deepseek: 'DeepSeek',
  doubao: '豆包',
  custom: '硅基流动',
  custom2: '智谱AI'
}

interface Props {
  settings: AISettings
  chats: ChatSession[]
  activeChatId: string | null
  onSave: (s: AISettings) => void
  onOpenChat: (id: string) => void
  onDeleteChat: (id: string) => void
  onClose: () => void
}

export default function ChatSettingsModal({
  settings,
  chats,
  activeChatId,
  onSave,
  onOpenChat,
  onDeleteChat,
  onClose
}: Props) {
  const [draft, setDraft] = useState<AISettings>({ ...settings })
  const [confirming, setConfirming] = useState<string | null>(null)
  const [tab, setTab] = useState<'route' | 'chats'>('route')

  const set = (patch: Partial<AISettings>) => setDraft((d) => ({ ...d, ...patch }))

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>🤖 AI 设置</span>
          <button className="tb-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="sidebar-tabs" style={{ marginBottom: 10 }}>
            <button className={tab === 'route' ? 'st-btn active' : 'st-btn'} onClick={() => setTab('route')}>AI 模型路由</button>
            <button className={tab === 'chats' ? 'st-btn active' : 'st-btn'} onClick={() => setTab('chats')}>对话管理（{chats.length}）</button>
          </div>

          {tab === 'route' && (
            <>
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
              <div className="settings-note" style={{ marginTop: 10 }}>
                配置各提供商的 API Key 请在顶部「⚙️ 设置」里填写；不填 Key 也可以用「网页版」入口。
              </div>
            </>
          )}

          {tab === 'chats' && (
            <div className="settings-chats" style={{ maxHeight: 320 }}>
              {chats.length === 0 ? (
                <div className="sidebar-empty">还没有对话记录，点「＋ 新建对话」开始</div>
              ) : (
                chats.map((c) => (
                  <div key={c.id} className={activeChatId === c.id ? 'chat-item-row active' : 'chat-item-row'}>
                    <button className="chat-item" style={{ flex: 1 }} onClick={() => { onOpenChat(c.id); onClose() }}>
                      <span className="chat-item-title">{c.title || '未命名对话'}</span>
                      <span className="chat-item-meta">{c.messages.length} 条 · {new Date(c.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                    </button>
                    <button
                      className={confirming === c.id ? 'del-btn confirming' : 'del-btn'}
                      onClick={() => {
                        if (confirming === c.id) {
                          setConfirming(null)
                          onDeleteChat(c.id)
                        } else {
                          setConfirming(c.id)
                          setTimeout(() => setConfirming(null), 2500)
                        }
                      }}
                      title="删除对话"
                    >
                      {confirming === c.id ? '确认?' : '🗑'}
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="tb-btn act" onClick={onClose}>取消</button>
          <button className="send-btn" onClick={() => { onSave(draft); onClose() }}>保存</button>
        </div>
      </div>
    </div>
  )
}
