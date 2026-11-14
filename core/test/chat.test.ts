import { afterAll, describe, expect, test } from 'bun:test'
import { printSchema } from 'graphql'
import { createCore } from '../src/app.ts'
import {
  buildContext,
  ChatError,
  OpStripper,
  parseOps,
  searchTerms,
  type ChatEvent,
  type ChatService,
  type TimelineItem,
} from '../src/chat/index.ts'
import { loadStorageConfig, openDb } from '../src/db/index.ts'
import { schema } from '../src/graphql/schema.ts'
import type { ChatMessage, ChatProvider } from '../src/llm/index.ts'
import { createServices, type Services } from '../src/services.ts'
import { bagOfWords, FakeEmbedder, scratch } from './helpers.ts'

/** Scripted brain: each call to `stream` takes the next reply and yields it in small chunks. */
class ScriptedLlm implements ChatProvider {
  readonly name = 'scripted'
  replies: string[] = []
  calls: ChatMessage[][] = []
  async *stream(
    messages: ChatMessage[],
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<string> {
    this.calls.push(messages)
    const next = this.replies.shift()
    if (next === undefined) throw new Error('scripted: nothing left')
    for (let i = 0; i < next.length; i += 7) {
      if (opts?.signal?.aborted) return
      yield next.slice(i, i + 7)
      await Promise.resolve()
    }
  }
}

function setup(): {
  services: Services
  chat: ChatService
  llm: ScriptedLlm
  done(): void
} {
  const s = scratch()
  const llm = new ScriptedLlm()
  const services = createServices(
    { ...loadStorageConfig({}), dataDir: s.dir, folders: [] },
    {
      embedder: new FakeEmbedder(),
      db: openDb(':memory:'),
      llm: null,
      chatLlm: llm,
    },
  )
  return {
    services,
    chat: services.chat,
    llm,
    done: () => {
      services.close()
      s.cleanup()
    },
  }
}

function seedSession(services: Services): void {
  const { sessions, utterances } = services.notes
  sessions.create({ id: 's1', startedAt: 1000, location: 'Salto' })
  sessions.end('s1', 5000, 'ended')
  utterances.add({
    id: 'u1',
    sessionId: 's1',
    speaker: 'user',
    tStart: 1100,
    tEnd: 1200,
    text: 'Quiero hablar del presupuesto de la cocina',
    source: 'stt',
  })
  utterances.add({
    id: 'u2',
    sessionId: 's1',
    speaker: 'agent',
    tStart: 1300,
    tEnd: 1400,
    text: 'Claro, empecemos por los muebles.',
    source: 'agent',
  })
  utterances.add({
    id: 'u3',
    sessionId: 's1',
    speaker: 'user',
    tStart: 4000,
    tEnd: 4100,
    text: 'Mi hermana se llama Ana',
    source: 'stt',
  })
}

async function drain(
  chat: ChatService,
  threadId: string,
  input: Parameters<ChatService['begin']>[1],
): Promise<ChatEvent[]> {
  const turn = chat.begin(threadId, input)
  const out: ChatEvent[] = []
  for await (const ev of turn.run()) out.push(ev)
  return out
}

const messagesOf = (chat: ChatService, threadId: string) =>
  chat.timeline(threadId).items.filter((i) => i.kind === 'message')

describe('chat storage', () => {
  test('the main thread is created once and survives reopening', () => {
    const t = setup()
    const a = t.chat.mainThread()
    expect(t.chat.mainThread().id).toBe(a.id)
    expect(t.chat.listThreads()).toHaveLength(1)
    t.done()
  })

  test('migration enforces its constraints and cascades on thread delete', () => {
    const t = setup()
    const thread = t.chat.mainThread()
    const db = t.services.db
    expect(() =>
      db.run(
        "INSERT INTO chat_messages (id, thread_id, role, text, created_at, status) VALUES ('x', ?, 'robot', 'a', 1, 'complete')",
        [thread.id],
      ),
    ).toThrow()
    expect(() =>
      db.run(
        "INSERT INTO chat_messages (id, thread_id, role, text, created_at, status) VALUES ('x', 'nope', 'user', 'a', 1, 'complete')",
      ),
    ).toThrow()
    db.run(
      "INSERT INTO chat_messages (id, thread_id, role, text, created_at, status) VALUES ('m', ?, 'user', 'a', 1, 'complete')",
      [thread.id],
    )
    db.run('DELETE FROM chat_threads WHERE id = ?', [thread.id])
    expect(db.query('SELECT * FROM chat_messages').all()).toEqual([])
    t.done()
  })

  test('the timeline merges messages and transcripts chronologically', async () => {
    const t = setup()
    seedSession(t.services)
    const main = t.chat.mainThread()
    t.llm.replies = ['Hola.']
    await drain(t.chat, main.id, { text: 'hola' })
    const tl = t.chat.timeline(main.id)
    expect(tl.items.map((i) => i.kind)).toEqual([
      'utterance',
      'utterance',
      'utterance',
      'message',
      'message',
    ])
    const times = tl.items.map((i) => i.at)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    expect(tl.sessions.map((s) => s.id)).toEqual(['s1'])
    t.done()
  })
})

describe('streaming turn', () => {
  test('streams deltas, stores the answer and frees the thread', async () => {
    const t = setup()
    const main = t.chat.mainThread()
    t.llm.replies = ['Una respuesta bastante larga para varios trozos.']
    const events = await drain(t.chat, main.id, { text: 'hola' })
    expect(events[0]?.type).toBe('user')
    const text = events
      .filter((e) => e.type === 'delta')
      .map((e) => (e as { text: string }).text)
      .join('')
    expect(text).toBe('Una respuesta bastante larga para varios trozos.')
    expect(events.at(-1)?.type).toBe('done')
    const last = messagesOf(t.chat, main.id).at(-1)
    expect(last?.kind === 'message' && last.status).toBe('complete')
    expect(t.chat.isBusy(main.id)).toBe(false)
    t.done()
  })

  test('a second turn on a busy thread is refused', () => {
    const t = setup()
    const main = t.chat.mainThread()
    const turn = t.chat.begin(main.id, { text: 'uno' })
    expect(() => t.chat.begin(main.id, { text: 'dos' })).toThrow(ChatError)
    turn.release()
    expect(() =>
      t.chat.begin(main.id, { text: 'tres' }).release(),
    ).not.toThrow()
    t.done()
  })

  test('an aborted turn keeps the partial text as interrupted', async () => {
    const t = setup()
    const main = t.chat.mainThread()
    t.llm.replies = ['Empiezo a contestar y me cortan antes de terminar.']
    const abort = new AbortController()
    const turn = t.chat.begin(main.id, { text: 'hola' })
    let seen = 0
    for await (const ev of turn.run(abort.signal)) {
      if (ev.type === 'delta' && ++seen === 2) abort.abort()
    }
    const last = messagesOf(t.chat, main.id).at(-1)
    expect(last?.kind === 'message' && last.status).toBe('interrupted')
    expect(last?.kind === 'message' && last.text.length).toBeGreaterThan(0)
    expect(t.chat.isBusy(main.id)).toBe(false)
    t.done()
  })

  test('a provider failure ends as an error message in neutral Spanish', async () => {
    const t = setup()
    const main = t.chat.mainThread()
    // No scripted reply: the mock throws.
    const events = await drain(t.chat, main.id, { text: 'hola' })
    const err = events.find((e) => e.type === 'error')
    expect(err && 'message' in err && err.message).toContain('Inténtalo')
    expect(t.chat.isBusy(main.id)).toBe(false)
    t.done()
  })

  test('without a brain the turn does not start', () => {
    const s = scratch()
    const services = createServices(
      { ...loadStorageConfig({}), dataDir: s.dir, folders: [] },
      {
        embedder: new FakeEmbedder(),
        db: openDb(':memory:'),
        llm: null,
        chatLlm: null,
      },
    )
    const main = services.chat.mainThread()
    expect(() => services.chat.begin(main.id, { text: 'hola' })).toThrow(
      ChatError,
    )
    services.close()
    s.cleanup()
  })
})

describe('reply and follow-up context', () => {
  const items: TimelineItem[] = [
    {
      kind: 'utterance',
      id: 'uu1',
      sessionId: 's1',
      at: 1,
      speaker: 'user',
      label: null,
      speakerName: null,
      text: 'Hablamos de Berlín',
      originalText: null,
      corrected: false,
    },
    {
      kind: 'message',
      id: 'mm1',
      threadId: 't',
      at: 2,
      role: 'assistant',
      text: 'Berlín es la capital.',
      status: 'complete',
      replyTo: null,
      quote: null,
      actions: [],
    },
  ]

  test('quotes the message being answered in the final user turn', () => {
    const { messages } = buildContext({
      items,
      newMessage: {
        text: 'Dame más detalles',
        replyTo: {
          kind: 'message',
          id: 'mm1',
          label: 'Asistente',
          text: 'Berlín es la capital.',
        },
        quote: null,
      },
    })
    const last = messages.at(-1)
    expect(last?.role).toBe('user')
    expect(last?.content).toContain('Respondo a este mensaje de Asistente')
    expect(last?.content).toContain('> Berlín es la capital.')
    expect(last?.content.endsWith('Dame más detalles')).toBe(true)
  })

  test('a selection follow-up carries the selected fragment', () => {
    const { messages } = buildContext({
      items,
      newMessage: {
        text: '¿Qué significa?',
        replyTo: null,
        quote: 'la capital',
      },
    })
    expect(messages.at(-1)?.content).toContain(
      'Fragmento seleccionado:\n> la capital',
    )
  })

  test('transcript lines and messages get short refs the model can use', () => {
    const { messages, refs } = buildContext({
      items,
      newMessage: { text: 'hola', replyTo: null, quote: null },
    })
    expect(refs.get('u1')).toEqual({ kind: 'utterance', id: 'uu1' })
    expect(refs.get('m1')).toEqual({ kind: 'message', id: 'mm1' })
    expect(messages[0]?.content).toContain('u1 · Usuario · Hablamos de Berlín')
  })

  test('a reply target outside the window is still addressable', () => {
    const { refs } = buildContext({
      items: [],
      newMessage: {
        text: 'sigue',
        replyTo: {
          kind: 'message',
          id: 'old',
          label: 'Usuario',
          text: 'antes',
        },
        quote: null,
      },
    })
    expect([...refs.values()]).toContainEqual({ kind: 'message', id: 'old' })
  })

  test('recall goes to the system prompt only, and is marked private', () => {
    const { messages } = buildContext({
      items,
      newMessage: { text: 'hola', replyTo: null, quote: null },
      recall: ['La hermana del usuario se llama Ana'],
    })
    expect(messages[0]?.content).toContain('Notas privadas')
    expect(messages[0]?.content).toContain('Ana')
    expect(messages.slice(1).some((m) => m.content.includes('Ana'))).toBe(false)
  })

  test('the reply reaches the LLM end to end', async () => {
    const t = setup()
    const main = t.chat.mainThread()
    t.llm.replies = ['Respuesta uno.', 'Respuesta dos.']
    await drain(t.chat, main.id, { text: 'primera' })
    const first = messagesOf(t.chat, main.id).at(-1)
    await drain(t.chat, main.id, {
      text: 'sobre eso',
      replyTo: { kind: 'message', id: first!.id },
      quote: 'Respuesta',
    })
    const sent = t.llm.calls.at(-1)!.at(-1)!
    expect(sent.content).toContain('> Respuesta uno.')
    expect(sent.content).toContain('Fragmento seleccionado:\n> Respuesta')
    const stored = messagesOf(t.chat, main.id).at(-2)
    expect(stored?.kind === 'message' && stored.replyTo?.text).toBe(
      'Respuesta uno.',
    )
    t.done()
  })

  test('replying to an unknown message is refused', () => {
    const t = setup()
    const main = t.chat.mainThread()
    expect(() =>
      t.chat.begin(main.id, {
        text: 'x',
        replyTo: { kind: 'message', id: 'no-existe' },
      }),
    ).toThrow(ChatError)
    t.done()
  })
})

describe('op parsing', () => {
  test('the stripper hides a directive that arrives in pieces', () => {
    const s = new OpStripper()
    const shown: string[] = []
    for (const piece of [
      'Listo. <',
      '<o',
      'p {"op":"fo',
      'rk","ref":"m1"}>>',
    ]) {
      shown.push(s.push(piece))
    }
    shown.push(s.flush())
    expect(shown.join('')).toBe('Listo. ')
    expect(s.raw).toContain('<<op {"op":"fork"')
  })

  test('a lone "<" in plain text is not swallowed', () => {
    const s = new OpStripper()
    const out = s.push('3 < 5') + s.flush()
    expect(out).toBe('3 < 5')
  })

  test('parses valid ops and strips them from the visible text', () => {
    const p = parseOps(
      'Corregí la frase.\n<<op {"op":"correct","ref":"u1","text":"Berlín"}>>\n<<op {"op":"highlight","ref":"u1","quote":"Ber"}>>',
    )
    expect(p.text).toBe('Corregí la frase.')
    expect(p.ops.map((o) => o.op)).toEqual(['correct', 'highlight'])
    expect(p.rejected).toEqual([])
  })

  test('braces inside strings do not break the balanced parse', () => {
    const p = parseOps(
      '<<op {"op":"correct","ref":"u1","text":"a } b { c"}>> fin',
    )
    expect(p.ops[0]).toMatchObject({ op: 'correct', text: 'a } b { c' })
    expect(p.text).toBe('fin')
  })

  test('refuses unknown, malformed and truncated ops without leaking them', () => {
    const p = parseOps(
      'Ok <<op {"op":"delete_all"}>> <<op {nope}>> <<op {"op":"correct","ref":"u1"',
    )
    expect(p.ops).toEqual([])
    expect(p.rejected).toHaveLength(3)
    expect(p.text).toBe('Ok')
    expect(p.text).not.toContain('<<')
  })

  test('caps the number of ops per turn', () => {
    const one = '<<op {"op":"resume","query":"tema"}>>'
    const p = parseOps(one.repeat(6))
    expect(p.ops).toHaveLength(4)
    expect(p.rejected).toHaveLength(2)
  })

  test('search terms drop filler and short words', () => {
    expect(
      searchTerms('sigamos con el presupuesto de la cocina del transcript'),
    ).toEqual(['presupuesto', 'cocina'])
  })
})

describe('correction op', () => {
  test('keeps the original, shows the corrected text and can be reverted', async () => {
    const t = setup()
    seedSession(t.services)
    const main = t.chat.mainThread()
    t.llm.replies = [
      'Hecho, corregí la frase.\n<<op {"op":"correct","ref":"u1","text":"Quiero hablar del presupuesto del baño","reason":"mal transcrito"}>>',
    ]
    const events = await drain(t.chat, main.id, {
      text: 'antes hablamos del baño y el transcript dice cocina, corregilo',
    })
    const action = events.find((e) => e.type === 'action')
    expect(action && 'action' in action && action.action.type).toBe(
      'correction',
    )

    // The transcript table is untouched; the overlay carries the new text.
    const raw = t.services.notes.utterances.list('s1')[0]
    expect(raw?.text).toBe('Quiero hablar del presupuesto de la cocina')
    const u = t.chat
      .timeline(main.id)
      .items.find((i) => i.kind === 'utterance' && i.corrected)
    expect(u && u.kind === 'utterance' && u.text).toBe(
      'Quiero hablar del presupuesto del baño',
    )
    expect(u && u.kind === 'utterance' && u.originalText).toBe(
      'Quiero hablar del presupuesto de la cocina',
    )
    // The visible message has no directive.
    const reply = messagesOf(t.chat, main.id).at(-1)
    expect(reply?.kind === 'message' && reply.text).toBe(
      'Hecho, corregí la frase.',
    )

    expect(t.chat.revertCorrection('u1')).toBe(true)
    const back = t.chat.timeline(main.id).items.find((i) => i.id === 'u1')
    expect(back?.kind === 'utterance' && back.text).toBe(
      'Quiero hablar del presupuesto de la cocina',
    )
    expect(back?.kind === 'utterance' && back.corrected).toBe(false)
    expect(t.chat.revertCorrection('u1')).toBe(false)
    t.done()
  })

  test('a second correction keeps the transcribed text as the original', () => {
    const t = setup()
    seedSession(t.services)
    t.chat.correctUtterance('u3', 'Mi hermana se llama Anna', null, null)
    const second = t.chat.correctUtterance(
      'u3',
      'Mi hermana se llama Anaís',
      null,
      null,
    )
    expect(second.originalText).toBe('Mi hermana se llama Ana')
    t.chat.revertCorrection('u3')
    const now = t.chat
      .timeline(t.chat.mainThread().id)
      .items.find((i) => i.id === 'u3')
    // Reverting the latest brings back the previous correction.
    expect(now?.kind === 'utterance' && now.text).toBe(
      'Mi hermana se llama Anna',
    )
    t.done()
  })

  test('refuses an unknown utterance, an empty text and a no-op', () => {
    const t = setup()
    seedSession(t.services)
    expect(() => t.chat.correctUtterance('nope', 'x', null, null)).toThrow(
      ChatError,
    )
    expect(() => t.chat.correctUtterance('u1', '  ', null, null)).toThrow(
      ChatError,
    )
    expect(() =>
      t.chat.correctUtterance(
        'u1',
        'Quiero hablar del presupuesto de la cocina',
        null,
        null,
      ),
    ).toThrow(ChatError)
    t.done()
  })

  test('an op with an unknown ref becomes a visible rejection, not a silent failure', async () => {
    const t = setup()
    seedSession(t.services)
    const main = t.chat.mainThread()
    t.llm.replies = ['Listo.\n<<op {"op":"correct","ref":"u99","text":"x"}>>']
    const events = await drain(t.chat, main.id, { text: 'corrige' })
    const action = events.find((e) => e.type === 'action')
    expect(action && 'action' in action && action.action.type).toBe('rejected')
    t.done()
  })
})

describe('resume op', () => {
  test('searches transcripts and answers from the hits in a second pass', async () => {
    const t = setup()
    seedSession(t.services)
    const main = t.chat.mainThread()
    t.llm.replies = [
      'Busco ese tema.\n<<op {"op":"resume","query":"sigamos con el presupuesto"}>>',
      'Hablaron del presupuesto de la cocina.',
    ]
    const events = await drain(t.chat, main.id, {
      text: 'sigamos con el presupuesto',
    })
    expect(t.llm.calls).toHaveLength(2)
    expect(t.llm.calls[1]!.at(-1)!.content).toContain(
      'presupuesto de la cocina',
    )
    const reply = messagesOf(t.chat, main.id).at(-1)
    expect(reply?.kind === 'message' && reply.text).toContain(
      'Hablaron del presupuesto de la cocina.',
    )
    const resume = events.find(
      (e) => e.type === 'action' && e.action.type === 'resume',
    )
    expect(resume).toBeDefined()
    t.done()
  })

  test('says so when nothing matches', async () => {
    const t = setup()
    seedSession(t.services)
    const main = t.chat.mainThread()
    t.llm.replies = ['Busco.\n<<op {"op":"resume","query":"astronomía"}>>']
    await drain(t.chat, main.id, { text: 'sigamos con astronomía' })
    expect(t.llm.calls).toHaveLength(1)
    const reply = messagesOf(t.chat, main.id).at(-1)
    expect(reply?.kind === 'message' && reply.text).toContain(
      'No encontré ese tema',
    )
    t.done()
  })
})

describe('highlight op', () => {
  test('anchors the quote to a range in the target text', () => {
    const t = setup()
    seedSession(t.services)
    const main = t.chat.mainThread()
    const h = t.chat.highlight(
      main.id,
      'utterance',
      'u1',
      'presupuesto',
      'clave',
    )
    expect(h.start).toBe(18)
    expect(h.end).toBe(29)
    expect(h.quoted).toBe('presupuesto')
    expect(t.chat.timeline(main.id).highlights).toHaveLength(1)
    t.done()
  })

  test('refuses a quote that is not in the text, and an unknown target', () => {
    const t = setup()
    seedSession(t.services)
    const main = t.chat.mainThread()
    expect(() =>
      t.chat.highlight(main.id, 'utterance', 'u1', 'jirafa', null),
    ).toThrow(ChatError)
    expect(() =>
      t.chat.highlight(main.id, 'utterance', 'zz', 'a', null),
    ).toThrow(ChatError)
    expect(() => t.chat.highlight(main.id, 'message', 'zz', 'a', null)).toThrow(
      ChatError,
    )
    t.done()
  })

  test('is applied through the op, against the corrected text', async () => {
    const t = setup()
    seedSession(t.services)
    const main = t.chat.mainThread()
    t.chat.correctUtterance('u1', 'Quiero hablar del baño', null, null)
    t.llm.replies = [
      'Lo resalté.\n<<op {"op":"highlight","ref":"u1","quote":"baño"}>>',
    ]
    await drain(t.chat, main.id, { text: 'resalta baño' })
    const [h] = t.chat.timeline(main.id).highlights
    expect(h).toMatchObject({ targetId: 'u1', quoted: 'baño' })
    t.done()
  })
})

describe('fork', () => {
  async function conversation(t: ReturnType<typeof setup>) {
    seedSession(t.services)
    const main = t.chat.mainThread()
    t.llm.replies = ['Uno.', 'Dos.', 'Tres.']
    await drain(t.chat, main.id, { text: 'a' })
    await drain(t.chat, main.id, { text: 'b' })
    return main
  }

  test('copies the history up to the message into a new thread', async () => {
    const t = setup()
    const main = await conversation(t)
    const msgs = messagesOf(t.chat, main.id)
    expect(msgs).toHaveLength(4)
    const fork = t.chat.fork(main.id, msgs[1]!.id, 'Rama')
    expect(fork).toMatchObject({
      title: 'Rama',
      forkedFromThread: main.id,
      forkedFromMessage: msgs[1]!.id,
    })
    const copied = messagesOf(t.chat, fork.id)
    expect(copied.map((m) => m.kind === 'message' && m.text)).toEqual([
      'a',
      'Uno.',
    ])
    // New ids: editing one thread never touches the other.
    expect(copied.map((m) => m.id)).not.toContain(msgs[0]!.id)
    // The source is untouched.
    expect(messagesOf(t.chat, main.id)).toHaveLength(4)
    t.done()
  })

  test('the fork only shows transcripts up to the fork point', async () => {
    const t = setup()
    seedSession(t.services)
    const main = t.chat.mainThread()
    t.llm.replies = ['Uno.']
    // Message timestamps come from the clock, far after the seeded utterances; so seed one after the fork point.
    await drain(t.chat, main.id, { text: 'a' })
    const first = messagesOf(t.chat, main.id)[0]!
    t.services.notes.utterances.add({
      id: 'late',
      sessionId: 's1',
      speaker: 'user',
      tStart: first.at + 10_000,
      tEnd: first.at + 10_100,
      text: 'dicho después',
      source: 'stt',
    })
    expect(t.chat.timeline(main.id).items.some((i) => i.id === 'late')).toBe(
      true,
    )
    const fork = t.chat.fork(main.id, first.id)
    expect(t.chat.timeline(fork.id).items.some((i) => i.id === 'late')).toBe(
      false,
    )
    t.done()
  })

  test('replies and highlights are remapped to the copies', async () => {
    const t = setup()
    const main = await conversation(t)
    const [a, uno, b] = messagesOf(t.chat, main.id)
    t.chat.highlight(main.id, 'message', uno!.id, 'Uno', null)
    // Reply of "b" points to "uno".
    t.llm.replies = ['Cuatro.']
    await drain(t.chat, main.id, {
      text: 'c',
      replyTo: { kind: 'message', id: uno!.id },
    })
    const msgs = messagesOf(t.chat, main.id)
    const fork = t.chat.fork(main.id, msgs.at(-2)!.id)
    const tl = t.chat.timeline(fork.id)
    const copiedUno = tl.items.find(
      (i) => i.kind === 'message' && i.text === 'Uno.',
    )!
    expect(tl.highlights).toHaveLength(1)
    expect(tl.highlights[0]).toMatchObject({
      targetId: copiedUno.id,
      quoted: 'Uno',
    })
    expect(tl.highlights[0]!.targetId).not.toBe(uno!.id)
    const copiedC = tl.items.find((i) => i.kind === 'message' && i.text === 'c')
    expect(copiedC?.kind === 'message' && copiedC.replyTo?.id).toBe(
      copiedUno.id,
    )
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    t.done()
  })

  test('refuses a message that is not in the thread', async () => {
    const t = setup()
    const main = await conversation(t)
    expect(() => t.chat.fork(main.id, 'nope')).toThrow(ChatError)
    const other = t.chat.fork(main.id, messagesOf(t.chat, main.id)[0]!.id)
    expect(() =>
      t.chat.fork(other.id, messagesOf(t.chat, main.id)[2]!.id),
    ).toThrow(ChatError)
    t.done()
  })

  test('through the op: the thread is created and reported as an action', async () => {
    const t = setup()
    const main = await conversation(t)
    const target = messagesOf(t.chat, main.id)[1]!
    // m-refs are assigned in window order: a, Uno, b, Dos => Uno is m2.
    t.llm.replies = [
      'Abrí una rama.\n<<op {"op":"fork","ref":"m2","title":"Rama op"}>>',
    ]
    const events = await drain(t.chat, main.id, {
      text: 'bifurca desde la primera respuesta',
    })
    const action = events.find((e) => e.type === 'action')
    expect(action && 'action' in action && action.action).toMatchObject({
      type: 'fork',
      title: 'Rama op',
    })
    const forked = t.chat.listThreads().find((x) => x.title === 'Rama op')
    expect(forked?.forkedFromMessage).toBe(target.id)
    t.done()
  })
})

describe('GraphQL and SSE', () => {
  const s = scratch()
  const llm = new ScriptedLlm()
  const services = createServices(
    { ...loadStorageConfig({}), dataDir: s.dir, folders: [] },
    {
      embedder: new FakeEmbedder(),
      db: openDb(':memory:'),
      llm: null,
      chatLlm: llm,
    },
  )
  afterAll(() => {
    services.close()
    s.cleanup()
  })
  seedSession(services)
  const SECRET = 'DATO-INTERNO-PRIVADO la hermana se llama Ana'
  // With a vector, so recall finds it by similarity (a lexical-only match falls under the recall threshold).
  services.notes.search.index(
    services.notes.notes.add({
      sessionId: 's1',
      kind: 'internal',
      body: SECRET,
      createdAt: 1500,
      location: 'Salto',
      speakers: ['user'],
      embedding: bagOfWords(SECRET),
    }),
  )
  const core = createCore({ port: 0, cartesiaApiKey: undefined }, services)

  const gql = async (query: string) => {
    const res = await core.app.handle(
      new Request('http://127.0.0.1/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      }),
    )
    return { raw: await res.text() }
  }
  const sse = (body: unknown, headers: Record<string, string> = {}) =>
    core.app.handle(
      new Request('http://127.0.0.1/chat/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    )

  test('the schema has no path to internal notes', () => {
    const sdl = printSchema(schema)
    const chatTypes = sdl
      .split('\n\n')
      .filter((b) => /type Chat\w+/.test(b))
      .join('\n')
    expect(chatTypes.length).toBeGreaterThan(0)
    // No field or type that exposes the notes tables (`note` on ChatHighlight is the user's own annotation).
    expect(chatTypes).not.toMatch(/internal|embedding/i)
    expect(chatTypes).not.toMatch(/\b(Note|NoteHit|ExternalNote|SessionNote)\b/)
  })

  test('the timeline never contains internal notes, even when they are recalled', async () => {
    llm.replies = ['De acuerdo.']
    const main = JSON.parse((await gql('{ chatMain { id } }')).raw).data
      .chatMain
    await sse({ threadId: main.id, text: 'cómo se llama mi hermana' }).then(
      (r) => r.text(),
    )
    // The private note reached the model...
    expect(llm.calls.at(-1)![0]!.content).toContain('Notas privadas')
    // ...but nothing the UI can ask for carries it.
    const out = await gql(
      `{ chatTimeline(threadId: "${main.id}") { items { text originalText quote replyTo { text } actions { reason original corrected quoted title } } highlights { quoted note } sessions { title } } chatThreads { title } }`,
    )
    expect(out.raw).not.toContain('DATO-INTERNO-PRIVADO')
  })

  test('chatTimeline returns the merged items and fork works over GraphQL', async () => {
    const main = JSON.parse((await gql('{ chatMain { id } }')).raw).data
      .chatMain
    const tl = JSON.parse(
      (
        await gql(
          `{ chatTimeline(threadId: "${main.id}") { items { kind id text role } } }`,
        )
      ).raw,
    ).data.chatTimeline
    const kinds = new Set(tl.items.map((i: { kind: string }) => i.kind))
    expect(kinds).toEqual(new Set(['utterance', 'message']))
    const msg = tl.items.find((i: { kind: string }) => i.kind === 'message')
    const forked = JSON.parse(
      (
        await gql(
          `mutation { forkChat(threadId: "${main.id}", messageId: "${msg.id}", title: "Rama") { id title forkedFromMessage } }`,
        )
      ).raw,
    ).data.forkChat
    expect(forked).toMatchObject({ title: 'Rama', forkedFromMessage: msg.id })
    const bad = JSON.parse(
      (
        await gql(
          `mutation { forkChat(threadId: "${main.id}", messageId: "nope") { id } }`,
        )
      ).raw,
    )
    expect(bad.errors?.[0]?.message).toContain('no está')
  })

  test('revertCorrection works over GraphQL', async () => {
    services.chat.correctUtterance('u3', 'Mi hermana se llama Anna', null, null)
    const ok = JSON.parse(
      (await gql('mutation { revertCorrection(utteranceId: "u3") }')).raw,
    )
    expect(ok.data.revertCorrection).toBe(true)
  })

  test('the SSE stream emits user, delta and done events', async () => {
    llm.replies = ['Respuesta por SSE.']
    const main = services.chat.mainThread()
    const res = await sse({ threadId: main.id, text: 'hola' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const body = await res.text()
    const names = [...body.matchAll(/^event: (\w+)$/gm)].map((m) => m[1])
    expect(names[0]).toBe('user')
    expect(names).toContain('delta')
    expect(names.at(-1)).toBe('done')
  })

  test('SSE refuses a foreign origin, a wrong content type, bad bodies and unknown threads', async () => {
    const main = services.chat.mainThread()
    expect(
      (
        await sse(
          { threadId: main.id, text: 'x' },
          { origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403)
    const form = await core.app.handle(
      new Request('http://127.0.0.1/chat/send', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ threadId: main.id, text: 'x' }),
      }),
    )
    expect(form.status).toBe(415)
    expect((await sse({ nope: true })).status).toBe(400)
    expect((await sse({ threadId: 'zzz', text: 'x' })).status).toBe(404)
    expect((await sse({ threadId: main.id, text: '   ' })).status).toBe(400)
  })

  test('the preflight answers an allowed origin and blocks the rest', async () => {
    const ok = await core.app.handle(
      new Request('http://127.0.0.1/chat/send', {
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:1420' },
      }),
    )
    expect(ok.status).toBe(204)
    expect(ok.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:1420',
    )
    const bad = await core.app.handle(
      new Request('http://127.0.0.1/chat/send', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example' },
      }),
    )
    expect(bad.status).toBe(403)
  })
})
