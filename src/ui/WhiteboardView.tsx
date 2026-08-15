// ============ 白板 / 草稿纸（tldraw 无限画布） ============
import { useEffect, useRef, useState } from 'react'
import { Tldraw, useEditor, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'
import { blobToDataURL } from '../core/download'
import type { WhiteboardMeta } from '../core/types'

interface Props {
  board: WhiteboardMeta
  pendingImage: string | null
  onConsumePendingImage: () => void
  onSave: (boardId: string, snapshot: unknown) => void
  onAskImage: (dataUrl: string) => void
  onToast: (msg: string) => void
}

interface BridgeProps {
  board: WhiteboardMeta
  pendingImage: string | null
  onConsumePendingImage: () => void
  onSave: (boardId: string, snapshot: unknown) => void
  onEditor: (e: Editor) => void
}

function EditorBridge({
  board,
  pendingImage,
  onConsumePendingImage,
  onSave,
  onEditor
}: BridgeProps) {
  const editor = useEditor()
  const loadedRef = useRef(false)
  const timerRef = useRef<number>(0)

  useEffect(() => {
    onEditor(editor)
    loadedRef.current = false
    const snap = board.snapshot as { document?: unknown } | null
    if (snap && snap.document) {
      try {
        ;(editor as any).loadSnapshot(snap)
      } catch (e) {
        console.warn('白板快照加载失败', e)
      }
    }
    loadedRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.id])

  useEffect(() => {
    const un = editor.store.listen(() => {
      if (!loadedRef.current) return
      if (timerRef.current) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        onSave(board.id, (editor as any).getSnapshot())
      }, 800)
    })
    return () => {
      un()
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.id, editor])

  useEffect(() => {
    if (!pendingImage) return
    ;(async () => {
      try {
        // 用 tldraw 官方入口插入图片：自动创建资源与形状，正确处理尺寸/校验/居中
        const blob = await (await fetch(pendingImage)).blob()
        const file = new File([blob], 'pdf页截图.png', { type: 'image/png' })
        await editor.putExternalContent({ type: 'files', files: [file], ignoreParent: false })
      } catch (e) {
        console.warn('插入图片失败', e)
      }
      onConsumePendingImage()
    })()
  }, [pendingImage, editor, onConsumePendingImage])

  return null
}

export async function captureBoard(editor: Editor | null): Promise<string> {
  if (!editor) throw new Error('白板尚未就绪')
  const shapes = editor.getCurrentPageShapes()
  if (!shapes.length) throw new Error('白板是空的，先写点内容再截图')
  const anyE = editor as unknown as {
    toImage?: (o: { format: string; scale: number; background: string }) => Promise<Blob>
  }
  try {
    if (typeof anyE.toImage === 'function') {
      const blob = await anyE.toImage({ format: 'png', scale: 1, background: '#ffffff' })
      return blobToDataURL(blob)
    }
  } catch {
    /* 继续走备用方案 */
  }
  const svg = await editor.getSvg(shapes)
  if (!svg) throw new Error('白板截图失败')
  const rect = svg.getBoundingClientRect()
  const xml = new XMLSerializer().serializeToString(svg)
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }))
  return new Promise<string>((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = Math.max(1, img.naturalWidth || Math.ceil(rect.width))
      c.height = Math.max(1, img.naturalHeight || Math.ceil(rect.height))
      c.getContext('2d')!.drawImage(img, 0, 0)
      URL.revokeObjectURL(url)
      resolve(c.toDataURL('image/png'))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('白板截图渲染失败'))
    }
    img.src = url
  })
}

export default function WhiteboardView({
  board,
  pendingImage,
  onConsumePendingImage,
  onSave,
  onAskImage,
  onToast
}: Props) {
  const editorRef = useRef<Editor | null>(null)
  const [ready, setReady] = useState(false)

  const handleAskImage = async () => {
    try {
      const dataUrl = await captureBoard(editorRef.current)
      onAskImage(dataUrl)
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="board-view">
      <div className="board-toolbar">
        <span className="board-name" title={board.name}>{board.name}</span>
        <span className="board-hint">画笔 / 荧光笔 / 橡皮 / 文字 / 插入图片 都在右侧工具栏</span>
        <button className="tb-btn act" onClick={() => void handleAskImage()} disabled={!ready}>🖼️ 白板截图发AI</button>
      </div>
      <div className="board-canvas">
        <Tldraw>
          <EditorBridge
            board={board}
            pendingImage={pendingImage}
            onConsumePendingImage={onConsumePendingImage}
            onSave={onSave}
            onEditor={(e) => {
              editorRef.current = e
              setReady(true)
            }}
          />
        </Tldraw>
      </div>
    </div>
  )
}
