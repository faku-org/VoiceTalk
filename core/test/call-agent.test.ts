import { describe, expect, test } from 'bun:test'
import type { AgentPort, AgentRunHandle } from '../src/agent/service.ts'
import { spokenPermission, spokenSummary } from '../src/agent/speech.ts'
import {
  AgentError,
  type AgentEvent,
  type ApprovalRequest,
  type ApprovalChoice,
} from '../src/agent/types.ts'
import { parseOps, validateOp } from '../src/chat/ops.ts'
import {
  CallEvents,
  CallSession,
  CallStore,
  parseClientControl,
  type AgentStep,
  type CallOutput,
  type ServerEvent,
  type SttEvent,
  type SttHandlers,
  type SttLink,
} from '../src/call/index.ts'
import type {
  ChatMessage,
  ChatOptions,
  ChatProvider,
} from '../src/llm/index.ts'
import { AGENT_PROMPT } from '../src/llm/persona.ts'
import type { TtsOptions, TtsProvider } from '../src/tts/index.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(cond: () => boolean, ms = 1500): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms)
      throw new Error('timeout waiting for condition')
    await sleep(2)
  }
}

class FakeLlm implements ChatProvider {
  readonly name = 'fake'
  calls: ChatMessage[][] = []
  constructor(private readonly tokens: string[]) {}
  async *stream(
    messages: ChatMessage[],
    _opts: ChatOptions = {},
  ): AsyncGenerator<string> {
    this.calls.push(messages)
    for (const t of this.tokens) yield t
  }
}

class FakeTts implements TtsProvider {
  readonly name = 'fake'
  texts: string[] = []
  async *stream(
    text: string,
    _opts: TtsOptions = {},
  ): AsyncGenerator<Uint8Array> {
    this.texts.push(text)
    yield new Uint8Array(480)
  }
}

class FakeAgent implements AgentPort {
  on = true
  online = true
  failWith: Error | null = null
  tasks: string[] = []
  sessions: Array<string | undefined> = []
  answers: ApprovalChoice[] = []
  stopped = 0
  sink: (ev: AgentEvent) => void = () => undefined
  enabled(): boolean {
    return this.on
  }
  async status() {
    return {
      enabled: this.on,
      hasKey: true,
      online: this.online,
      reason: this.online ? null : 'Hermes unreachable',
    }
  }
  async run(
    task: string,
    sink: (ev: AgentEvent) => void,
    opts: { sessionKey?: string } = {},
  ): Promise<AgentRunHandle> {
    if (this.failWith) throw this.failWith
    this.tasks.push(task)
    this.sessions.push(opts.sessionKey)
    this.sink = sink
    return {
      runId: 'run_1',
      pending: undefined,
      answer: async (choice) => {
        this.answers.push(choice)
      },
      stop: async () => {
        this.stopped++
      },
      detach: () => undefined,
      done: Promise.resolve(),
    }
  }
}

function setup(llm: ChatProvider, tts: TtsProvider, agent: AgentPort) {
  const json: ServerEvent[] = []
  const out: CallOutput = { json: (e) => json.push(e), audio: () => undefined }
  const store = new CallStore(new CallEvents())
  const links: Array<{ handlers: SttHandlers }> = []
  const session = new CallSession({
    stt: (handlers): SttLink => {
      links.push({ handlers })
      return { sendAudio: () => undefined, close: () => undefined }
    },
    llm,
    tts,
    out,
    store,
    agent,
  })
  const say = (text: string): void =>
    links[links.length - 1]!.handlers.onEvent({
      type: 'final',
      text,
      raw: text,
      t_start: 0,
      t_end: 1,
      stt_ms: 1,
    } satisfies SttEvent)
  const agentStates = (): string[] =>
    json.flatMap((e) => (e.type === 'agent' ? [e.state] : []))
  const steps = (): AgentStep[] =>
    json.flatMap((e) => (e.type === 'agent_step' ? [e.step] : []))
  const callStates = (): string[] =>
    json.flatMap((e) => (e.type === 'state' ? [e.state] : []))
  return { session, json, say, agentStates, steps, callStates }
}

const req = (description: string, command?: string): ApprovalRequest => ({
  requestId: undefined,
  executionGeneration: undefined,
  description,
  command,
})

const ACT = '<<op {"op":"act","task":"lista los archivos del Escritorio"}>>'

