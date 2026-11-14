import { Type } from '@sinclair/typebox'
import { createRegistry, defineOp, OpError } from '@wefaber/codemode'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { INGEST_EXTENSIONS } from '../ingest/index.ts'
import type { NoteSearch } from '../notes/search.ts'
import type { Retriever } from '../rag/index.ts'
import type { Allowlist } from './allowlist.ts'

/** What the ops can reach. No database handle, no writer, no process API: read-only by construction. */
export interface CodemodeCtx {
  allowlist: Allowlist
  retriever: Retriever
  notes: NoteSearch
}

export const PRODUCT = 'voicetalk'
export const API_VERSION = '0.1.0'
export const SCOPES = ['voicetalk:read'] as const

const MAX_READ_CHARS = 32 * 1024
const MAX_LIST = 500
const MAX_SEARCH_FILES = 5000
const MAX_SEARCH_BYTES = 2 * 1024 * 1024
const READ_EXCEPTION =
  'Read-only filesystem verb mirroring the Code Mode prompt (fs.read/fs.stat); no effects'

const Entry = Type.Object({
  name: Type.String(),
  path: Type.String(),
  type: Type.Union([
    Type.Literal('file'),
    Type.Literal('dir'),
    Type.Literal('link'),
    Type.Literal('other'),
  ]),
  size: Type.Number(),
  mtime: Type.Number(),
})

const Stat = Type.Object({
  path: Type.String(),
  type: Type.Union([
    Type.Literal('file'),
    Type.Literal('dir'),
    Type.Literal('other'),
  ]),
  size: Type.Number(),
  mtime: Type.Number(),
})

const Hit = Type.Object({
  path: Type.String(),
  heading: Type.String(),
  line: Type.Number(),
  score: Type.Number(),
  text: Type.String(),
})

const kind = (s: {
  isFile(): boolean
  isDirectory(): boolean
}): 'file' | 'dir' | 'other' =>
  s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other'

function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

const fsList = defineOp({
  id: 'voicetalk.fs.list',
  scope: 'voicetalk:read',
  summary:
    'List a folder inside the allowlist. Without path, lists the allowlisted folders themselves.',
  input: Type.Object({ path: Type.Optional(Type.String()) }),
  output: Type.Object({
    path: Type.String(),
    entries: Type.Array(Entry),
    truncated: Type.Boolean(),
  }),
  handler: async (ctx: CodemodeCtx, input) => {
    if (input.path === undefined) {
      const entries = []
      for (const r of ctx.allowlist.roots) {
        if (!r.real) continue
        const s = await stat(r.real)
        entries.push({
          name: r.real,
          path: r.real,
          type: 'dir' as const,
          size: 0,
          mtime: Math.floor(s.mtimeMs),
        })
      }
      return { path: '', entries, truncated: false }
    }
    const dir = await ctx.allowlist.resolve(input.path)
    const s = await stat(dir)
    if (!s.isDirectory())
      throw new OpError('VALIDATION', `${input.path} is not a folder`)
    const dirents = await readdir(dir, { withFileTypes: true })
    dirents.sort(
      (a, b) =>
        Number(b.isDirectory()) - Number(a.isDirectory()) ||
        a.name.localeCompare(b.name),
    )
    const entries = []
    for (const d of dirents.slice(0, MAX_LIST)) {
      const full = join(dir, d.name)
      if (d.isSymbolicLink()) {
        // Listed so the agent sees it exists; reading it goes through resolve(), which checks the target.
        entries.push({
          name: d.name,
          path: full,
          type: 'link' as const,
          size: 0,
          mtime: 0,
        })
        continue
      }
      const st = await stat(full).catch(() => null)
      entries.push({
        name: d.name,
        path: full,
        type: st ? kind(st) : ('other' as const),
        size: st?.isFile() ? st.size : 0,
        mtime: st ? Math.floor(st.mtimeMs) : 0,
      })
    }
    return { path: dir, entries, truncated: dirents.length > MAX_LIST }
  },
})

const fsRead = defineOp({
  id: 'voicetalk.fs.read',
  scope: 'voicetalk:read',
  summary: `Read a text file inside the allowlist. Lines are 1-based; at most ${MAX_READ_CHARS} characters per call.`,
  verbException: READ_EXCEPTION,
  input: Type.Object({
    path: Type.String(),
    fromLine: Type.Optional(Type.Integer({ minimum: 1 })),
    lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
  }),
  output: Type.Object({
    path: Type.String(),
    text: Type.String(),
    fromLine: Type.Number(),
    totalLines: Type.Number(),
    truncated: Type.Boolean(),
  }),
  handler: async (ctx: CodemodeCtx, input) => {
    const file = await ctx.allowlist.resolve(input.path)
    const s = await stat(file)
    if (!s.isFile())
      throw new OpError('VALIDATION', `${input.path} is not a file`)
    if (s.size > MAX_SEARCH_BYTES)
      throw new OpError('LIMIT_REACHED', `${input.path} is larger than 2 MB`)
    const buf = new Uint8Array(await readFile(file))
    if (looksBinary(buf))
      throw new OpError('VALIDATION', `${input.path} is not a text file`)
    const all = new TextDecoder()
      .decode(buf)
      .replace(/\r\n?/g, '\n')
      .split('\n')
    const from = input.fromLine ?? 1
    const picked = all.slice(
      from - 1,
      input.lines ? from - 1 + input.lines : undefined,
    )
    let text = picked.join('\n')
    let truncated = from - 1 + picked.length < all.length
    if (text.length > MAX_READ_CHARS) {
      text = text.slice(0, MAX_READ_CHARS)
      truncated = true
    }
    return {
      path: file,
      text,
      fromLine: from,
      totalLines: all.length,
      truncated,
    }
  },
})

