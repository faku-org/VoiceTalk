import type { Database } from 'bun:sqlite'
import { EmbedderUnavailableError } from '@wefaber/embed'
import { watch, type FSWatcher } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { Allowlist } from '../codemode/allowlist.ts'
import type { Embedder } from '../rag/embedder.ts'
import { toBlob, type VectorStore } from '../rag/store.ts'
import { chunkMarkdown, type ChunkOptions } from './chunker.ts'

export { chunkMarkdown, estimateTokens, splitSections } from './chunker.ts'
export type { Chunk, ChunkOptions } from './chunker.ts'

/** Text and markdown only for now (ADR 0006). */
export const INGEST_EXTENSIONS = new Set(['.md', '.markdown', '.txt'])
/** Larger files are skipped: they are exports or logs, not notes. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024

export interface IngestStatus {
  folders: { path: string; exists: boolean }[]
  documents: number
  chunks: number
  scanning: boolean
  lastScanAt: number | null
  lastScanMs: number | null
  /** Files of the last scan that could not be indexed (they are retried on the next scan). */
  failed: number
  lastError: string | null
  /** Result of the last embedder call: `null` before any call. */
  embedderUp: boolean | null
}

export interface ScanReport {
  seen: number
  indexed: number
  unchanged: number
  removed: number
  failed: number
  skipped: number
}

interface DocRow {
  id: number
  path: string
  mtime: number
  size: number
  hash: string
}

export interface IngesterDeps {
  db: Database
  store: VectorStore
  embedder: Embedder
  allowlist: Allowlist
  chunk?: ChunkOptions
  /** Debounce of watcher events. Default 1000 ms. */
  debounceMs?: number
  /** Full rescan period while watching, as a fallback for missed events. Default 5 min. */
  rescanMs?: number
}

const sha256 = (bytes: Uint8Array) =>
  new Bun.CryptoHasher('sha256').update(bytes).digest('hex')

export class Ingester {
  readonly #d: IngesterDeps
  #scanning: Promise<ScanReport> | null = null
  #again = false
  #lastScanAt: number | null = null
  #lastScanMs: number | null = null
  #failed = 0
  #lastError: string | null = null
  #embedderUp: boolean | null = null
  #watchers: FSWatcher[] = []
  #debounce: ReturnType<typeof setTimeout> | null = null
  #interval: ReturnType<typeof setInterval> | null = null

  constructor(deps: IngesterDeps) {
    this.#d = deps
  }

