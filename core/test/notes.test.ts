import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { createCore } from '../src/app.ts'
import { CallEvents } from '../src/call/events.ts'
import { CallStore } from '../src/call/store.ts'
import { loadStorageConfig, loadMigrations, openDb } from '../src/db/index.ts'
import {
  OpenAiCompatChat,
  type ChatMessage,
  type ChatProvider,
  type FetchLike,
} from '../src/llm/index.ts'
import {
  DECISION_PROMPT,
  createNotesService,
  decide,
  formatDate,
  parseDecision,
  parseSummary,
  type NoteHit,
  type RecorderPrefs,
} from '../src/notes/index.ts'
import { createServices } from '../src/services.ts'
import { FakeEmbedder, scratch } from './helpers.ts'

/** Scripted local model: decision and summary calls are told apart by their system prompt. */
class MockLlm implements ChatProvider {
  readonly name = 'mock'
  decisions: Array<string | Error> = []
  summaries: Array<string | Error> = []
  calls: Array<{ kind: 'decision' | 'summary'; messages: ChatMessage[] }> = []

  async *stream(messages: ChatMessage[]): AsyncGenerator<string> {
    const kind =
      messages[0]?.content === DECISION_PROMPT ? 'decision' : 'summary'
    this.calls.push({ kind, messages })
    const next = (kind === 'decision' ? this.decisions : this.summaries).shift()
    if (next === undefined) throw new Error('mock: nothing scripted')
    if (next instanceof Error) throw next
    // Two chunks, to prove the stream is collected.
    yield next.slice(0, 5)
    yield next.slice(5)
  }
}

const SUMMARY = JSON.stringify({
  summary: 'El usuario habló de su hermana Ana y de un viaje.',
  open_questions: ['Elegir fecha para el viaje.'],
  raised: ['Hermana Ana', 'Viaje a la montaña'],
})
const NOTE = (note: string, confidence?: number) =>
  JSON.stringify({ action: 'internal_note', note, confidence })

function setup(opts: { prefs?: RecorderPrefs; intervalMs?: number } = {}) {
  const events = new CallEvents()
  const store = new CallStore(events)
  const db = openDb(':memory:')
  const embedder = new FakeEmbedder()
  const llm = new MockLlm()
  const notes = createNotesService({
    db,
    embedder,
    llm,
    events,
    prefs: () => opts.prefs ?? { threshold: 0.6, location: 'Montevideo' },
    intervalMs: opts.intervalMs ?? 3_600_000,
  })
  notes.recorder.start()
  return { events, store, db, embedder, llm, notes }
}

const say = (
  store: CallStore,
  id: string,
  speaker: 'user' | 'agent',
  text: string,
  t = Date.now(),
) => store.upsert({ id, speaker, text, t }, true)

describe('migration 0002', () => {
  test('creates sessions, utterances, notes and summaries after 0001', () => {
    const db = openDb(':memory:')
    const names = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )
      .all()
      .map((r) => r.name)
    expect(names).toEqual(
      expect.arrayContaining(['sessions', 'utterances', 'notes', 'summaries']),
    )
    const versions = loadMigrations().map((m) => m.version)
    expect(versions.slice(0, 2)).toEqual([1, 2])
  })

  test('constraints: enums are checked and deleting a session cascades', () => {
    const db = openDb(':memory:')
    db.run("INSERT INTO sessions (id, started_at) VALUES ('s', 1)")
    expect(() =>
      db.run(
        "INSERT INTO sessions (id, started_at, status) VALUES ('x', 1, 'weird')",
      ),
    ).toThrow()
    expect(() =>
      db.run(
        "INSERT INTO utterances (id, session_id, speaker, t_start, t_end, text, source) VALUES ('u', 's', 'bot', 1, 2, 'hi', 'stt')",
      ),
    ).toThrow()
    expect(() =>
      db.run(
        "INSERT INTO notes (session_id, kind, body, created_at) VALUES ('s', 'secret', 'b', 1)",
      ),
    ).toThrow()
    db.run(
      "INSERT INTO utterances (id, session_id, speaker, t_start, t_end, text, source) VALUES ('u', 's', 'user', 1, 2, 'hi', 'stt')",
    )
    db.run(
      "INSERT INTO notes (session_id, kind, body, created_at) VALUES ('s', 'internal', 'b', 1)",
    )
    db.run("INSERT INTO summaries (session_id, summary) VALUES ('s', 'x')")
    db.run("DELETE FROM sessions WHERE id = 's'")
    for (const t of ['utterances', 'notes', 'summaries'])
      expect(
        db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n,
      ).toBe(0)
  })
})

