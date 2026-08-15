// ============ AI 面板：对话 + 内嵌网页版；侧边栏可调宽，浮窗可拖动/缩放 ============
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AISettings, AIProvider, ChatSession } from '../core/types'
import { PROVIDERS } from '../core/ai/providers'
import { renderMd } from '../core/md'

export interface StagedAttach {
  image?: string
  text?: string
  label?: string
}

interface Props {
  session: ChatSession | null
  settings: AISettings
  busy: boolean
  docked: boolean
  staged: StagedAttach | null
  onConsumeStaged: () => void
  onSend: (text: string, images: string[]) => void
  onStop: () => void
  onToggleDock: () => void
  onClose: () => void
  onNew: () => void
  onOpenSettings: () => void
}

type Tab = 'chat' | 'web'

interface FloatLayout { x: number; y: number; w: number; h: number }

const LAYOUT_KEY = 'yuepi.chatLayout'

function loadLayout(): { dockedW: number; float: FloatLayout | null } {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (raw) return JSON.parse(raw) as { dockedW: number; float: FloatLayout | null }
  } catch {
    /* ignore */
  }
  return { dockedW: 400, float: null }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

export default function ChatPanel(p: Props) {
  const [tab, setTab] = useState<Tab>('chat')
  const [text, setText] = useState('')
  const [stagedLocal, setStagedLocal] = useState<StagedAttach | null>(null)
  const [webSrc, setWebSrc] = useState('')
  const [webReload, setWebReload] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const camRef = useRef<HTMLInputElement>(null)

  // ---------- 布局状态（侧栏宽度 / 浮窗位置大小） ----------
  const [dockedW, setDockedW] = useState(() => loadLayout().dockedW)
  const [floatLayout, setFloatLayout] = useState<FloatLayout>(() => {
    const saved = loadLayout().float
    const w = saved?.w ?? 400
    const h = saved?.h ?? Math.round(window.innerHeight * 0.8)
    return { x: saved?.x ?? Math.max(8, window.innerWidth - w - 16), y: saved?.y ?? 16, w, h }
  })

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({ dockedW, float: floatLayout }))
    } catch {
      /* ignore */
    }
  }, [dockedW, floatLayout])

  // ---------- 拖动浮窗（标签行，含指针捕获，避免拖一小段就失效） ----------
  const startDrag = (e: React.PointerEvent) => {
    if (p.docked) return
    const t = e.target as HTMLElement
    if (t.closest('button')) return
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    const sx = e.clientX
    const sy = e.clientY
    const base = floatLayout
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    const move = (ev: PointerEvent) => {
      ev.preventDefault()
      setFloatLayout((f) => ({
        ...f,
        x: clamp(base.x + ev.clientX - sx, -f.w + 90, window.innerWidth - 60),
        y: clamp(base.y + ev.clientY - sy, 0, window.innerHeight - 44)
      }))
    }
    const up = (ev: PointerEvent) => {
      try {
        el.releasePointerCapture(ev.pointerId)
      } catch {
        /* ignore */
      }
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  // ---------- 侧栏宽度调节 ----------
  const startResizeDocked = (e: React.PointerEvent) => {
    e.preventDefault()
    const sw = dockedW
    const sx = e.clientX
    const move = (ev: PointerEvent) => {
      setDockedW(clamp(sw + sx - ev.clientX, 260, Math.round(window.innerWidth * 0.6)))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---------- 浮窗大小调节（右下角） ----------
  const startResizeFloat = (e: React.PointerEvent) => {
    e.preventDefault()
    const base = floatLayout
    const sx = e.clientX
    const sy = e.clientY
    const move = (ev: PointerEvent) => {
      setFloatLayout((f) => ({
        ...f,
        w: clamp(base.w + ev.clientX - sx, 260, window.innerWidth - 24),
        h: clamp(base.h + ev.clientY - sy, 320, window.innerHeight - 24)
      }))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  useEffect(() => {
    if (p.staged) {
      setStagedLocal(p.staged)
      p.onConsumeStaged()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.staged])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [p.session?.messages.length, p.session?.messages[p.session.messages.length - 1]?.content])

  const hasKeys =
    !!PROVIDERS.deepseek.getKey(p.settings).trim() ||
    !!PROVIDERS.doubao.getKey(p.settings).trim() ||
    !!PROVIDERS.custom.getKey(p.settings).trim() ||
    !!PROVIDERS.custom2.getKey(p.settings).trim()

  const providerLabel = useCallback(
    (provider: AIProvider | undefined, fallback: string) => {
      if (!provider) return fallback
      return PROVIDERS[provider]?.label(p.settings) ?? fallback
    },
    [p.settings]
  )

  const send = () => {
    const t = text.trim()
    const images = stagedLocal?.image ? [stagedLocal.image] : []
    const extraText = stagedLocal?.text ?? ''
    if (!t && !images.length && !extraText) return
    setStagedLocal(null)
    setText('')
    p.onSend([t, extraText].filter(Boolean).join('\n\n'), images)
  }

  /** 把图片文件附加到输入框（支持：按钮选择 / 粘贴 / 拖拽） */
  const attachFile = (f: File, label: string) => {
    const reader = new FileReader()
    reader.onload = () => {
      setStagedLocal({ image: reader.result as string, label })
    }
    reader.readAsDataURL(f)
  }

  const onFile = (e: React.ChangeEvent<HTMLInputElement>, kind: 'file' | 'cam') => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    attachFile(f, kind === 'cam' ? '拍照' : f.name)
  }

  /** 在输入框内 Ctrl+V 粘贴图片 */
  const onPaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? [])
    const imgItem = items.find((it) => it.type.startsWith('image/'))
    if (imgItem) {
      e.preventDefault()
      const f = imgItem.getAsFile()
      if (f) attachFile(f, '粘贴图片')
    }
  }

  /** 把图片文件拖进面板即附加 */
  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      setDragOver(true)
    }
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f && f.type.startsWith('image/')) attachFile(f, '拖入图片')
  }

  const customWeb = p.settings.customWebUrl?.trim() || ''
  const customName = p.settings.customName?.trim() || '自定义①'
  const custom2Web = p.settings.custom2WebUrl?.trim() || ''
  const custom2Name = p.settings.custom2Name?.trim() || '自定义②'

  const loadWeb = (url: string) => {
    setWebSrc(url)
    setWebReload((n) => n + 1)
    setTab('web')
  }

  // 已知禁止 iframe 内嵌的网站（会显示"拒绝连接"），给出引导面板
  const isKnownBlocked =
    webSrc.startsWith('https://chat.deepseek.com') ||
    webSrc.startsWith('https://www.doubao.com') ||
    webSrc.startsWith('https://doubao.com')
  const webSiteLabel = webSrc.includes('deepseek') ? 'DeepSeek 网页版' : webSrc.includes('doubao') ? '豆包网页版' : '该网站'

  return (
    <div
      className={
        (p.docked ? 'chat-panel docked' : 'chat-panel float') + (dragOver ? ' drop-hover' : '')
      }
      style={
        p.docked
          ? { width: dockedW }
          : { left: floatLayout.x, top: floatLayout.y, width: floatLayout.w, height: floatLayout.h }
      }
      onDragOver={onDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {p.docked && <div className="resize-handle" onPointerDown={startResizeDocked} title="拖动调节宽度" />}

      {/* 标签行：浮窗模式下兼作拖动区；控制按钮并入右侧 */}
      <div className="chat-tabs" onPointerDown={startDrag}>
        {!p.docked && <span className="ct-grip" title="按住拖动窗口">⠿</span>}
        <button className={tab === 'chat' ? 'ct-btn active' : 'ct-btn'} onClick={() => setTab('chat')}>💬 对话</button>
        <button className={tab === 'web' ? 'ct-btn active' : 'ct-btn'} onClick={() => setTab('web')}>🌐 网页版</button>
        {p.busy && <span className="thinking" title="AI 思考中">●</span>}
        <div className="ct-actions">
          <button className="tb-btn" onClick={p.onNew} title="新建对话">✚</button>
          <button className="tb-btn" onClick={p.onToggleDock} title="切换悬浮/分屏">
            {p.docked ? '🪟' : '📐'}
          </button>
          <button className="tb-btn" onClick={p.onOpenSettings} title="设置">⚙️</button>
          <button className="tb-btn" onClick={p.onClose} title="收起">🗕</button>
        </div>
      </div>

      {tab === 'web' ? (
        <div className="web-embed">
          <div className="web-bar">
            <button className="tb-btn act" onClick={() => loadWeb(PROVIDERS.doubao.webUrl(p.settings))}>豆包</button>
            <button className="tb-btn act" onClick={() => loadWeb(PROVIDERS.deepseek.webUrl(p.settings))}>DeepSeek</button>
            {customWeb && (
              <button className="tb-btn act" onClick={() => loadWeb(customWeb)}>{customName}</button>
            )}
            {custom2Web && (
              <button className="tb-btn act" onClick={() => loadWeb(custom2Web)}>{custom2Name}</button>
            )}
            <button className="tb-btn" disabled={!webSrc} onClick={() => setWebReload((n) => n + 1)} title="重新加载">⟳</button>
            <button
              className="tb-btn"
              disabled={!webSrc}
              title="在独立小窗口打开（网站禁止内嵌时的推荐方式）"
              onClick={() => {
                if (webSrc) window.open(webSrc, '_blank', 'width=560,height=800')
              }}
            >
              ⧉ 小窗口
            </button>
            <button
              className="tb-btn"
              disabled={!webSrc}
              title="复制当前地址"
              onClick={() => {
                if (webSrc) void navigator.clipboard?.writeText(webSrc)
              }}
            >
              🔗
            </button>
          </div>
          <div className="web-hint">
            内嵌浏览与 PDF 同屏；若网站禁止内嵌（显示空白）→ 点「⧉ 小窗口」，或鸿蒙平板用系统悬浮窗打开。
          </div>
          {webSrc ? (
            isKnownBlocked ? (
              <div className="web-blocked">
                <p>
                  「{webSiteLabel}」禁止被内嵌显示（网站设置了 X-Frame-Options 限制，任何网页应用都无法绕过，
                  浏览器会显示"拒绝连接"）。推荐以下方式：
                </p>
                <div className="notice-btns">
                  <button className="tb-btn act" onClick={() => window.open(webSrc, '_blank', 'width=560,height=800')}>
                    ⧉ 独立小窗口打开
                  </button>
                  <button className="tb-btn act" onClick={() => void navigator.clipboard?.writeText(webSrc)}>
                    🔗 复制链接
                  </button>
                  <button className="tb-btn act" onClick={p.onOpenSettings}>
                    ⚙️ 配置 API Key（应用内直接提问）
                  </button>
                </div>
              </div>
            ) : (
              <iframe
                key={webSrc + ':' + webReload}
                src={webSrc}
                className="web-frame"
                allow="clipboard-read; clipboard-write; fullscreen; camera; microphone"
              />
            )
          ) : (
            <div className="web-empty">
              点击上方按钮，在此内嵌打开豆包 / DeepSeek / {customName} 网页版，与 PDF 同屏使用。
            </div>
          )}
        </div>
      ) : (
        <>
          {!hasKeys && (
            <div className="chat-notice">
              <div>尚未配置 API Key，应用内 AI 暂不可用。可选：</div>
              <div className="notice-btns">
                <button className="tb-btn act" onClick={() => loadWeb(PROVIDERS.doubao.webUrl(p.settings))}>
                  打开豆包网页版
                </button>
                <button className="tb-btn act" onClick={() => loadWeb(PROVIDERS.deepseek.webUrl(p.settings))}>
                  打开 DeepSeek 网页版
                </button>
                <button className="tb-btn act" onClick={p.onOpenSettings}>去设置 Key</button>
              </div>
            </div>
          )}

          <div className="chat-list" ref={listRef}>
            {!p.session || p.session.messages.length === 0 ? (
              <div className="chat-empty">
                可以向 AI 提问：文字、图片（截图/框选/拍照/相册）。
                <br />
                在 PDF 里点「截图发AI」「框选发AI」「本页文字发AI」即可直接带上下文提问。
              </div>
            ) : (
              p.session.messages.map((m) => (
                <div key={m.id} className={`msg ${m.role}`}>
                  {m.role === 'user' ? (
                    <>
                      {m.images && m.images.length > 0 && (
                        <div className="msg-imgs">
                          {m.images.map((img, i) => (
                            <img key={i} src={img} alt="附件" />
                          ))}
                        </div>
                      )}
                      {m.content && <div className="bubble">{m.content}</div>}
                    </>
                  ) : m.role === 'assistant' ? (
                    <div className="bubble md" dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} />
                  ) : (
                    <div className="bubble err">{m.content}</div>
                  )}
                  {m.role === 'assistant' && m.provider && (
                    <div className="msg-meta">
                      {providerLabel(m.provider as AIProvider, m.provider)} · {m.model}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {stagedLocal && (
            <div className="staged">
              <span>{stagedLocal.label ?? '附件'}</span>
              {stagedLocal.image && <img src={stagedLocal.image} alt="待发送" />}
              {stagedLocal.text && <span className="staged-text">（{stagedLocal.text.slice(0, 40)}…）</span>}
              <button className="tb-btn" onClick={() => setStagedLocal(null)}>✕</button>
            </div>
          )}

          <div className="chat-input">
            <div className="input-btns">
              <button className="tb-btn" onClick={() => camRef.current?.click()} title="拍照">📷</button>
              <button className="tb-btn" onClick={() => fileRef.current?.click()} title="相册选图">🖼️</button>
              <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onFile(e, 'cam')} />
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => onFile(e, 'file')} />
            </div>
            <textarea
              value={text}
              placeholder={p.busy ? 'AI 正在回答…' : '输入问题（Enter 发送，Shift+Enter 换行；可 Ctrl+V 粘贴图片）'}
              rows={2}
              disabled={p.busy}
              onChange={(e) => setText(e.target.value)}
              onPaste={onPaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            {p.busy ? (
              <button className="send-btn stop" onClick={p.onStop}>■ 停止</button>
            ) : (
              <button className="send-btn" onClick={send}>发送 ➤</button>
            )}
          </div>
        </>
      )}

      {!p.docked && <div className="resize-corner" onPointerDown={startResizeFloat} title="拖动调整大小" />}
    </div>
  )
}
