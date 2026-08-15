// ============ 应用主框架：文件管理 / PDF批注 / 白板 / AI 悬浮分屏 ============
import { useCallback, useEffect, useRef, useState } from 'react'
import * as db from './core/db'
import { DEFAULT_SETTINGS, uid } from './core/types'
import type {
  AISettings,
  ChatMessage,
  ChatSession,
  PDFDocMeta,
  WhiteboardMeta
} from './core/types'
import { runAI } from './core/ai/chat'
import PdfViewer, { type PdfViewerHandle } from './ui/PdfViewer'
import WhiteboardView from './ui/WhiteboardView'
import ChatPanel, { type StagedAttach } from './ui/ChatPanel'
import SettingsModal from './ui/SettingsModal'
import FileSidebar from './ui/FileSidebar'

type View = 'pdf' | 'board' | 'home'

export default function App() {
  const [settings, setSettings] = useState<AISettings>(DEFAULT_SETTINGS)
  const [pdfs, setPdfs] = useState<PDFDocMeta[]>([])
  const [boards, setBoards] = useState<WhiteboardMeta[]>([])
  const [chats, setChats] = useState<ChatSession[]>([])

  const [view, setView] = useState<View>('home')
  const [activePdfId, setActivePdfId] = useState<string | null>(null)
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null)
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatDocked, setChatDocked] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('yuepi.sidebar')
      if (saved !== null) return saved !== '0'
    } catch {
      /* ignore */
    }
    // 宽屏默认展开，窄屏（竖屏）默认收起，但始终可用按钮呼出
    return window.innerWidth > 900
  })
  const [boardOverlayOpen, setBoardOverlayOpen] = useState(false)
  const [topbarOpen, setTopbarOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('yuepi.topbar') !== '0'
    } catch {
      return true
    }
  })
  const [staged, setStaged] = useState<StagedAttach | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [boardPendingImage, setBoardPendingImage] = useState<string | null>(null)
  const [bubblePos, setBubblePos] = useState<{ x: number; y: number } | null>(null)
  /** 当前打开的 PDF（含数据；列表里只有元信息，打开时才加载，避免大文件常驻内存） */
  const [activePdf, setActivePdf] = useState<PDFDocMeta | null>(null)

  const pdfViewerRef = useRef<PdfViewerHandle>(null)
  const abortRef = useRef<AbortController | null>(null)
  const toastTimer = useRef<number>(0)
  const pageSaveTimer = useRef<number>(0)
  const sessionRef = useRef<ChatSession | null>(null)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2800)
  }, [])

  const refreshLists = useCallback(async () => {
    const [ps, bs, cs] = await Promise.all([db.listPDFs(), db.listWhiteboards(), db.listChats()])
    setPdfs(ps)
    setBoards(bs)
    setChats(cs)
  }, [])

  useEffect(() => {
    ;(async () => {
      const s = await db.getSettings()
      // 合并默认值：兼容旧版本存档中缺失的新字段
      if (s) setSettings({ ...DEFAULT_SETTINGS, ...s })
      await refreshLists()
    })()
  }, [refreshLists])

  // ---------- PDF ----------
  const importPDF = useCallback(
    async (file: File) => {
      try {
        // 大文件提示（平板浏览器内存有限）
        if (file.size > 80 * 1024 * 1024) {
          showToast(`文件较大（${Math.round(file.size / 1048576)}MB），平板浏览器内存有限，打开时可能较慢或失败`)
        }
        const raw = await file.arrayBuffer()
        // 导入阶段不解析全文（避免内存峰值），页数在首次打开时回填
        const meta: PDFDocMeta = {
          id: uid(),
          name: file.name,
          addedAt: Date.now(),
          size: raw.byteLength,
          pageCount: 0,
          data: raw
        }
        await db.putPDF(meta)
        await refreshLists()
        setActivePdfId(meta.id)
        setActivePdf(meta)
        setView('pdf')
        showToast(`已导入《${file.name}》（正在解析页数…）`)
      } catch (e) {
        showToast('导入失败：' + (e instanceof Error ? e.message : String(e)))
      }
    },
    [refreshLists, showToast]
  )

  /** 打开文档后回填页数 */
  const handlePagesLoaded = useCallback(async (id: string, count: number) => {
    await db.updatePDFPageCount(id, count)
    setPdfs((list) => list.map((m) => (m.id === id ? { ...m, pageCount: count } : m)))
  }, [])

  /** 防抖保存阅读位置（下次打开恢复到该页） */
  const handlePageChange = useCallback((id: string, page: number) => {
    if (pageSaveTimer.current) window.clearTimeout(pageSaveTimer.current)
    pageSaveTimer.current = window.setTimeout(() => {
      void db.updatePDFLastPage(id, page)
    }, 600)
  }, [])

  const deletePDF = useCallback(
    async (id: string) => {
      try {
        await db.deletePDF(id)
        await refreshLists()
        if (activePdfId === id) {
          setActivePdfId(null)
          setActivePdf(null)
          setView('home')
        }
        showToast('已删除')
      } catch (e) {
        showToast('删除失败：' + (e instanceof Error ? e.message : String(e)))
      }
    },
    [activePdfId, refreshLists, showToast]
  )

  const openPDF = useCallback(
    async (id: string) => {
      try {
        const meta = await db.getPDF(id)
        if (!meta) return
        const data = await db.getPDFData(id)
        if (!data) {
          showToast('文件数据缺失，请重新导入')
          return
        }
        setActivePdf({ ...meta, data })
        setActivePdfId(id)
        setView('pdf')
      } catch (e) {
        showToast('打开失败：' + (e instanceof Error ? e.message : String(e)))
      }
    },
    [showToast]
  )

  // ---------- 白板 ----------
  const newBoard = useCallback(async () => {
    const wb: WhiteboardMeta = {
      id: uid(),
      name: '白板 ' + new Date().toLocaleDateString('zh-CN') + ' ' + new Date().toTimeString().slice(0, 5),
      updatedAt: Date.now(),
      snapshot: null
    }
    await db.putWhiteboard(wb)
    await refreshLists()
    setActiveBoardId(wb.id)
    setView('board')
  }, [refreshLists])

  const saveBoard = useCallback(
    async (boardId: string, snapshot: unknown) => {
      const wb = boards.find((b) => b.id === boardId)
      if (!wb) return
      const updated = { ...wb, snapshot, updatedAt: Date.now() }
      await db.putWhiteboard(updated)
      setBoards((list) => list.map((b) => (b.id === boardId ? updated : b)))
    },
    [boards]
  )

  const deleteBoard = useCallback(
    async (id: string) => {
      try {
        await db.deleteWhiteboard(id)
        await refreshLists()
        if (activeBoardId === id) {
          setActiveBoardId(null)
          setView('home')
        }
        showToast('已删除')
      } catch (e) {
        showToast('删除失败：' + (e instanceof Error ? e.message : String(e)))
      }
    },
    [activeBoardId, refreshLists, showToast]
  )

  const openBoard = useCallback((id: string) => {
    setActiveBoardId(id)
    setView('board')
  }, [])

  // ---------- 对话 / AI ----------
  const ensureSession = useCallback(async (title: string): Promise<ChatSession> => {
    let s = sessionRef.current
    if (!s) {
      s = { id: uid(), title: title || '新对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [] }
      sessionRef.current = s
      await db.putChat(s)
      await refreshLists()
    }
    return s
  }, [refreshLists])

  const newChat = useCallback(async () => {
    const s: ChatSession = {
      id: uid(),
      title: '新对话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    }
    sessionRef.current = s
    setActiveChatId(s.id)
    setChatOpen(true)
    await db.putChat(s)
    await refreshLists()
  }, [refreshLists])

  const openChat = useCallback(async (id: string) => {
    const c = await db.getChat(id)
    if (c) {
      sessionRef.current = c
      setActiveChatId(id)
      setChatOpen(true)
    }
  }, [])

  const deleteChat = useCallback(
    async (id: string) => {
      try {
        await db.deleteChat(id)
        await refreshLists()
        if (activeChatId === id) {
          sessionRef.current = null
          setActiveChatId(null)
          setChatOpen(false)
        }
        showToast('已删除')
      } catch (e) {
        showToast('删除失败：' + (e instanceof Error ? e.message : String(e)))
      }
    },
    [activeChatId, refreshLists, showToast]
  )

  const persistSession = useCallback(async (s: ChatSession) => {
    const updated = { ...s, updatedAt: Date.now() }
    sessionRef.current = updated
    await db.putChat(updated)
    setChats((list) => {
      const rest = list.filter((c) => c.id !== updated.id)
      return [updated, ...rest]
    })
  }, [])

  const askAI = useCallback(
    async (text: string, images: string[]) => {
      if (busy) return
      const session = await ensureSession(text.slice(0, 24) || '图片提问')
      const userMsg: ChatMessage = {
        id: uid(),
        role: 'user',
        content: text,
        images: images.length ? images : undefined,
        time: Date.now()
      }
      session.messages.push(userMsg)
      await persistSession(session)

      const assistantId = uid()
      const asstMsg: ChatMessage = { id: assistantId, role: 'assistant', content: '', time: Date.now() }
      session.messages.push(asstMsg)
      setChats((list) => list.map((c) => (c.id === session.id ? { ...c } : c)))
      setBusy(true)
      const controller = new AbortController()
      abortRef.current = controller

      const patch = (delta: string) => {
        asstMsg.content += delta
        // 触发 UI 更新
        setChats((list) => list.map((c) => (c.id === session.id ? { ...c } : c)))
      }

      try {
        const result = await runAI(settings, session.messages.slice(0, -1), {
          onDelta: patch,
          signal: controller.signal
        })
        asstMsg.provider = result.provider
        asstMsg.model = result.model
        if (!asstMsg.content) asstMsg.content = '（AI 没有返回内容）'
        await persistSession(session)
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          if (!asstMsg.content) session.messages.pop()
          await persistSession(session)
        } else {
          asstMsg.content = ''
          session.messages.pop()
          session.messages.push({
            id: uid(),
            role: 'system',
            content: '⚠️ ' + (e instanceof Error ? e.message : String(e)),
            time: Date.now()
          })
          await persistSession(session)
        }
      } finally {
        setBusy(false)
        abortRef.current = null
      }
    },
    [busy, ensureSession, persistSession, settings]
  )

  const stopAI = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const sendFromChat = useCallback(
    (text: string, images: string[]) => {
      void askAI(text, images)
    },
    [askAI]
  )

  // ---------- 跨模块：把 PDF / 白板内容送入 AI ----------
  const stageImage = useCallback((dataUrl: string, label: string) => {
    setStaged({ image: dataUrl, label })
    setChatOpen(true)
  }, [])

  const stageText = useCallback((text: string, label: string) => {
    setStaged({ text, label })
    setChatOpen(true)
  }, [])

  const askPdfImage = useCallback(
    (dataUrl: string, label: string) => stageImage(dataUrl, label),
    [stageImage]
  )

  const askBoardImage = useCallback(
    (dataUrl: string) => stageImage(dataUrl, '白板截图'),
    [stageImage]
  )

  const pdfToBoard = useCallback(async () => {
    try {
      const shot = await pdfViewerRef.current?.getCurrentPageSnapshot()
      if (!shot) {
        showToast('请先打开一个 PDF')
        return
      }
      const wb: WhiteboardMeta = {
        id: uid(),
        name: `PDF页 ${new Date().toTimeString().slice(0, 5)}`,
        updatedAt: Date.now(),
        snapshot: null
      }
      await db.putWhiteboard(wb)
      await refreshLists()
      setActiveBoardId(wb.id)
      setView('board')
      setBoardPendingImage(shot.dataUrl)
      showToast('已创建白板并放入当前页截图')
    } catch (e) {
      showToast('操作失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }, [refreshLists, showToast])

  // ---------- 布局：侧栏 / 白板叠加 / 顶栏 ----------
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((v) => {
      const nv = !v
      try {
        localStorage.setItem('yuepi.sidebar', nv ? '1' : '0')
      } catch {
        /* ignore */
      }
      return nv
    })
  }, [])

  const toggleTopbar = useCallback(() => {
    setTopbarOpen((v) => {
      const nv = !v
      try {
        localStorage.setItem('yuepi.topbar', nv ? '1' : '0')
      } catch {
        /* ignore */
      }
      return nv
    })
  }, [])

  const toggleBoardOverlay = useCallback(async () => {
    if (boardOverlayOpen) {
      setBoardOverlayOpen(false)
      return
    }
    // 没有可用白板时先自动创建一个
    if (!boards.some((b) => b.id === activeBoardId)) {
      const wb: WhiteboardMeta = {
        id: uid(),
        name: '草稿白板',
        updatedAt: Date.now(),
        snapshot: null
      }
      await db.putWhiteboard(wb)
      await refreshLists()
      setActiveBoardId(wb.id)
    }
    setBoardOverlayOpen(true)
  }, [boardOverlayOpen, boards, activeBoardId, refreshLists])

  // ---------- 设置 ----------
  const saveSettings = useCallback(async (s: AISettings) => {
    setSettings(s)
    await db.putSettings(s)
    showToast('设置已保存')
  }, [showToast])

  const activeBoard = boards.find((b) => b.id === activeBoardId) ?? null
  const activeChat = chats.find((c) => c.id === activeChatId) ?? sessionRef.current ?? null

  // ---------- 悬浮气泡拖动 ----------
  const onBubbleDown = (e: React.PointerEvent) => {
    const startX = e.clientX
    const startY = e.clientY
    const base = bubblePos
    const move = (ev: PointerEvent) => {
      setBubblePos({
        x: (base?.x ?? window.innerWidth - 84) + ev.clientX - startX,
        y: (base?.y ?? window.innerHeight - 120) + ev.clientY - startY
      })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="app">
      {topbarOpen ? (
        <header className="topbar">
          <button className="tb-btn" onClick={toggleSidebar} title="显示/隐藏文件栏">
            {sidebarOpen ? '◀ 收起' : '☰ 文件'}
          </button>
          <span className="logo">✒️ 阅批</span>
          <span className="logo-sub">PDF批注 · 白板 · AI助手</span>
          <div className="topbar-right">
            <button className="tb-btn act" onClick={() => void newBoard()}>🎨 白板</button>
            <button className="tb-btn act" onClick={() => setChatOpen((v) => !v)}>
              {chatOpen ? '🙈 收起AI' : '🤖 AI助手'}
            </button>
            <button className="tb-btn" onClick={() => pdfViewerRef.current?.toggleToolbar()} title="显示/隐藏 PDF 工具栏（画笔/框选等）">📄 ▾</button>
            <button className="tb-btn act" onClick={() => setSettingsOpen(true)}>⚙️ 设置</button>
            <button className="tb-btn" onClick={toggleTopbar} title="收起顶栏">▾</button>
          </div>
        </header>
      ) : (
        <div className="topbar-mini">
          <button className="tb-btn" onClick={toggleTopbar} title="显示顶栏">✒️ ▴</button>
          <button className="tb-btn" onClick={toggleSidebar} title="显示/隐藏文件栏">☰</button>
          <button className="tb-btn act" onClick={() => setChatOpen((v) => !v)} title="AI 助手">
            {chatOpen ? '🙈' : '🤖'}
          </button>
        </div>
      )}

      <div className="main">
        {sidebarOpen && (
          <FileSidebar
            pdfs={pdfs}
            boards={boards}
            chats={chats}
            activePdfId={activePdfId}
            activeBoardId={activeBoardId}
            activeChatId={activeChatId}
            onImportPDF={(f) => void importPDF(f)}
            onOpenPDF={openPDF}
            onDeletePDF={(id) => void deletePDF(id)}
            onNewBoard={() => void newBoard()}
            onOpenBoard={openBoard}
            onDeleteBoard={(id) => void deleteBoard(id)}
            onNewChat={() => void newChat()}
            onOpenChat={(id) => void openChat(id)}
            onDeleteChat={(id) => void deleteChat(id)}
          />
        )}

        <div className="content">
          {view === 'pdf' && activePdf ? (
            <>
              <PdfViewer
                key={activePdf.id}
                ref={pdfViewerRef}
                meta={activePdf}
                onToast={showToast}
                onAskImage={askPdfImage}
                onAskText={stageText}
                onToBoard={() => void pdfToBoard()}
                boardOverlayOpen={boardOverlayOpen}
                onToggleBoard={() => void toggleBoardOverlay()}
                onPagesLoaded={(count) => void handlePagesLoaded(activePdf.id, count)}
                onPageChange={(page) => handlePageChange(activePdf.id, page)}
              />
              {boardOverlayOpen && activeBoard && (
                <div className="board-overlay">
                  <div className="board-overlay-header">
                    <span className="board-name">🧻 {activeBoard.name}</span>
                    <span className="board-hint">叠加在 PDF 上的草稿白板（半透明，可透出下方页面）</span>
                    <button className="tb-btn" onClick={() => setBoardOverlayOpen(false)}>✕ 隐藏白板</button>
                  </div>
                  <div className="board-overlay-canvas">
                    <WhiteboardView
                      key={activeBoard.id}
                      board={activeBoard}
                      pendingImage={null}
                      onConsumePendingImage={() => {}}
                      onSave={(id, snap) => void saveBoard(id, snap)}
                      onAskImage={askBoardImage}
                      onToast={showToast}
                    />
                  </div>
                </div>
              )}
            </>
          ) : view === 'board' && activeBoard ? (
            <WhiteboardView
              key={activeBoard.id}
              board={activeBoard}
              pendingImage={boardPendingImage}
              onConsumePendingImage={() => setBoardPendingImage(null)}
              onSave={(id, snap) => void saveBoard(id, snap)}
              onAskImage={askBoardImage}
              onToast={showToast}
            />
          ) : (
            <HomeView
              onImport={() => document.getElementById('pdf-file-input')?.click()}
              onNewBoard={() => void newBoard()}
            />
          )}
        </div>

        {chatOpen && (
          <ChatPanel
            session={activeChat}
            settings={settings}
            busy={busy}
            docked={chatDocked}
            staged={staged}
            onConsumeStaged={() => setStaged(null)}
            onSend={sendFromChat}
            onStop={stopAI}
            onToggleDock={() => setChatDocked((d) => !d)}
            onClose={() => setChatOpen(false)}
            onNew={() => void newChat()}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}
      </div>

      {!chatOpen && (
        <div
          className="ai-bubble"
          style={bubblePos ? { left: bubblePos.x, top: bubblePos.y } : undefined}
          onPointerDown={onBubbleDown}
          onClick={() => setChatOpen(true)}
          title="AI 助手（可拖动）"
        >
          🤖
        </div>
      )}

      {settingsOpen && (
        <SettingsModal settings={settings} onSave={(s) => void saveSettings(s)} onClose={() => setSettingsOpen(false)} onToast={showToast} />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function HomeView({ onImport, onNewBoard }: { onImport: () => void; onNewBoard: () => void }) {
  return (
    <div className="home">
      <div className="home-card">
        <h2>开始使用</h2>
        <p>① 左侧「PDF」标签导入文档 → 用触控笔/手指直接批注；</p>
        <p>② 「白板」= 无限草稿纸，随时演算；</p>
        <p>③ 点「AI助手」→ 文字/图片提问（豆包·DeepSeek），可悬浮或分屏；</p>
        <p>④ 无 API Key 也能用：AI 面板里点「打开豆包/DeepSeek 网页版」。</p>
        <div className="home-btns">
          <button className="send-btn" onClick={onImport}>📄 导入 PDF</button>
          <button className="send-btn" onClick={onNewBoard}>🎨 新建白板</button>
        </div>
      </div>
    </div>
  )
}
