// ============ 左侧文件栏（PDF / 白板 / 对话），删除采用"再点一次确认"避免误删 ============
import { useRef, useState } from 'react'
import type { ChatSession, PDFDocMeta, WhiteboardMeta } from '../core/types'

type Tab = 'pdf' | 'board' | 'chat'

interface Props {
  pdfs: PDFDocMeta[]
  boards: WhiteboardMeta[]
  chats: ChatSession[]
  activePdfId: string | null
  activeBoardId: string | null
  activeChatId: string | null
  onImportPDF: (file?: File) => void
  onOpenPDF: (id: string) => void
  onDeletePDF: (id: string) => void
  onNewBoard: () => void
  onOpenBoard: (id: string) => void
  onDeleteBoard: (id: string) => void
  onNewChat: () => void
  onOpenChat: (id: string) => void
  onDeleteChat: (id: string) => void
}

function fmtSize(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

function fmtTime(t: number): string {
  const d = new Date(t)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function FileSidebar(p: Props) {
  const [tab, setTab] = useState<Tab>('pdf')
  const [confirming, setConfirming] = useState<string | null>(null)
  const confirmTimer = useRef<number>(0)
  const fileRef = useRef<HTMLInputElement>(null)

  /** 二次确认删除：第一次点击进入确认态，2.5 秒内再点才真正删除 */
  const handleDelete = (id: string, name: string, fn: () => void) => {
    if (confirming === id) {
      setConfirming(null)
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current)
      fn()
    } else {
      setConfirming(id)
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current)
      confirmTimer.current = window.setTimeout(() => setConfirming(null), 2500)
    }
  }

  const delBtn = (id: string, name: string, fn: () => void) => (
    <button
      className={confirming === id ? 'del-btn confirming' : 'del-btn'}
      onClick={(e) => {
        e.stopPropagation()
        handleDelete(id, name, fn)
      }}
      title={confirming === id ? `再点一次确认删除「${name}」` : `删除「${name}」`}
    >
      {confirming === id ? '确认?' : '🗑'}
    </button>
  )

  return (
    <aside className="sidebar">
      <div className="sidebar-tabs">
        <button className={tab === 'pdf' ? 'st-btn active' : 'st-btn'} onClick={() => setTab('pdf')}>📄 PDF</button>
        <button className={tab === 'board' ? 'st-btn active' : 'st-btn'} onClick={() => setTab('board')}>🎨 白板</button>
        <button className={tab === 'chat' ? 'st-btn active' : 'st-btn'} onClick={() => setTab('chat')}>💬 对话</button>
      </div>

      {tab === 'pdf' && (
        <div className="sidebar-body">
          {/* APK 走原生文件选择器（大文件直存原生）；网页由 App 打开系统文件选择 */}
          <button className="tb-btn act import-btn" onClick={() => p.onImportPDF()}>＋ 导入 PDF</button>
          {/* 网页回退入口：App 在无原生环境时触发根级 file input */}
          <input ref={fileRef} type="file" accept="application/pdf,.pdf" hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) p.onImportPDF(f)
            }} />
          {p.pdfs.length === 0 ? (
            <div className="sidebar-empty">还没有 PDF，点击上方导入</div>
          ) : (
            p.pdfs.map((doc) => (
              <div key={doc.id} className={doc.id === p.activePdfId ? 'file-item active' : 'file-item'} onClick={() => p.onOpenPDF(doc.id)}>
                <div className="file-name">{doc.name}</div>
                <div className="file-meta">{doc.pageCount} 页 · {fmtSize(doc.size)}</div>
                {delBtn(doc.id, doc.name, () => p.onDeletePDF(doc.id))}
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'board' && (
        <div className="sidebar-body">
          <button className="tb-btn act import-btn" onClick={p.onNewBoard}>＋ 新建白板</button>
          {p.boards.length === 0 ? (
            <div className="sidebar-empty">还没有白板，点击上方新建</div>
          ) : (
            p.boards.map((b) => (
              <div key={b.id} className={b.id === p.activeBoardId ? 'file-item active' : 'file-item'} onClick={() => p.onOpenBoard(b.id)}>
                <div className="file-name">{b.name}</div>
                <div className="file-meta">更新于 {fmtTime(b.updatedAt)}</div>
                {delBtn(b.id, b.name, () => p.onDeleteBoard(b.id))}
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'chat' && (
        <div className="sidebar-body">
          <button className="tb-btn act import-btn" onClick={p.onNewChat}>＋ 新建对话</button>
          {p.chats.length === 0 ? (
            <div className="sidebar-empty">还没有对话记录</div>
          ) : (
            p.chats.map((c) => (
              <div key={c.id} className={c.id === p.activeChatId ? 'file-item active' : 'file-item'} onClick={() => p.onOpenChat(c.id)}>
                <div className="file-name">{c.title || '未命名对话'}</div>
                <div className="file-meta">{c.messages.length} 条 · {fmtTime(c.updatedAt)}</div>
                {delBtn(c.id, c.title || '该对话', () => p.onDeleteChat(c.id))}
              </div>
            ))
          )}
        </div>
      )}
    </aside>
  )
}
