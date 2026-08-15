// ============ IndexedDB 存储层（全部数据存本机，不联网） ============
import { openDB, type IDBPDatabase } from 'idb'
import type {
  PDFDocMeta,
  PageAnnotation,
  WhiteboardMeta,
  ChatSession,
  AISettings
} from './types'

const DB_NAME = 'yuepi'
const DB_VERSION = 1

export interface AnnoKey {
  pdfId: string
  page: number
}

let dbPromise: Promise<IDBPDatabase> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('pdfs')) {
          db.createObjectStore('pdfs', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('annotations')) {
          const s = db.createObjectStore('annotations', { keyPath: 'key' })
          s.createIndex('pdfId', 'pdfId')
        }
        if (!db.objectStoreNames.contains('whiteboards')) {
          db.createObjectStore('whiteboards', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('chats')) {
          db.createObjectStore('chats', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' })
        }
      }
    })
  }
  return dbPromise
}

// ---------- PDF ----------
export async function putPDF(doc: PDFDocMeta): Promise<void> {
  const db = await getDB()
  await db.put('pdfs', doc)
}

/** 元信息（不含 data，避免大文件常驻内存） */
function stripData(doc: PDFDocMeta): PDFDocMeta {
  const { data: _data, ...rest } = doc
  return rest
}

export async function getPDF(id: string): Promise<PDFDocMeta | undefined> {
  const db = await getDB()
  const row = (await db.get('pdfs', id)) as PDFDocMeta | undefined
  return row ? stripData(row) : undefined
}

/** 读取 PDF 原始字节（打开文档时调用） */
export async function getPDFData(id: string): Promise<ArrayBuffer | undefined> {
  const db = await getDB()
  const row = (await db.get('pdfs', id)) as PDFDocMeta | undefined
  return row?.data
}

/** 打开文档后回填页数（导入时不再解析，页数在首次打开时补全，减少大文件导入内存峰值） */
export async function updatePDFPageCount(id: string, pageCount: number): Promise<void> {
  const db = await getDB()
  const row = (await db.get('pdfs', id)) as PDFDocMeta | undefined
  if (row && row.pageCount !== pageCount) {
    await db.put('pdfs', { ...row, pageCount })
  }
}

/** 保存阅读位置（下次打开恢复到该页） */
export async function updatePDFLastPage(id: string, lastPage: number): Promise<void> {
  const db = await getDB()
  const row = (await db.get('pdfs', id)) as PDFDocMeta | undefined
  if (row && row.lastPage !== lastPage) {
    await db.put('pdfs', { ...row, lastPage })
  }
}

export async function listPDFs(): Promise<PDFDocMeta[]> {
  const db = await getDB()
  const all = (await db.getAll('pdfs')) as PDFDocMeta[]
  return all.map(stripData).sort((a, b) => b.addedAt - a.addedAt)
}

export async function deletePDF(id: string): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(['pdfs', 'annotations'], 'readwrite')
  await tx.objectStore('pdfs').delete(id)
  // 级联删除该 PDF 的所有批注（注意：value 游标才支持 cursor.delete()，key 游标会报错）
  const annStore = tx.objectStore('annotations')
  const idx = annStore.index('pdfId')
  let cursor = await idx.openCursor(id)
  while (cursor) {
    await cursor.delete()
    cursor = await cursor.continue()
  }
  await tx.done
}

// ---------- 批注 ----------
export async function putAnnotations(
  pdfId: string,
  page: number,
  ann: PageAnnotation
): Promise<void> {
  const db = await getDB()
  await db.put('annotations', { key: `${pdfId}:${page}`, pdfId, page, ann })
}

export async function getAnnotations(
  pdfId: string,
  page: number
): Promise<PageAnnotation | undefined> {
  const db = await getDB()
  const row = await db.get('annotations', `${pdfId}:${page}`)
  return row ? (row.ann as PageAnnotation) : undefined
}

export async function getAnnotationsAll(pdfId: string): Promise<PageAnnotation[]> {
  const db = await getDB()
  const rows = await db.getAllFromIndex('annotations', 'pdfId', pdfId)
  return rows
    .sort((a, b) => a.page - b.page)
    .map((r) => r.ann as PageAnnotation)
}

// ---------- 白板 ----------
export async function putWhiteboard(wb: WhiteboardMeta): Promise<void> {
  const db = await getDB()
  await db.put('whiteboards', wb)
}

export async function getWhiteboard(id: string): Promise<WhiteboardMeta | undefined> {
  const db = await getDB()
  return (await db.get('whiteboards', id)) as WhiteboardMeta | undefined
}

export async function listWhiteboards(): Promise<WhiteboardMeta[]> {
  const db = await getDB()
  const all = (await db.getAll('whiteboards')) as WhiteboardMeta[]
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function deleteWhiteboard(id: string): Promise<void> {
  const db = await getDB()
  await db.delete('whiteboards', id)
}

// ---------- 聊天 ----------
export async function putChat(chat: ChatSession): Promise<void> {
  const db = await getDB()
  await db.put('chats', chat)
}

export async function getChat(id: string): Promise<ChatSession | undefined> {
  const db = await getDB()
  return (await db.get('chats', id)) as ChatSession | undefined
}

export async function listChats(): Promise<ChatSession[]> {
  const db = await getDB()
  const all = (await db.getAll('chats')) as ChatSession[]
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function deleteChat(id: string): Promise<void> {
  const db = await getDB()
  await db.delete('chats', id)
}

// ---------- 设置 ----------
export async function getSettings(): Promise<AISettings | undefined> {
  const db = await getDB()
  const row = await db.get('settings', 'ai')
  return row ? (row.value as AISettings) : undefined
}

export async function putSettings(s: AISettings): Promise<void> {
  const db = await getDB()
  await db.put('settings', { key: 'ai', value: s })
}