describe('call loop hands a task to the agent', () => {
  test('act op: brain line is spoken, the directive is not, the task starts', async () => {
    const llm = new FakeLlm(['Voy con eso. ', ACT])
    const tts = new FakeTts()
    const agent = new FakeAgent()
    const h = setup(llm, tts, agent)
    h.session.start()
    h.say('lista el escritorio')

    await until(() => agent.tasks.length === 1)
    expect(agent.tasks[0]).toBe('lista los archivos del Escritorio')
    expect(agent.sessions[0]).toStartWith('voicetalk-')
    expect(tts.texts.join(' ')).not.toContain('<<op')
    expect(tts.texts.join(' ')).not.toContain('act')
    expect(llm.calls[0]![0]!.content).toContain(AGENT_PROMPT)
    expect(h.agentStates()).toContain('working')
    expect(h.steps()[0]).toMatchObject({ kind: 'task', status: 'running' })

    agent.sink({
      type: 'completed',
      output: 'Hay **3** archivos en el Escritorio.',
    })
    await until(() => h.agentStates().at(-1) === 'idle')
    expect(h.steps().at(-1)).toMatchObject({ kind: 'task', status: 'done' })
    await until(() => tts.texts.includes('Hay 3 archivos en el Escritorio.'))
  })

  test('only an op without text still gets a short spoken line', async () => {
    const tts = new FakeTts()
    const agent = new FakeAgent()
    const h = setup(new FakeLlm([ACT]), tts, agent)
    h.session.start()
    h.say('abrí el bloc de notas')
    await until(() => tts.texts.includes('Voy con eso.'))
    expect(agent.tasks).toHaveLength(1)
  })

  test('approval: attention, pending step, answer once goes to Hermes', async () => {
    const tts = new FakeTts()
    const agent = new FakeAgent()
    const h = setup(new FakeLlm(['Voy con eso. ', ACT]), tts, agent)
    h.session.start()
    h.say('borrá el archivo')
    await until(() => agent.tasks.length === 1)

    agent.sink({
      type: 'approval',
      request: req('Borrar prueba.txt', 'rm prueba.txt'),
    })
    await until(() => h.agentStates().at(-1) === 'attention')
    const pending = h.steps().find((s) => s.kind === 'approval')!
    expect(pending).toMatchObject({
      status: 'pending',
      title: 'Borrar prueba.txt',
      detail: 'rm prueba.txt',
    })
    await until(() =>
      tts.texts.includes('Necesito tu permiso: Borrar prueba.txt.'),
    )

    h.session.answerApproval('otro-id', 'once') // unknown id: ignored
    expect(agent.answers).toEqual([])
    h.session.answerApproval(pending.id, 'once')
    await until(() => agent.answers.length === 1)
    expect(agent.answers).toEqual(['once'])
    expect(h.steps().at(-1)).toMatchObject({
      id: pending.id,
      status: 'allowed',
    })
    expect(h.agentStates().at(-1)).toBe('working')
  })

  test('deny answers deny and a second answer is a no-op', async () => {
    const agent = new FakeAgent()
    const h = setup(new FakeLlm(['Voy con eso. ', ACT]), new FakeTts(), agent)
    h.session.start()
    h.say('x')
    await until(() => agent.tasks.length === 1)
    agent.sink({ type: 'approval', request: req('Click en Guardar') })
    await until(() => h.steps().some((s) => s.kind === 'approval'))
    const id = h.steps().find((s) => s.kind === 'approval')!.id
    h.session.answerApproval(id, 'deny')
    h.session.answerApproval(id, 'once')
    await until(() => agent.answers.length >= 1)
    await sleep(10)
    expect(agent.answers).toEqual(['deny'])
    expect(h.steps().at(-1)).toMatchObject({ status: 'denied' })
  })

  test('a run that ends with an open approval cancels it', async () => {
    const agent = new FakeAgent()
    const h = setup(new FakeLlm(['Voy con eso. ', ACT]), new FakeTts(), agent)
    h.session.start()
    h.say('x')
    await until(() => agent.tasks.length === 1)
    agent.sink({ type: 'approval', request: req('Escribir archivo') })
    await until(() => h.steps().some((s) => s.kind === 'approval'))
    agent.sink({ type: 'cancelled' })
    await until(() => h.agentStates().at(-1) === 'idle')
    const approval = h.steps().filter((s) => s.kind === 'approval')
    expect(approval.at(-1)?.status).toBe('cancelled')
    expect(
      h
        .steps()
        .filter((s) => s.kind === 'task')
        .at(-1)?.status,
    ).toBe('cancelled')
  })

  test('Hermes unreachable: offline, failed step, the call keeps working', async () => {
    const tts = new FakeTts()
    const agent = new FakeAgent()
    agent.failWith = new AgentError('Hermes unreachable')
    const h = setup(new FakeLlm(['Voy con eso. ', ACT]), tts, agent)
    h.session.start()
    h.say('x')
    await until(() => h.agentStates().includes('offline'))
    expect(h.steps().at(-1)).toMatchObject({ kind: 'task', status: 'failed' })
    await until(() =>
      tts.texts.includes('No puedo conectar con el agente ahora.'),
    )
    await until(() => h.callStates().at(-1) === 'listening')
    expect(h.json.some((e) => e.type === 'error')).toBe(false)
  })

  test('probe on connect reports offline without a task', async () => {
    const agent = new FakeAgent()
    agent.online = false
    const h = setup(new FakeLlm(['hola']), new FakeTts(), agent)
    h.session.start()
    await until(() => h.agentStates().includes('offline'))
  })

  test('disabled agent: no hint to the brain, nothing is stripped or run', async () => {
    const llm = new FakeLlm(['Hola. '])
    const agent = new FakeAgent()
    agent.on = false
    const h = setup(llm, new FakeTts(), agent)
    h.session.start()
    h.say('hola')
    await until(() => llm.calls.length === 1)
    expect(llm.calls[0]![0]!.content).not.toContain(AGENT_PROMPT)
    await sleep(10)
    expect(agent.tasks).toEqual([])
    expect(h.agentStates()).toEqual([])
  })

  test('ending the call stops the run', async () => {
    const agent = new FakeAgent()
    const h = setup(new FakeLlm(['Voy con eso. ', ACT]), new FakeTts(), agent)
    h.session.start()
    h.say('x')
    await until(() => agent.tasks.length === 1)
    await sleep(5)
    h.session.stop('client')
    await until(() => agent.stopped === 1)
  })

  test('stopAgent asks Hermes to stop the run', async () => {
    const agent = new FakeAgent()
    const h = setup(new FakeLlm(['Voy con eso. ', ACT]), new FakeTts(), agent)
    h.session.start()
    h.say('x')
    await until(() => agent.tasks.length === 1)
    await sleep(5)
    h.session.stopAgent()
    await until(() => agent.stopped === 1)
  })
})