  status(): IngestStatus {
    const count = (sql: string) =>
      this.#d.db.query<{ n: number }, []>(sql).get()?.n ?? 0
    return {
      folders: this.#d.allowlist.roots.map((r) => ({
        path: r.configured,
        exists: r.real !== null,
      })),
      documents: count('SELECT COUNT(*) AS n FROM documents'),
      chunks: count('SELECT COUNT(*) AS n FROM chunks'),
      scanning: this.#scanning !== null,
      lastScanAt: this.#lastScanAt,
      lastScanMs: this.#lastScanMs,
      failed: this.#failed,
      lastError: this.#lastError,
      embedderUp: this.#embedderUp,
    }
  }

  /** Runs one incremental scan. Calls during a scan coalesce into one follow-up scan. */
  scan(): Promise<ScanReport> {
    if (this.#scanning) {
      this.#again = true
      return this.#scanning
    }
    const run = async (): Promise<ScanReport> => {
      let report: ScanReport
      do {
        this.#again = false
        report = await this.#scanOnce()
      } while (this.#again)
      return report
    }
    this.#scanning = run().finally(() => {
      this.#scanning = null
    })
    return this.#scanning
  }

  /** Initial scan, then recursive watchers on every existing folder plus a periodic rescan. */
  start(): void {
    void this.scan().catch(() => {})
    const kick = () => {
      if (this.#debounce) clearTimeout(this.#debounce)
      this.#debounce = setTimeout(() => {
        void this.scan().catch(() => {})
      }, this.#d.debounceMs ?? 1000)
    }
    for (const root of this.#d.allowlist.roots) {
      if (!root.real) continue
      try {
        this.#watchers.push(watch(root.real, { recursive: true }, kick))
      } catch (err) {
        this.#lastError = `watch failed for ${root.configured}: ${(err as Error).message}`
      }
    }
    this.#interval = setInterval(kick, this.#d.rescanMs ?? 5 * 60_000)
  }

  stop(): void {
    for (const w of this.#watchers) w.close()
    this.#watchers = []
    if (this.#debounce) clearTimeout(this.#debounce)
    if (this.#interval) clearInterval(this.#interval)
    this.#debounce = this.#interval = null
  }

  async #scanOnce(): Promise<ScanReport> {
    const t0 = performance.now()
    const { db, store, allowlist } = this.#d
    const report: ScanReport = {
      seen: 0,
      indexed: 0,
      unchanged: 0,
      removed: 0,
      failed: 0,
      skipped: 0,
    }
    this.#lastError = null
    const known = new Map<string, DocRow>()
    for (const row of db
      .query<DocRow, []>('SELECT id, path, mtime, size, hash FROM documents')
      .all())
      known.set(row.path, row)

    const seen = new Set<string>()
    let embedderDown = false
    for (const root of allowlist.roots) {
      if (!root.real) continue
      for await (const file of walk(root.real)) {
        // Junctions and symlinks are not followed by `walk`; this re-checks the resolved path anyway.
        const real = await allowlist.resolve(file).catch(() => null)
        if (!real) {
          report.skipped++
          continue
        }
        seen.add(real)
        report.seen++
        if (embedderDown) continue
        try {
          const outcome = await this.#indexFile(real, known.get(real))
          report[outcome]++
        } catch (err) {
          report.failed++
          this.#lastError = `${real}: ${(err as Error).message}`
          if (err instanceof EmbedderUnavailableError) {
            this.#embedderUp = false
            embedderDown = true
          }
        }
      }
    }

    // A document disappears when its file is gone. A configured folder that is missing right now (unplugged
    // drive) keeps its documents; a folder removed from the allowlist does not.
    const missingRoots = allowlist.roots
      .filter((r) => r.real === null)
      .map((r) => r.configured)
    for (const [path, row] of known) {
      if (seen.has(path)) continue
      if (missingRoots.some((m) => allowlist.isInside(m, path))) continue
      db.run('DELETE FROM documents WHERE id = ?', [row.id])
      store.removeDoc(row.id)
      report.removed++
    }

    this.#failed = report.failed
    this.#lastScanAt = Date.now()
    this.#lastScanMs = Math.round(performance.now() - t0)
    return report
  }

  async #indexFile(
    path: string,
    prev: DocRow | undefined,
  ): Promise<'indexed' | 'unchanged' | 'skipped'> {
    const { db, store, embedder } = this.#d
    const st = await stat(path)
    if (st.size > MAX_FILE_BYTES) return 'skipped'
    const mtime = Math.floor(st.mtimeMs)
    if (prev && prev.mtime === mtime && prev.size === st.size)
      return 'unchanged'
    const bytes = new Uint8Array(await readFile(path))
    const hash = sha256(bytes)
    if (prev && prev.hash === hash) {
      db.run('UPDATE documents SET mtime = ?, size = ? WHERE id = ?', [
        mtime,
        st.size,
        prev.id,
      ])
      return 'unchanged'
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    if (text.includes('\u0000')) return 'skipped'
    const chunks = chunkMarkdown(text, this.#d.chunk)
    const vectors = chunks.length ? await embedder.embedDocuments(chunks) : []
    this.#embedderUp = chunks.length ? true : this.#embedderUp

    const now = Date.now()
    const insert = db.query<
      { id: number },
      [number, number, string, number, string, Uint8Array]
    >(
      'INSERT INTO chunks (doc_id, ord, heading, start_line, text, embedding) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    )
    const items = db.transaction(() => {
      const doc = db
        .query<{ id: number }, [string, number, number, string, number]>(
          `INSERT INTO documents (path, mtime, size, hash, indexed_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size,
             hash = excluded.hash, indexed_at = excluded.indexed_at
           RETURNING id`,
        )
        .get(path, mtime, st.size, hash, now)!
      db.run('DELETE FROM chunks WHERE doc_id = ?', [doc.id])
      return chunks.map((c, i) => {
        const vector = vectors[i]!
        const row = insert.get(
          doc.id,
          i,
          c.heading,
          c.startLine,
          c.text,
          toBlob(vector),
        )!
        return { chunkId: row.id, docId: doc.id, vector }
      })
    })()
    const docId = items[0]?.docId ?? prev?.id
    if (docId !== undefined) store.replaceDoc(docId, items)
    return 'indexed'
  }
}

/** Ingestable files under `dir`. Dot-folders and links are skipped. */
async function* walk(dir: string): AsyncGenerator<string> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      yield* walk(full)
    } else if (
      e.isFile() &&
      INGEST_EXTENSIONS.has(extname(e.name).toLowerCase())
    )
      yield full
  }
}