describe('decision contract', () => {
  test('accepts the three actions', () => {
    expect(parseDecision('{"action":"none"}')).toEqual({ action: 'none' })
    expect(
      parseDecision(
        '{"action":"internal_note","note":"Tiene un perro.","confidence":0.9}',
      ),
    ).toEqual({
      action: 'internal_note',
      note: 'Tiene un perro.',
      confidence: 0.9,
    })
    expect(parseDecision('{"action":"recall","query":"viaje"}')).toEqual({
      action: 'recall',
      query: 'viaje',
    })
  })

  test('tolerates code fences and chatter around the JSON', () => {
    expect(
      parseDecision('Claro:\n```json\n{"action":"none","confidence":1}\n```'),
    ).toEqual({ action: 'none', confidence: 1 })
  })

  test('survives repeated objects and stray braces (seen from LFM3 live)', () => {
    // Two objects, one per line: the first valid one wins.
    expect(
      parseDecision(
        '{"action":"internal_note","note":"Ana vive en Salto.","confidence":0.9}\n{"action":"none"}',
      ),
    ).toEqual({
      action: 'internal_note',
      note: 'Ana vive en Salto.',
      confidence: 0.9,
    })
    // Braces inside strings do not unbalance the scan; a trailing stray brace is ignored.
    expect(
      parseSummary('{"summary":"Habló de {su casa}: \\"bien\\"."}\n}')?.summary,
    ).toBe('Habló de {su casa}: "bien".')
    // An invalid first object does not hide a valid second one.
    expect(parseDecision('{"action":"x"} {"action":"none"}')).toEqual({
      action: 'none',
    })
  })

  test('rejects anything off contract instead of repairing it', () => {
    for (const bad of [
      '',
      'no json at all',
      '{"action":"none"',
      '{"action":"delete"}',
      '{"action":"internal_note"}',
      '{"action":"internal_note","note":"  "}',
      '{"action":"recall"}',
      '{"action":"none","confidence":2}',
      '["none"]',
    ])
      expect(parseDecision(bad)).toBeNull()
  })

  test('decide sends the few-shot prompt and the transcript window, and collects the stream', async () => {
    const llm = new MockLlm()
    llm.decisions.push(NOTE('La hermana del usuario se llama Ana.', 0.9))
    const d = await decide(llm, [
      { speaker: 'user', text: 'Mi hermana se llama Ana.' },
      { speaker: 'agent', text: 'Qué bien.' },
    ])
    expect(d).toEqual({
      action: 'internal_note',
      note: 'La hermana del usuario se llama Ana.',
      confidence: 0.9,
    })
    const [call] = llm.calls
    expect(call?.messages[0]?.role).toBe('system')
    expect(call?.messages[1]?.content).toBe(
      'Usuario: Mi hermana se llama Ana.\nAgente: Qué bien.',
    )
  })

  test('decide returns null for an unusable reply', async () => {
    const llm = new MockLlm()
    llm.decisions.push('lo siento, no puedo')
    expect(await decide(llm, [{ speaker: 'user', text: 'hola' }])).toBeNull()
  })

  test('the prompt is neutral Spanish: no voseo', () => {
    expect(DECISION_PROMPT).not.toMatch(/\b(vos|tenés|querés|sabés|contame)\b/i)
  })

  test('with the real provider, thinking stays off and the request is bounded', async () => {
    let body: Record<string, unknown> = {}
    const fetchFake: FetchLike = async (_url, init) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>
      const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: '{"action":"none"}' } }] })}\n\ndata: [DONE]\n\n`
      return new Response(sse)
    }
    const llm = new OpenAiCompatChat({ baseUrl: 'http://x', fetch: fetchFake })
    expect(await decide(llm, [{ speaker: 'user', text: 'hola' }])).toEqual({
      action: 'none',
    })
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(body.max_tokens).toBeLessThanOrEqual(200)
  })
})

describe('summary contract', () => {
  test('parses the model JSON, lists optional', () => {
    expect(parseSummary(SUMMARY)?.openQuestions).toEqual([
      'Elegir fecha para el viaje.',
    ])
    expect(parseSummary('{"summary":"Algo."}')).toEqual({
      summary: 'Algo.',
      openQuestions: [],
      raised: [],
    })
    expect(parseSummary('{"open_questions":[]}')).toBeNull()
    expect(parseSummary('nada')).toBeNull()
  })
})

describe('recorder: persistence from call events', () => {
  test('stores the session and every final utterance, closes it with summary and external note', async () => {
    const { store, llm, notes } = setup()
    llm.summaries.push(SUMMARY)
    const call = store.start()
    say(store, 'u1', 'user', 'Mi hermana se llama Ana.')
    say(store, 'a1', 'agent', 'Qué bien, cuéntame más.')
    // A partial (not final) upsert must not be stored.
    store.upsert({ id: 'u2', speaker: 'user', text: 'parcial', t: 1 }, false)
    expect(notes.sessions.get(call.id)).toMatchObject({
      status: 'active',
      location: 'Montevideo',
    })
    store.end('client')
    await notes.recorder.idle()

    const session = notes.sessions.get(call.id)
    expect(session?.status).toBe('ended')
    expect(session?.endedAt).not.toBeNull()
    expect(session?.title).toBe('Mi hermana se llama Ana.')
    const rows = notes.utterances.list(call.id)
    expect(rows.map((r) => [r.id, r.speaker, r.source, r.text])).toEqual([
      ['u1', 'user', 'stt', 'Mi hermana se llama Ana.'],
      ['a1', 'agent', 'agent', 'Qué bien, cuéntame más.'],
    ])
    expect(notes.summaries.get(call.id)).toEqual({
      sessionId: call.id,
      summary: 'El usuario habló de su hermana Ana y de un viaje.',
      openQuestions: ['Elegir fecha para el viaje.'],
      raised: ['Hermana Ana', 'Viaje a la montaña'],
    })
    const [external] = notes.notes.listExternal(call.id)
    expect(external?.speakers).toEqual(['user', 'agent'])
    expect(external?.location).toBe('Montevideo')
    expect(external?.body).toContain('Montevideo')
    expect(external?.body).toContain(formatDate(call.startedAt))
    expect(external?.body).toContain('Quedó pendiente')
    expect(external?.body).toContain('Elegir fecha para el viaje.')
    expect(external?.body).toContain('Salieron estos temas')
    expect(external?.body).not.toMatch(/\b(vos|tenés|querés)\b/i)
  })

  test('a call with no speech leaves no session behind', async () => {
    const { store, notes } = setup()
    const call = store.start()
    store.end('client')
    await notes.recorder.idle()
    expect(notes.sessions.get(call.id)).toBeNull()
  })

  test('a call that ends on error is interrupted; shutdown skips the model', async () => {
    const { store, llm, notes } = setup()
    const a = store.start()
    say(store, 'u1', 'user', 'Hola, probando.')
    store.end('error')
    llm.decisions.push('{"action":"none"}')
    llm.summaries.push(SUMMARY)
    await notes.recorder.idle()
    expect(notes.sessions.get(a.id)?.status).toBe('interrupted')

    const before = llm.calls.length
    const b = store.start()
    say(store, 'u2', 'user', 'Otra vez probando.')
    store.end('shutdown')
    await notes.recorder.idle()
    expect(llm.calls.length).toBe(before)
    expect(notes.sessions.get(b.id)?.status).toBe('interrupted')
    expect(notes.summaries.get(b.id)?.summary).toContain('Conversación de 1')
  })

  test('a down model degrades to the plain summary and still stores everything', async () => {
    const { store, llm, notes } = setup()
    llm.decisions.push(new Error('connection refused'))
    llm.summaries.push(new Error('connection refused'))
    const call = store.start()
    say(store, 'u1', 'user', 'Mañana tengo una entrevista.')
    store.end('client')
    await notes.recorder.idle()
    expect(notes.sessions.get(call.id)?.status).toBe('ended')
    expect(notes.summaries.get(call.id)?.summary).toContain(
      'Mañana tengo una entrevista.',
    )
    expect(notes.notes.listExternal(call.id)).toHaveLength(1)
  })

  test('sessions left active by a crash are closed on start', () => {
    const db = openDb(':memory:')
    const events = new CallEvents()
    const svc = createNotesService({
      db,
      embedder: new FakeEmbedder(),
      llm: null,
      events,
    })
    svc.sessions.create({ id: 'full', startedAt: 10, location: '' })
    svc.utterances.add({
      id: 'u',
      sessionId: 'full',
      speaker: 'user',
      tStart: 11,
      tEnd: 12,
      text: 'hola',
      source: 'stt',
    })
    svc.sessions.create({ id: 'empty', startedAt: 20, location: '' })
    svc.recorder.start()
    expect(svc.sessions.get('full')?.status).toBe('interrupted')
    expect(svc.sessions.get('empty')).toBeNull()
  })

  test('a broken storage write never reaches the call', () => {
    const { store, db } = setup()
    store.start()
    db.close()
    expect(() => say(store, 'u1', 'user', 'sigue la llamada')).not.toThrow()
  })
})

describe('recorder: decision model', () => {
  test('writes an internal note on the timer, embedded and searchable', async () => {
    const { store, llm, notes } = setup({ intervalMs: 15 })
    llm.decisions.push(NOTE('La hermana del usuario se llama Ana.', 0.9))
    llm.summaries.push(SUMMARY)
    const call = store.start()
    say(store, 'u1', 'user', 'Mi hermana se llama Ana.')
    await Bun.sleep(80)
    await notes.recorder.idle()
    const internal = notes.notes.all(['internal'])
    expect(internal).toHaveLength(1)
    expect(internal[0]).toMatchObject({
      sessionId: call.id,
      body: 'La hermana del usuario se llama Ana.',
      speakers: ['user'],
      location: 'Montevideo',
    })
    expect(internal[0]?.embedding).toBeInstanceOf(Float32Array)
    expect(llm.calls.filter((c) => c.kind === 'decision')).toHaveLength(1)
    const hits = await notes.search.search('hermana Ana', 3)
    expect(hits[0]?.text).toContain('Ana')
    store.end('client')
    await notes.recorder.idle()
  })

  test('a window with no new user speech does not call the model', async () => {
    const { store, llm, notes } = setup({ intervalMs: 15 })
    llm.summaries.push(SUMMARY)
    store.start()
    say(store, 'a1', 'agent', 'Hola, ¿en qué te ayudo?')
    await Bun.sleep(60)
    await notes.recorder.idle()
    expect(llm.calls.filter((c) => c.kind === 'decision')).toHaveLength(0)
    store.end('client')
    await notes.recorder.idle()
  })

  test('confidence below the preference threshold is ignored; above it is kept', async () => {
    for (const [threshold, expected] of [
      [0.6, 0],
      [0.2, 1],
    ] as const) {
      const { store, llm, notes } = setup({
        prefs: { threshold, location: '' },
      })
      llm.decisions.push(NOTE('Le gusta el mate.', 0.4))
      llm.summaries.push(SUMMARY)
      store.start()
      say(store, 'u1', 'user', 'Me gusta el mate.')
      store.end('client')
      await notes.recorder.idle()
      expect(notes.notes.all(['internal'])).toHaveLength(expected)
    }
  })

  test('an absent confidence counts as certain; an off-contract reply writes nothing', async () => {
    const a = setup()
    a.llm.decisions.push(NOTE('Tiene un perro llamado Toby.'))
    a.llm.summaries.push(SUMMARY)
    a.store.start()
    say(a.store, 'u1', 'user', 'Tengo un perro, Toby.')
    a.store.end('client')
    await a.notes.recorder.idle()
    expect(a.notes.notes.all(['internal'])).toHaveLength(1)

    const b = setup()
    b.llm.decisions.push('{"action":"internal_note"}')
    b.llm.summaries.push(SUMMARY)
    b.store.start()
    say(b.store, 'u1', 'user', 'Tengo un perro, Toby.')
    b.store.end('client')
    await b.notes.recorder.idle()
    expect(b.notes.notes.all(['internal'])).toHaveLength(0)
  })

  test('the same fact twice in one call is stored once', async () => {
    const { store, llm, notes } = setup({ intervalMs: 15 })
    llm.decisions.push(NOTE('Tiene un perro llamado Toby.', 0.9))
    llm.decisions.push(NOTE('tiene un  perro llamado toby.', 0.9))
    llm.summaries.push(SUMMARY)
    store.start()
    say(store, 'u1', 'user', 'Tengo un perro, Toby.')
    await Bun.sleep(50)
    await notes.recorder.idle()
    say(store, 'u2', 'user', 'Sí, Toby es mi perro.')
    await Bun.sleep(50)
    store.end('client')
    await notes.recorder.idle()
    expect(notes.notes.all(['internal'])).toHaveLength(1)
  })

  test('recall searches earlier conversations only and hands the hits to the hook', async () => {
    const events = new CallEvents()
    const store = new CallStore(events)
    const embedder = new FakeEmbedder()
    const llm = new MockLlm()
    const found: Array<{ callId: string; query: string; hits: NoteHit[] }> = []
    // Build the recorder directly to inject the hook.
    const { NotesRecorder } = await import('../src/notes/index.ts')
    const base = createNotesService({
      db: openDb(':memory:'),
      embedder,
      llm,
      events: new CallEvents(),
    })
    const recorder = new NotesRecorder({
      events,
      sessions: base.sessions,
      utterances: base.utterances,
      notes: base.notes,
      summaries: base.summaries,
      search: base.search,
      embedder,
      llm,
      prefs: () => ({ threshold: 0.6, location: '' }),
      onRecall: (callId, query, hits) => found.push({ callId, query, hits }),
    })
    recorder.start()

    base.sessions.create({ id: 'old', startedAt: 1, location: '' })
    const [vec] = await embedder.embedDocuments([
      {
        heading: 'nota',
        text: 'El usuario planea un viaje a la montaña en verano.',
      },
    ])
    base.search.index(
      base.notes.add({
        sessionId: 'old',
        kind: 'internal',
        body: 'El usuario planea un viaje a la montaña en verano.',
        createdAt: 1,
        location: '',
        speakers: ['user'],
        embedding: vec ?? null,
      }),
    )

    llm.decisions.push(
      JSON.stringify({
        action: 'recall',
        query: 'viaje montaña',
        confidence: 0.9,
      }),
    )
    llm.summaries.push(SUMMARY)
    const call = store.start()
    say(store, 'u1', 'user', 'Como te contaba del viaje a la montaña...')
    store.end('client')
    await recorder.idle()

    expect(found).toHaveLength(1)
    expect(found[0]?.callId).toBe(call.id)
    expect(found[0]?.query).toBe('viaje montaña')
    expect(found[0]?.hits[0]?.text).toContain('montaña')
    expect(found[0]?.hits.every((h) => h.sessionId !== call.id)).toBe(true)
  })
})

describe('note search and Code Mode notes.query', () => {
  const s = scratch()
  const config = { ...loadStorageConfig({}), dataDir: s.dir, folders: [] }
  const embedder = new FakeEmbedder()
  const services = createServices(config, {
    embedder,
    db: openDb(':memory:'),
    llm: null,
  })
  afterAll(() => {
    services.close()
    s.cleanup()
  })

  async function addNote(
    kind: 'internal' | 'external',
    body: string,
    withVector = true,
  ) {
    const [vec] = await embedder.embedDocuments([{ heading: kind, text: body }])
    const note = services.notes.notes.add({
      sessionId: null,
      kind,
      body,
      createdAt: Date.now(),
      location: '',
      speakers: ['user'],
      embedding: withVector ? (vec ?? null) : null,
    })
    services.notes.search.index(note)
    return note
  }

  test('empty at first', async () => {
    const run = await services.codemode.run(
      `return await notes.query({ q: 'viaje' })`,
    )
    expect(run.ok).toBe(true)
    expect(JSON.parse(run.resultJson ?? 'null')).toEqual([])
  })

  test('finds internal and external notes, ranked, with kind and score', async () => {
    await addNote('internal', 'El usuario tiene un perro llamado Toby.')
    await addNote(
      'external',
      'Conversación sobre un viaje a la montaña en verano.',
    )
    await addNote('internal', 'Trabaja en una empresa de logística.')
    const run = await services.codemode.run(
      `return await notes.query({ q: 'viaje montaña verano', k: 2 })`,
    )
    expect(run.ok).toBe(true)
    const hits = JSON.parse(run.resultJson ?? '[]') as Array<{
      kind: string
      text: string
      score: number
    }>
    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({ kind: 'external' })
    expect(hits[0]?.text).toContain('montaña')
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
    const dog = await services.notes.search.search('perro Toby', 5, {
      kinds: ['internal'],
    })
    expect(dog.every((h) => h.kind === 'internal')).toBe(true)
  })

  test('input is validated', async () => {
    const run = await services.codemode.run(`return await notes.query({})`)
    expect(run.error?.code).toBe('VALIDATION')
  })

  test('notes saved without a vector are still found by words, and everything when the embedder is down', async () => {
    await addNote('internal', 'Le encanta el ciclismo de montaña.', false)
    embedder.up = false
    try {
      const hits = await services.notes.search.search('ciclismo', 5)
      expect(hits[0]?.text).toContain('ciclismo')
    } finally {
      embedder.up = true
    }
  })

  test('the index is rebuilt from the database at startup', async () => {
    const { createNoteSearch } = await import('../src/notes/index.ts')
    const fresh = createNoteSearch({
      notes: services.notes.notes,
      embedder,
    })
    const hits = await fresh.search('perro Toby', 1)
    expect(hits[0]?.text).toContain('Toby')
  })
})

describe('GraphQL sessions', () => {
  const s = scratch()
  const config = { ...loadStorageConfig({}), dataDir: s.dir, folders: [] }
  const services = createServices(config, {
    embedder: new FakeEmbedder(),
    db: openDb(join(s.dir, 'gql.db')),
    llm: null,
  })
  afterAll(() => {
    services.close()
    s.cleanup()
  })
  const SECRET_FACT = 'DATO-INTERNO-PRIVADO la hermana se llama Ana'

  services.notes.sessions.create({
    id: 's1',
    startedAt: 1000,
    location: 'Salto',
  })
  services.notes.sessions.end('s1', 2000, 'ended')
  services.notes.sessions.setTitle('s1', 'Una charla')
  services.notes.utterances.add({
    id: 'u1',
    sessionId: 's1',
    speaker: 'user',
    tStart: 1100,
    tEnd: 1200,
    text: 'hola',
    source: 'stt',
  })
  services.notes.summaries.save({
    sessionId: 's1',
    summary: 'Resumen.',
    openQuestions: ['Pendiente.'],
    raised: ['Tema.'],
  })
  services.notes.notes.add({
    sessionId: 's1',
    kind: 'internal',
    body: SECRET_FACT,
    createdAt: 1500,
    location: 'Salto',
    speakers: ['user'],
    embedding: new Float32Array([1, 2, 3]),
  })
  services.notes.notes.add({
    sessionId: 's1',
    kind: 'external',
    body: 'Nota externa visible.',
    createdAt: 1600,
    location: 'Salto',
    speakers: ['user', 'agent'],
    embedding: null,
  })

  const gql = async (query: string) => {
    const res = await createCore(
      { port: 0, cartesiaApiKey: undefined },
      services,
    ).app.handle(
      new Request('http://127.0.0.1/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      }),
    )
    return { text: await res.text() }
  }
  const parse = (text: string) =>
    JSON.parse(text) as { data?: any; errors?: { message: string }[] }

  test('lists sessions and returns one with transcript, summary and external notes', async () => {
    const list = parse(
      (await gql('{ sessions { id title status location utteranceCount } }'))
        .text,
    )
    expect(list.data.sessions).toEqual([
      {
        id: 's1',
        title: 'Una charla',
        status: 'ended',
        location: 'Salto',
        utteranceCount: 1,
      },
    ])
    const one = parse(
      (
        await gql(`{ session(id: "s1") {
          startedAt endedAt
          utterances { speaker text tStart }
          summary { summary openQuestions raised }
          externalNotes { body location speakers }
        } }`)
      ).text,
    )
    expect(one.errors).toBeUndefined()
    expect(one.data.session).toEqual({
      startedAt: 1000,
      endedAt: 2000,
      utterances: [{ speaker: 'user', text: 'hola', tStart: 1100 }],
      summary: {
        summary: 'Resumen.',
        openQuestions: ['Pendiente.'],
        raised: ['Tema.'],
      },
      externalNotes: [
        {
          body: 'Nota externa visible.',
          location: 'Salto',
          speakers: ['user', 'agent'],
        },
      ],
    })
    expect(
      parse((await gql('{ session(id: "nope") { id } }')).text).data.session,
    ).toBeNull()
  })

  test('internal notes and embeddings never appear in any response', async () => {
    const { text } = await gql(`{ sessions { id utterances { text }
      summary { summary } externalNotes { body } } }`)
    expect(text).not.toContain('DATO-INTERNO-PRIVADO')
    expect(text).toContain('Nota externa visible.')
  })

  test('the schema has no way to ask for them', async () => {
    const intro = parse(
      (
        await gql(`{
          session: __type(name: "Session") { fields { name } }
          note: __type(name: "ExternalNote") { fields { name } }
          query: __type(name: "Query") { fields { name } }
        }`)
      ).text,
    ).data
    const names = (t: { fields: { name: string }[] }) =>
      t.fields.map((f) => f.name)
    expect(names(intro.session)).not.toEqual(
      expect.arrayContaining(['notes', 'internalNotes']),
    )
    expect(names(intro.note)).not.toContain('embedding')
    expect(names(intro.note)).not.toContain('kind')
    expect(names(intro.query)).not.toEqual(
      expect.arrayContaining(['notes', 'internalNotes', 'note']),
    )
    for (const q of [
      '{ session(id: "s1") { internalNotes { body } } }',
      '{ session(id: "s1") { externalNotes { embedding } } }',
      '{ session(id: "s1") { externalNotes { kind } } }',
      '{ notes { body } }',
    ])
      expect(parse((await gql(q)).text).errors?.length).toBeGreaterThan(0)
  })

  test('the page size is clamped', async () => {
    const r = parse(
      (await gql('{ sessions(limit: 100000, offset: -5) { id } }')).text,
    )
    expect(r.errors).toBeUndefined()
    expect(r.data.sessions).toHaveLength(1)
  })
})