describe('act op and client frames', () => {
  test('validateOp accepts act with a task and rejects it without one', () => {
    expect(validateOp({ op: 'act', task: '  abrir notas ' })).toEqual({
      op: 'act',
      task: 'abrir notas',
    })
    expect(validateOp({ op: 'act' })).toMatchObject({
      op: 'act',
      reason: expect.any(String),
    })
  })

  test('parseOps keeps act ops and removes the directive from the text', () => {
    const parsed = parseOps(`Voy con eso. ${ACT}`)
    expect(parsed.text).toBe('Voy con eso.')
    expect(parsed.ops).toEqual([
      { op: 'act', task: 'lista los archivos del Escritorio' },
    ])
    expect(parsed.rejected).toEqual([])
    expect(parseOps('<<op {"op":"act"}>>').rejected).toHaveLength(1)
  })

  test('parseClientControl accepts the known frames only', () => {
    expect(parseClientControl('{"type":"stop"}')).toEqual({ type: 'stop' })
    expect(parseClientControl('{"type":"agent_stop"}')).toEqual({
      type: 'agent_stop',
    })
    expect(
      parseClientControl('{"type":"approval","id":"a","choice":"once"}'),
    ).toEqual({
      type: 'approval',
      id: 'a',
      choice: 'once',
    })
    expect(
      parseClientControl('{"type":"approval","id":"a","choice":"always"}'),
    ).toBeNull()
    expect(parseClientControl('{"type":"approval","choice":"once"}')).toBeNull()
    expect(parseClientControl('nope')).toBeNull()
    expect(parseClientControl('{"type":"unknown"}')).toBeNull()
  })

  test('spoken lines are short plain text', () => {
    expect(spokenSummary('')).toBe('Listo.')
    expect(
      spokenSummary(
        '```\nls\n```\n# Resultado\nHay 3 archivos. Uno es `a.txt`. Otro más. Y otro.',
      ),
    ).toBe('Resultado Hay 3 archivos. Uno es a.txt.')
    expect(spokenSummary('x'.repeat(400)).length).toBeLessThan(200)
    expect(spokenPermission('Borrar **a.txt**')).toBe(
      'Necesito tu permiso: Borrar a.txt.',
    )
    expect(spokenPermission('')).toBe('Necesito tu permiso para continuar.')
  })
})
