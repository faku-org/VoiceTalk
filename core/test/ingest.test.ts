import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAllowlist } from '../src/codemode/index.ts'
import { openDb } from '../src/db/index.ts'
import { Ingester } from '../src/ingest/index.ts'
import {
  BruteForceVectorStore,
  createRetriever,
  hydrateStore,
} from '../src/rag/index.ts'
import { FakeEmbedder, scratch } from './helpers.ts'

let s: ReturnType<typeof scratch>
let root: string
let embedder: FakeEmbedder
let db: ReturnType<typeof openDb>
let store: BruteForceVectorStore
let ingester: Ingester

beforeEach(() => {
  s = scratch()
  root = join(s.dir, 'docs')
  mkdirSync(join(root, 'sub'), { recursive: true })
  writeFileSync(
    join(root, 'budget.md'),
    '# Budget\nquarterly budget review and forecast\n\n## Cuts\nreduce cloud spending',
  )
  writeFileSync(join(root, 'sub', 'trip.txt'), 'holiday trip to the mountains')
  writeFileSync(join(root, 'image.png'), 'not ingested')
  embedder = new FakeEmbedder()
  db = openDb(':memory:')
  store = new BruteForceVectorStore()
  ingester = new Ingester({
    db,
    store,
    embedder,
    allowlist: createAllowlist([root]),
  })
})
afterEach(() => s.cleanup())

describe('Ingester', () => {
  test('indexes md and txt only, then answers queries with citations', async () => {
    const report = await ingester.scan()
    expect(report).toMatchObject({ seen: 2, indexed: 2, failed: 0 })
    expect(ingester.status()).toMatchObject({
      documents: 2,
      chunks: 3,
      embedderUp: true,
    })
    const hits = await createRetriever({ db, store, embedder }).search(
      'quarterly budget forecast',
    )
    expect(hits[0]!.path).toContain('budget.md')
    expect(hits[0]!.line).toBe(1)
  })

  test('is incremental by hash: unchanged files are not re-embedded', async () => {
    await ingester.scan()
    const before = embedder.calls
    expect(await ingester.scan()).toMatchObject({ unchanged: 2, indexed: 0 })
    expect(embedder.calls).toBe(before)
    // Same bytes, new mtime: hash match, still no embedding.
    const t = new Date(Date.now() + 60_000)
    utimesSync(join(root, 'budget.md'), t, t)
    expect(await ingester.scan()).toMatchObject({ unchanged: 2, indexed: 0 })
    expect(embedder.calls).toBe(before)
    // Changed content: only that file is re-embedded.
    writeFileSync(join(root, 'budget.md'), '# Budget\nnew content about hiring')
    expect(await ingester.scan()).toMatchObject({ indexed: 1, unchanged: 1 })
    expect(embedder.calls).toBeGreaterThan(before)
    expect(
      (await createRetriever({ db, store, embedder }).search('hiring'))[0]!
        .text,
    ).toContain('hiring')
  })

  test('removes documents of deleted files', async () => {
    await ingester.scan()
    rmSync(join(root, 'sub', 'trip.txt'))
    expect(await ingester.scan()).toMatchObject({ removed: 1 })
    expect(ingester.status().documents).toBe(1)
    expect(store.size).toBe(2)
  })

  test('embedder down: files are reported failed, nothing half-indexed, retried later', async () => {
    embedder.up = false
    const report = await ingester.scan()
    expect(report.indexed).toBe(0)
    expect(report.failed).toBeGreaterThan(0)
    expect(ingester.status().documents).toBe(0)
    embedder.up = true
    expect(await ingester.scan()).toMatchObject({ indexed: 2, failed: 0 })
  })

  test('hydrateStore restores vectors from the database', async () => {
    await ingester.scan()
    const fresh = new BruteForceVectorStore()
    hydrateStore(db, fresh)
    expect(fresh.size).toBe(store.size)
    const hits = await createRetriever({ db, store: fresh, embedder }).search(
      'mountains holiday',
    )
    expect(hits[0]!.path).toContain('trip.txt')
  })

  test('a folder that is missing keeps its documents; status shows it', async () => {
    await ingester.scan()
    rmSync(root, { recursive: true })
    const gone = new Ingester({
      db,
      store,
      embedder,
      allowlist: createAllowlist([root]),
    })
    expect(await gone.scan()).toMatchObject({ removed: 0 })
    expect(gone.status().folders[0]!.exists).toBe(false)
    expect(gone.status().documents).toBe(2)
  })
})
