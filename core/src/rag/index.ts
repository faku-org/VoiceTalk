import type { Database } from 'bun:sqlite'
import type { Embedder } from './embedder.ts'
import { fromBlob, type VectorStore } from './store.ts'

export {
  BruteForceVectorStore,
  fromBlob,
  toBlob,
  type VectorHit,
  type VectorItem,
  type VectorStore,
} from './store.ts'
export { GemmaEmbedder, type DocInput, type Embedder } from './embedder.ts'

export interface DocHit {
  path: string
  heading: string
  /** 1-based line of the chunk start, for citations (`path:line`). */
  line: number
  score: number
  text: string
}

/** Loads every stored chunk embedding into `store` (startup). */
export function hydrateStore(db: Database, store: VectorStore): void {
  const rows = db
    .query<{ id: number; doc_id: number; embedding: Uint8Array }, []>(
      'SELECT id, doc_id, embedding FROM chunks ORDER BY doc_id, ord',
    )
    .all()
  const byDoc = new Map<
    number,
    { chunkId: number; docId: number; vector: Float32Array }[]
  >()
  for (const r of rows) {
    const list = byDoc.get(r.doc_id) ?? []
    list.push({ chunkId: r.id, docId: r.doc_id, vector: fromBlob(r.embedding) })
    byDoc.set(r.doc_id, list)
  }
  for (const [docId, items] of byDoc) store.replaceDoc(docId, items)
}

export interface Retriever {
  search(q: string, k?: number): Promise<DocHit[]>
}

export function createRetriever(deps: {
  db: Database
  store: VectorStore
  embedder: Embedder
}): Retriever {
  const chunk = deps.db.query<
    { path: string; heading: string; start_line: number; text: string },
    [number]
  >(
    `SELECT d.path, c.heading, c.start_line, c.text
       FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE c.id = ?`,
  )
  return {
    async search(q, k = 5) {
      const query = q.trim()
      if (!query) return []
      const vec = await deps.embedder.embedQuery(query)
      const hits = deps.store.search(vec, Math.min(Math.max(1, k), 50))
      const out: DocHit[] = []
      for (const h of hits) {
        const row = chunk.get(h.chunkId)
        if (!row) continue
        out.push({
          path: row.path,
          heading: row.heading,
          line: row.start_line,
          score: h.score,
          text: row.text,
        })
      }
      return out
    },
  }
}
