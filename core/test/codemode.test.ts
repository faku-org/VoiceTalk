import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAllowlist, createCodemode } from '../src/codemode/index.ts'
import { openDb } from '../src/db/index.ts'
import { createCore } from '../src/app.ts'
import { createServices } from '../src/services.ts'
import { loadStorageConfig } from '../src/db/index.ts'
import { FakeEmbedder, scratch } from './helpers.ts'

const s = scratch()
const root = join(s.dir, 'docs')
const outside = join(s.dir, 'outside')
let services: ReturnType<typeof createServices>
let audit: string

beforeAll(async () => {
  mkdirSync(join(root, 'sub'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(
    join(root, 'budget.md'),
    '# Budget\nquarterly budget review\n\n## Cuts\nreduce cloud spending',
  )
  writeFileSync(join(root, 'sub', 'trip.txt'), 'holiday trip to the mountains')
  writeFileSync(join(outside, 'secret.md'), 'outside the allowlist')
  try {
    symlinkSync(outside, join(root, 'jump'), 'junction')
  } catch {}
  const config = {
    ...loadStorageConfig({}),
    dataDir: join(s.dir, 'data'),
    folders: [root],
  }
  services = createServices(config, {
    embedder: new FakeEmbedder(),
    db: openDb(':memory:'),
  })
  audit = join(config.dataDir, 'codemode-audit.jsonl')
  await services.ingester.scan()
})
afterAll(() => {
  services.close()
  s.cleanup()
})

describe('codemode', () => {
  test('round trip: aliases, fs.list/read/stat, search.text, docs.query, timeline', async () => {
    const run = await services.codemode.run(`
      const roots = await fs.list({})
      const dir = await fs.list({ path: roots.entries[0].path })
      const doc = await fs.read({ path: 'budget.md', lines: 2 })
      const st = await fs.stat({ path: 'budget.md' })
      const text = await search.text({ query: 'MOUNTAINS' })
      const sem = await docs.query({ q: 'quarterly budget review', k: 2 })
      const nq = await notes.query({ q: 'anything' })
      return { names: dir.entries.map(e => e.name), doc: doc.text, size: st.size,
               text: text.hits.length, top: sem[0].path, notes: nq }
    `)
    expect(run.error).toBeNull()
    expect(run.ok).toBe(true)
    const out = JSON.parse(run.resultJson!)
    expect(out.names).toContain('budget.md')
    expect(out.doc).toBe('# Budget\nquarterly budget review')
    expect(out.size).toBeGreaterThan(0)
    expect(out.text).toBe(1)
    expect(out.top).toContain('budget.md')
    expect(out.notes).toEqual([])
    expect(run.timeline.map((t) => t.op)).toEqual([
      'fs.list',
      'fs.list',
      'fs.read',
      'fs.stat',
      'search.text',
      'docs.query',
      'notes.query',
    ])
    expect(run.timeline.every((t) => t.ok && t.ms >= 0)).toBe(true)
    expect(run.calls).toBe(7)
  })

  test('paths outside the allowlist fail with FORBIDDEN, code can catch it', async () => {
    const run = await services.codemode.run(`
      const tries = ['../outside/secret.md', ${JSON.stringify(join(outside, 'secret.md'))},
        '\\\\\\\\server\\\\share\\\\x.md', 'jump/secret.md']
      const codes = []
      for (const p of tries) {
        try { await fs.read({ path: p }); codes.push('READ') }
        catch (e) { codes.push(e.code) }
      }
      return codes
    `)
    expect(run.ok).toBe(true)
    const codes = JSON.parse(run.resultJson!) as string[]
    expect(codes).toEqual(codes.map(() => 'FORBIDDEN'))
    expect(run.timeline.every((t) => t.code === 'FORBIDDEN')).toBe(true)
  })

  test('an uncaught denied call fails the run with the op code', async () => {
    const run = await services.codemode.run(
      `return await fs.read({ path: '../x' })`,
    )
    expect(run.ok).toBe(false)
    expect(run.error?.code).toBe('FORBIDDEN')
  })

  test('no writes, no processes, no network inside the sandbox', async () => {
    const run = await services.codemode.run(`
      return {
        write: typeof fs.write, del: typeof fs.delete,
        ops: Object.keys(codemode.voicetalk.fs).sort(),
        proc: typeof process, req: typeof require, fetch: typeof fetch, bun: typeof Bun,
      }
    `)
    expect(run.ok).toBe(true)
    expect(JSON.parse(run.resultJson!)).toEqual({
      write: 'undefined',
      del: 'undefined',
      ops: ['list', 'read', 'stat'],
      proc: 'undefined',
      req: 'undefined',
      fetch: 'undefined',
      bun: 'undefined',
    })
  })

  test('input is validated and runaway code is stopped', async () => {
    const bad = await services.codemode.run(
      `return await fs.read({ lines: 3 })`,
    )
    expect(bad.error?.code).toBe('VALIDATION')
    const loop = createCodemode({
      ctx: {
        allowlist: createAllowlist([root]),
        retriever: services.retriever,
      },
      auditPath: join(s.dir, 'loop.jsonl'),
      limits: { timeoutMs: 300 },
    })
    const run = await loop.run('while (true) {}')
    expect(run.ok).toBe(false)
    expect(run.error?.code).toBe('TIMEOUT')
    expect((await services.codemode.run('')).error?.code).toBe('VALIDATION')
  })

  test('every execution is audited as JSONL without result contents', async () => {
    await services.codemode.run(
      `return (await fs.read({ path: 'budget.md' })).text.length`,
    )
    const lines = readFileSync(audit, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines.length).toBeGreaterThanOrEqual(5)
    const last = lines.at(-1)
    expect(last).toMatchObject({ ok: true, origin: 'graphql', calls: 1 })
    expect(last.code).toContain('fs.read')
    expect(last.timeline[0].op).toBe('fs.read')
    expect(JSON.stringify(lines)).not.toContain('reduce cloud spending')
    expect(lines.some((l) => l.ok === false)).toBe(true)
  })
})

describe('GraphQL', () => {
  const core = () =>
    createCore({ port: 0, cartesiaApiKey: undefined }, services)
  const gql = async (query: string, variables?: object) => {
    const res = await core().app.handle(
      new Request('http://127.0.0.1/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      }),
    )
    return (await res.json()) as { data?: any; errors?: { message: string }[] }
  }

  test('ingestStatus, searchDocs, codemodeRun', async () => {
    const status = await gql(
      '{ ingestStatus { documents chunks embedderUp folders { exists } } }',
    )
    expect(status.data.ingestStatus).toMatchObject({
      documents: 2,
      embedderUp: true,
    })
    const search = await gql(
      'query($q: String!) { searchDocs(q: $q, k: 1) { path line heading score } }',
      {
        q: 'cloud spending cuts',
      },
    )
    expect(search.data.searchDocs[0].path).toContain('budget.md')
    const run = await gql(
      'mutation($c: String!) { codemodeRun(code: $c) { ok resultJson error { code } timeline { op ms ok summary } } }',
      {
        c: `return (await docs.query({ q: 'holiday mountains', k: 1 }))[0].path`,
      },
    )
    expect(run.errors).toBeUndefined()
    expect(run.data.codemodeRun.ok).toBe(true)
    expect(run.data.codemodeRun.resultJson).toContain('trip.txt')
    expect(run.data.codemodeRun.timeline[0]).toMatchObject({
      op: 'docs.query',
      ok: true,
    })
  })

  test('codemodeRun is not reachable over GET', async () => {
    const res = await core().app.handle(
      new Request(
        `http://127.0.0.1/graphql?query=${encodeURIComponent('mutation { codemodeRun(code: "return 1") { ok } }')}`,
      ),
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  test('without services the storage fields error cleanly', async () => {
    const res = await createCore({
      port: 0,
      cartesiaApiKey: undefined,
    }).app.handle(
      new Request('http://127.0.0.1/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ ingestStatus { documents } }' }),
      }),
    )
    const body = (await res.json()) as { errors: { message: string }[] }
    expect(body.errors[0]!.message).toContain('not configured')
  })
})
