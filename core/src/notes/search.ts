import type { Embedder } from '../rag/index.ts'
import { BruteForceVectorStore, type VectorStore } from '../rag/index.ts'
import type { NoteRepo } from './repo.ts'
import type { Note, NoteKind } from './types.ts'

export interface NoteHit {
  /** Note id as text (stable across the Code Mode boundary). */
  id: string
  kind: NoteKind
  sessionId: string | null
  createdAt: number
  text: string
  score: number
}

export interface SearchOptions {
  kinds?: NoteKind[]
  /** Hits scoring below are dropped. */
  minScore?: number
  /** Notes of this session are skipped (recall looks at earlier conversations). */
  excludeSession?: string
}

/** Cosine search over note embeddings. Same embedder as the document RAG (ADR 0006). */
export interface NoteSearch {
  /** Adds a freshly written note to the index (no-op without a vector). */
  index(note: Note): void
  search(q: string, k?: number, opts?: SearchOptions): Promise<NoteHit[]>
}

const ALL: NoteKind[] = ['internal', 'external']
const TOKEN = /[\p{L}\p{N}]{3,}/gu

const tokens = (text: string): Set<string> =>
  new Set(text.toLowerCase().match(TOKEN) ?? [])

/** Share of the query words found in the note. Used only when a note has no vector or the embedder is down. */
function lexicalScore(query: Set<string>, body: string): number {
  if (query.size === 0) return 0
  const have = tokens(body)
  let hit = 0
  for (const t of query) if (have.has(t)) hit++
  return hit / query.size
}

export function createNoteSearch(deps: {
  notes: NoteRepo
  embedder: Embedder
  store?: VectorStore
}): NoteSearch {
  const store = deps.store ?? new BruteForceVectorStore()
  for (const n of deps.notes.all(ALL))
    if (n.embedding)
      store.replaceDoc(n.id, [
        { chunkId: n.id, docId: n.id, vector: n.embedding },
      ])

  const hit = (n: Note, score: number): NoteHit => ({
    id: String(n.id),
    kind: n.kind,
    sessionId: n.sessionId,
    createdAt: n.createdAt,
    text: n.body,
    score,
  })

  return {
    index(note) {
      if (note.embedding)
        store.replaceDoc(note.id, [
          { chunkId: note.id, docId: note.id, vector: note.embedding },
        ])
    },

    async search(q, k = 5, opts = {}) {
      const query = q.trim()
      if (!query) return []
      const kinds = opts.kinds ?? ALL
      const limit = Math.min(Math.max(1, k), 50)
      const allowed = (n: Note | null): n is Note =>
        n !== null &&
        kinds.includes(n.kind) &&
        n.sessionId !== (opts.excludeSession ?? undefined)

      const out = new Map<number, NoteHit>()
      let semantic = true
      try {
        const vec = await deps.embedder.embedQuery(query)
        // Over-fetch: kind and session filters are applied after the vector search.
        for (const h of store.search(vec, limit * 4 + 20)) {
          const n = deps.notes.get(h.chunkId)
          if (allowed(n)) out.set(n.id, hit(n, h.score))
        }
      } catch {
        semantic = false
      }

      // Notes without a vector (embedder was down at write time), or every note if it is down now.
      const q2 = tokens(query)
      for (const n of deps.notes.all(kinds)) {
        if (!allowed(n) || out.has(n.id)) continue
        if (semantic && n.embedding) continue
        const score = lexicalScore(q2, n.body) * 0.5
        if (score > 0) out.set(n.id, hit(n, score))
      }

      return [...out.values()]
        .filter((h) => h.score >= (opts.minScore ?? 0))
        .sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
        .slice(0, limit)
    },
  }
}