const fsStat = defineOp({
  id: 'voicetalk.fs.stat',
  scope: 'voicetalk:read',
  summary: 'Type, size and mtime (ms) of a path inside the allowlist.',
  verbException: READ_EXCEPTION,
  input: Type.Object({ path: Type.String() }),
  output: Stat,
  handler: async (ctx: CodemodeCtx, input) => {
    const p = await ctx.allowlist.resolve(input.path)
    const s = await stat(p)
    return {
      path: p,
      type: kind(s),
      size: s.size,
      mtime: Math.floor(s.mtimeMs),
    }
  },
})

const searchText = defineOp({
  id: 'voicetalk.search.text',
  scope: 'voicetalk:read',
  summary:
    'Case-insensitive literal text search over .md/.txt files in the allowlist (or under path). Returns matching lines.',
  verbException: 'Literal full-text search namespace (search.text); read-only',
  input: Type.Object({
    query: Type.String({ minLength: 1, maxLength: 200 }),
    path: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }),
  output: Type.Object({
    hits: Type.Array(
      Type.Object({
        path: Type.String(),
        line: Type.Number(),
        text: Type.String(),
      }),
    ),
    truncated: Type.Boolean(),
  }),
  handler: async (ctx: CodemodeCtx, input) => {
    const limit = input.limit ?? 20
    const needle = input.query.toLowerCase()
    const starts = input.path
      ? [await ctx.allowlist.resolve(input.path)]
      : ctx.allowlist.roots.flatMap((r) => (r.real ? [r.real] : []))
    const hits: { path: string; line: number; text: string }[] = []
    let files = 0
    const visit = async (p: string): Promise<boolean> => {
      const s = await stat(p).catch(() => null)
      if (!s) return true
      if (s.isDirectory()) {
        const dirents = await readdir(p, { withFileTypes: true }).catch(
          () => [],
        )
        for (const d of dirents) {
          if (
            d.isSymbolicLink() ||
            d.name.startsWith('.') ||
            d.name === 'node_modules'
          )
            continue
          if (!(await visit(join(p, d.name)))) return false
        }
        return true
      }
      if (!s.isFile() || s.size > MAX_SEARCH_BYTES) return true
      if (!INGEST_EXTENSIONS.has(extname(p).toLowerCase())) return true
      if (++files > MAX_SEARCH_FILES) return false
      const lines = (await readFile(p, 'utf8')).split(/\r\n?|\n/)
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.toLowerCase().includes(needle)) {
          hits.push({
            path: p,
            line: i + 1,
            text: lines[i]!.trim().slice(0, 240),
          })
          if (hits.length >= limit) return false
        }
      }
      return true
    }
    let complete = true
    for (const s of starts) if (complete) complete = await visit(s)
    return { hits, truncated: !complete }
  },
})

const docsQuery = defineOp({
  id: 'voicetalk.docs.query',
  scope: 'voicetalk:read',
  summary:
    'Semantic search over the ingested documents (EmbeddingGemma). Returns chunks with path and start line for citations.',
  verbException: 'Semantic retrieval (docs.query); read-only',
  input: Type.Object({
    q: Type.String({ minLength: 1, maxLength: 1000 }),
    k: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  }),
  output: Type.Array(Hit),
  handler: async (ctx: CodemodeCtx, input) => {
    try {
      return await ctx.retriever.search(input.q, input.k ?? 5)
    } catch (err) {
      const name = (err as Error).name
      if (
        name === 'EmbedderUnavailableError' ||
        name === 'EmbedderResponseError'
      )
        throw new OpError('PRODUCT_UNAVAILABLE', 'Embedder is not available')
      throw err
    }
  },
})

const notesQuery = defineOp({
  id: 'voicetalk.notes.query',
  scope: 'voicetalk:read',
  summary:
    'Search the internal notes (facts the agent kept about the user) and the external notes (summaries of past conversations). Semantic, with a word-match fallback.',
  verbException: 'Semantic retrieval over notes (notes.query); read-only',
  input: Type.Object({
    q: Type.String({ minLength: 1, maxLength: 1000 }),
    k: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  }),
  output: Type.Array(
    Type.Object({
      id: Type.String(),
      kind: Type.Union([Type.Literal('internal'), Type.Literal('external')]),
      text: Type.String(),
      score: Type.Number(),
      at: Type.Number(),
    }),
  ),
  handler: async (ctx: CodemodeCtx, input) => {
    const hits = await ctx.notes.search(input.q, input.k ?? 5)
    return hits.map((h) => ({
      id: h.id,
      kind: h.kind,
      text: h.text,
      score: h.score,
      at: h.createdAt,
    }))
  },
})

export const registry = createRegistry<CodemodeCtx>({
  product: PRODUCT,
  version: API_VERSION,
  ops: [fsList, fsRead, fsStat, searchText, docsQuery, notesQuery],
})

/** Short globals inside the sandbox: `fs.read(...)` is `codemode.voicetalk.fs.read(...)`. */
export const ALIASES = {
  fs: 'codemode.voicetalk.fs',
  search: 'codemode.voicetalk.search',
  docs: 'codemode.voicetalk.docs',
  notes: 'codemode.voicetalk.notes',
} as const
