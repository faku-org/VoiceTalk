import { afterEach, describe, expect, test } from 'bun:test'
import { createCore } from '../src/app.ts'
import { CallEvents } from '../src/call/events.ts'
import { CallStore } from '../src/call/store.ts'
import type { SttHandlers, SttLink } from '../src/call/stt-client.ts'
import { openDb } from '../src/db/index.ts'
import { isAddressed, shouldAnswer } from '../src/discord/addressed.ts'
import {
  Downsampler48kStereoTo16kMono,
  Upsampler24kMonoTo48kStereo,
  bytesToInt16,
  int16ToBytes,
  rms,
  silence,
} from '../src/discord/audio.ts'
import {
  DEFAULT_NAMES,
  INVITE_PERMISSIONS,
  discordAvailable,
  inviteUrl,
  loadDiscordConfig,
} from '../src/discord/config.ts'
import { setDiscordService } from '../src/discord/registry.ts'
import type {
  CommandContext,
  DiscordGateway,
  GuildRef,
  JoinTarget,
  VoiceConnection,
  VoiceHandlers,
} from '../src/discord/gateway.ts'
import {
  DiscordError,
  DiscordService,
  announcement,
} from '../src/discord/service.ts'
import { FLUSH_SILENCE_MS } from '../src/discord/session.ts'
import type {
  ChatMessage,
  ChatOptions,
  ChatProvider,
} from '../src/llm/index.ts'
import {
  DECISION_PROMPT,
  createNotesService,
  type RecorderPrefs,
} from '../src/notes/index.ts'
import type { TtsOptions, TtsProvider } from '../src/tts/index.ts'
import { FakeEmbedder } from './helpers.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(cond: () => boolean, ms = 1500): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms)
      throw new Error('timeout waiting for condition')
    await sleep(2)
  }
}

// ---- doubles ---------------------------------------------------------------------------------------------------

const GUILD: GuildRef = {
  id: 'g1',
  name: 'Los Pibes',
  voiceChannels: [
    { id: 'v1', name: 'General' },
    { id: 'v2', name: 'Otro' },
  ],
}
const TARGET: JoinTarget = { guildId: 'g1', channelId: 'v1' }

class FakeConn implements VoiceConnection {
  names = new Map<string, string>()
  played: Uint8Array[] = []
  stops = 0
  left = false
  displayName(userId: string): string {
    return this.names.get(userId) ?? userId
  }
  play(pcm: Uint8Array): void {
    this.played.push(pcm)
  }
  stopPlayback(): void {
    this.stops++
  }
  leave(): void {
    this.left = true
  }
}

class FakeGateway implements DiscordGateway {
  loginError: Error | null = null
  announceError: Error | null = null
  conn = new FakeConn()
  handlers: VoiceHandlers | null = null
  /** Order of events, to prove the notice goes out before anything is transcribed. */
  log: string[] = []
  announced: string[] = []
  commandHandler: ((ctx: CommandContext) => Promise<void>) | null = null
  destroyed = false

  botName(): string {
    return 'VoiceTalk'
  }
  async login(): Promise<void> {
    if (this.loginError) throw this.loginError
  }
  guilds(): GuildRef[] {
    return [GUILD]
  }
  async joinVoice(
    _target: JoinTarget,
    handlers: VoiceHandlers,
  ): Promise<VoiceConnection> {
    this.log.push('join')
    this.handlers = handlers
    return this.conn
  }
  async announce(_target: JoinTarget, text: string): Promise<void> {
    this.log.push('announce')
    if (this.announceError) throw this.announceError
    this.announced.push(text)
  }
  onCommand(handler: (ctx: CommandContext) => Promise<void>): void {
    this.commandHandler = handler
  }
  async destroy(): Promise<void> {
    this.destroyed = true
  }
}

interface FakeLink {
  handlers: SttHandlers
  frames: Uint8Array[]
  closed: boolean
}

function fakeStt() {
  const links: FakeLink[] = []
  const connector = (handlers: SttHandlers): SttLink => {
    const rec: FakeLink = { handlers, frames: [], closed: false }
    links.push(rec)
    return {
      sendAudio: (f) => rec.frames.push(f),
      close: () => (rec.closed = true),
    }
  }
  const say = (link: FakeLink, text: string): void => {
    link.handlers.onEvent({ type: 'speech_start', t: 0 })
    link.handlers.onEvent({
      type: 'final',
      text,
      raw: text,
      t_start: 0,
      t_end: 1,
      stt_ms: 1,
    })
  }
  return { links, connector, say }
}

class FakeLlm implements ChatProvider {
  readonly name = 'fake'
  calls: ChatMessage[][] = []
  constructor(private readonly tokens: string[] = ['Hola. ', 'Acá estoy.']) {}
  async *stream(
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): AsyncGenerator<string> {
    this.calls.push(messages.map((m) => ({ ...m })))
    for (const t of this.tokens) {
      if (opts.signal?.aborted) return
      yield t
    }
  }
}

class FakeTts implements TtsProvider {
  readonly name = 'fake'
  texts: string[] = []
  constructor(private readonly gapMs = 0) {}
  async *stream(
    text: string,
    opts: TtsOptions = {},
  ): AsyncGenerator<Uint8Array> {
    this.texts.push(text)
    for (let i = 0; i < 2; i++) {
      if (opts.signal?.aborted) return
      yield new Uint8Array(480)
      if (this.gapMs) await sleep(this.gapMs)
    }
  }
}

/** Scripted local model for the notes service: the decision calls are told apart by their prompt. */
class NotesLlm implements ChatProvider {
  readonly name = 'notes-mock'
  summaries: string[] = []
  async *stream(messages: ChatMessage[]): AsyncGenerator<string> {
    if (messages[0]?.content === DECISION_PROMPT)
      yield JSON.stringify({ action: 'none' })
    else {
      const next = this.summaries.shift()
      if (next === undefined) throw new Error('mock: nothing scripted')
      yield next
    }
  }
}

interface SetupOptions {
  address?: 'name' | 'always'
  tts?: TtsProvider | null
  llm?: ChatProvider
  emptyGraceMs?: number
}

function setup(opts: SetupOptions = {}) {
  const events = new CallEvents()
  const store = new CallStore(events)
  const gateway = new FakeGateway()
  const stt = fakeStt()
  const llm = opts.llm ?? new FakeLlm()
  const tts = opts.tts === undefined ? new FakeTts() : opts.tts
  const logs: string[] = []
  const service = new DiscordService({
    config: {
      enabled: true,
      token: 'x'.repeat(10),
      appId: '123',
      names: DEFAULT_NAMES,
      address: opts.address ?? 'name',
    },
    gateway,
    llm,
    tts,
    stt: stt.connector,
    store,
    log: (l) => logs.push(l),
    emptyGraceMs: opts.emptyGraceMs,
  })
  const db = openDb(':memory:')
  const notesLlm = new NotesLlm()
  const notes = createNotesService({
    db,
    embedder: new FakeEmbedder(),
    llm: notesLlm,
    events,
    prefs: (): RecorderPrefs => ({ threshold: 0.6, location: 'Montevideo' }),
    intervalMs: 3_600_000,
  })
  notes.recorder.start()
  const byUser = new Map<string, FakeLink>()
  return {
    events,
    store,
    gateway,
    stt,
    llm,
    tts,
    logs,
    service,
    notes,
    notesLlm,
    byUser,
  }
}

type Ctx = ReturnType<typeof setup>

const handlersOf = (c: Ctx): VoiceHandlers =>
  c.gateway.handlers as VoiceHandlers

/** Starts the service and joins. */
async function joined(
  opts: SetupOptions & { talk?: boolean } = {},
): Promise<Ctx> {
  const c = setup(opts)
  await c.service.start()
  await c.service.join(TARGET, { talk: opts.talk })
  return c
}

/** One member talks: speaking start, a bit of audio, then the transcript the sidecar would return. */
function speak(c: Ctx, userId: string, name: string, text: string): void {
  c.gateway.conn.names.set(userId, name)
  const h = handlersOf(c)
  const before = c.stt.links.length
  h.onSpeakingStart(userId)
  h.onAudio(userId, new Uint8Array(640))
  if (c.stt.links.length > before)
    c.byUser.set(userId, c.stt.links[c.stt.links.length - 1] as FakeLink)
  c.stt.say(c.byUser.get(userId) as FakeLink, text)
}

const commandHandler = (c: Ctx) =>
  c.gateway.commandHandler as NonNullable<typeof c.gateway.commandHandler>

// ---- config ----------------------------------------------------------------------------------------------------

describe('config', () => {
  test('without a token the feature is unavailable', () => {
    const c = loadDiscordConfig({})
    expect(c.token).toBeUndefined()
    expect(discordAvailable(c)).toBe(false)
  })

  test('token present enables it, VT_DISCORD=off disables it', () => {
    expect(
      discordAvailable(loadDiscordConfig({ DISCORD_BOT_TOKEN: 't' })),
    ).toBe(true)
    for (const off of ['off', 'OFF', '0', 'false'])
      expect(
        discordAvailable(
          loadDiscordConfig({ DISCORD_BOT_TOKEN: 't', VT_DISCORD: off }),
        ),
      ).toBe(false)
  })

  test('address mode and names come from env', () => {
    expect(loadDiscordConfig({}).address).toBe('name')
    expect(loadDiscordConfig({}).names).toEqual(DEFAULT_NAMES)
    const c = loadDiscordConfig({
      VT_DISCORD_ADDRESS: 'always',
      VT_DISCORD_NAMES: ' friday , jarvis ,',
    })
    expect(c.address).toBe('always')
    expect(c.names).toEqual(['friday', 'jarvis'])
  })

  test('invite url asks for the minimal scopes and permissions', () => {
    expect(inviteUrl(undefined)).toBeNull()
    const url = new URL(inviteUrl('42') as string)
    expect(url.searchParams.get('client_id')).toBe('42')
    expect(url.searchParams.get('scope')).toBe('bot applications.commands')
    expect(url.searchParams.get('permissions')).toBe(String(INVITE_PERMISSIONS))
    // Connect, Speak, Use Application Commands, Send Messages: nothing else.
    expect(BigInt(INVITE_PERMISSIONS)).toBe(
      (1n << 20n) | (1n << 21n) | (1n << 31n) | (1n << 11n),
    )
  })
})

// ---- audio -----------------------------------------------------------------------------------------------------

function tone(freq: number, rate: number, seconds: number, channels: number) {
  const n = Math.round(rate * seconds)
  const out = new Int16Array(n * channels)
  for (let i = 0; i < n; i++) {
    const v = Math.round(12000 * Math.sin((2 * Math.PI * freq * i) / rate))
    for (let c = 0; c < channels; c++) out[i * channels + c] = v
  }
  return int16ToBytes(out)
}

const concat = (parts: Uint8Array[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => [...p]))

describe('audio', () => {
  test('48 kHz stereo -> 16 kHz mono: a third of the frames, speech band kept', () => {
    const out = new Downsampler48kStereoTo16kMono().push(tone(440, 48000, 1, 2))
    expect(bytesToInt16(out).length).toBe(16000)
    expect(rms(out)).toBeGreaterThan(0.2)
  })

  test('a tone above the 16 kHz Nyquist is filtered out', () => {
    const out = new Downsampler48kStereoTo16kMono().push(
      tone(11000, 48000, 1, 2),
    )
    expect(rms(out)).toBeLessThan(0.1)
  })

  test('chunks split mid stereo frame give the same result as one push', () => {
    const src = tone(300, 48000, 0.5, 2)
    const whole = new Downsampler48kStereoTo16kMono().push(src)
    const d = new Downsampler48kStereoTo16kMono()
    const parts: Uint8Array[] = []
    for (let i = 0; i < src.length; i += 1001)
      parts.push(d.push(src.subarray(i, i + 1001)))
    expect(concat(parts)).toEqual(whole)
  })

  test('24 kHz mono -> 48 kHz stereo is four samples per input sample', () => {
    const src = tone(440, 24000, 0.1, 1)
    const out = new Upsampler24kMonoTo48kStereo().push(src)
    expect(bytesToInt16(out).length).toBe(bytesToInt16(src).length * 4)
  })

  test('upsampler carries an odd trailing byte to the next chunk', () => {
    const src = tone(440, 24000, 0.05, 1)
    const whole = new Upsampler24kMonoTo48kStereo().push(src)
    const u = new Upsampler24kMonoTo48kStereo()
    const a = u.push(src.subarray(0, 101))
    const b = u.push(src.subarray(101))
    expect(concat([a, b])).toEqual(whole)
  })

  test('silence is zero pcm of the requested length', () => {
    const s = silence(800)
    expect(s.byteLength).toBe(16000 * 0.8 * 2)
    expect(rms(s)).toBe(0)
  })
})

// ---- the gate --------------------------------------------------------------------------------------------------

describe('address gate', () => {
  test('whole-word, accent- and case-insensitive match', () => {
    expect(isAddressed('Voicetalk, qué hora es?', DEFAULT_NAMES)).toBe(true)
    expect(isAddressed('che VOICE TALK escuchá', DEFAULT_NAMES)).toBe(true)
    expect(isAddressed('voicetalks no es', DEFAULT_NAMES)).toBe(false)
    expect(isAddressed('hablemos de otra cosa', DEFAULT_NAMES)).toBe(false)
    expect(isAddressed('Fríday, dale', ['friday'])).toBe(true)
  })

  test('never answers when talking is off, even if addressed', () => {
    expect(
      shouldAnswer({
        talk: false,
        mode: 'always',
        names: DEFAULT_NAMES,
        text: 'voicetalk hola',
      }),
    ).toBe(false)
  })

  test('name mode needs the name, always mode does not, empty text never answers', () => {
    const base = { talk: true, names: DEFAULT_NAMES }
    expect(shouldAnswer({ ...base, mode: 'name', text: 'hola a todos' })).toBe(
      false,
    )
    expect(
      shouldAnswer({ ...base, mode: 'name', text: 'voicetalk, ¿estás?' }),
    ).toBe(true)
    expect(
      shouldAnswer({ ...base, mode: 'always', text: 'hola a todos' }),
    ).toBe(true)
    expect(shouldAnswer({ ...base, mode: 'always', text: ' ... ' })).toBe(false)
  })
})

// ---- service ---------------------------------------------------------------------------------------------------

describe('service: availability', () => {
  test('without a gateway it is unavailable and refuses to join', async () => {
    const svc = new DiscordService({
      config: loadDiscordConfig({}),
      gateway: null,
      llm: new FakeLlm(),
      tts: null,
      stt: fakeStt().connector,
      store: new CallStore(new CallEvents()),
    })
    expect(svc.status().available).toBe(false)
    expect(svc.status().state).toBe('unavailable')
    await svc.start()
    expect(svc.status().state).toBe('unavailable')
    await expect(svc.join(TARGET)).rejects.toBeInstanceOf(DiscordError)
  })

  test('a bad token becomes state=error and the token is never exposed', async () => {
    const c = setup()
    c.gateway.loginError = new Error('An invalid token was provided.')
    await c.service.start()
    const s = c.service.status()
    expect(s.state).toBe('error')
    expect(s.error).toBe('An invalid token was provided.')
    expect(JSON.stringify(s)).not.toContain('xxxxxxxxxx')
    expect(c.logs.join('\n')).not.toContain('xxxxxxxxxx')
  })

  test('ready status exposes the bot, guilds and invite link', async () => {
    const c = setup()
    await c.service.start()
    const s = c.service.status()
    expect(s).toMatchObject({
      available: true,
      state: 'ready',
      botName: 'VoiceTalk',
      canTalk: true,
      session: null,
    })
    expect(s.inviteUrl).toContain('client_id=123')
    expect(c.service.guilds()).toEqual([GUILD])
  })
})

describe('service: join and leave', () => {
  test('announces in the text channel before the session starts', async () => {
    const c = setup()
    await c.service.start()
    await c.service.join(TARGET)
    expect(c.gateway.log).toEqual(['join', 'announce'])
    expect(c.gateway.announced[0]).toContain('General')
    expect(c.gateway.announced[0]).toContain('/voicetalk leave')
    expect(c.store.current?.source).toBe('discord')
  })

  test('audio that arrives before the notice is out is dropped', async () => {
    const c = setup()
    await c.service.start()
    let release: () => void = () => {}
    c.gateway.announce = async () => {
      // A member talks while the notice is still being sent.
      handlersOf(c).onAudio('u1', new Uint8Array(640))
      await new Promise<void>((r) => (release = r))
    }
    const joining = c.service.join(TARGET)
    await until(() => c.gateway.handlers !== null)
    await sleep(10)
    release()
    await joining
    expect(c.stt.links).toHaveLength(0)
    expect(c.store.current?.transcript).toHaveLength(0)
  })

  test('join is fail-closed: no notice, no transcription', async () => {
    const c = setup()
    await c.service.start()
    c.gateway.announceError = new Error('Missing Permissions')
    await expect(c.service.join(TARGET)).rejects.toThrow(/Sin aviso/)
    expect(c.gateway.conn.left).toBe(true)
    expect(c.store.current).toBeNull()
    expect(c.service.status().session).toBeNull()
  })

  test('join reports the session and a second join is refused', async () => {
    const c = await joined()
    expect(c.service.status().session).toMatchObject({
      guildId: 'g1',
      channelId: 'v1',
      channelName: 'General',
      talk: false,
    })
    await expect(c.service.join(TARGET)).rejects.toThrow(/ya está/)
  })

  test('unknown channel is refused', async () => {
    const c = setup()
    await c.service.start()
    await expect(
      c.service.join({ guildId: 'g1', channelId: 'nope' }),
    ).rejects.toThrow(/canal/)
  })

  test('talk without a TTS provider is refused up front', async () => {
    const c = setup({ tts: null })
    await c.service.start()
    expect(c.service.status().canTalk).toBe(false)
    await expect(c.service.join(TARGET, { talk: true })).rejects.toThrow(
      /CARTESIA/,
    )
    expect(c.gateway.log).toEqual([])
  })

  test('leave closes links, ends the call, leaves the channel and says so', async () => {
    const c = await joined()
    speak(c, 'u1', 'Ana', 'hola')
    expect(await c.service.leave()).toBe(true)
    expect(c.gateway.conn.left).toBe(true)
    expect(c.stt.links.every((l) => l.closed)).toBe(true)
    expect(c.store.current).toBeNull()
    expect(c.service.status().session).toBeNull()
    expect(c.gateway.announced.at(-1)).toContain('dejó de transcribir')
    expect(await c.service.leave()).toBe(false)
  })

  test('stop leaves and destroys the gateway', async () => {
    const c = await joined()
    await c.service.stop()
    expect(c.gateway.conn.left).toBe(true)
    expect(c.gateway.destroyed).toBe(true)
  })

  test('a lost connection ends the session without announcing', async () => {
    const c = await joined()
    const before = c.gateway.announced.length
    handlersOf(c).onDisconnected('kicked')
    await until(() => c.service.status().session === null)
    expect(c.store.current).toBeNull()
    expect(c.gateway.announced).toHaveLength(before)
  })

  test('auto-leaves after the room has stayed empty', async () => {
    const c = await joined({ emptyGraceMs: 30 })
    handlersOf(c).onMembers(0)
    await until(() => c.service.status().session === null)
    expect(c.gateway.conn.left).toBe(true)
  })

  test('someone coming back cancels the empty-room timer', async () => {
    const c = await joined({ emptyGraceMs: 40 })
    handlersOf(c).onMembers(0)
    handlersOf(c).onMembers(2)
    await sleep(90)
    expect(c.service.status().session).not.toBeNull()
  })
})

describe('service: slash commands', () => {
  const ctx = (over: Partial<CommandContext> = {}) => {
    const replies: Array<{ text: string; ephemeral: boolean }> = []
    const base: CommandContext = {
      name: 'join',
      guildId: 'g1',
      userId: 'u1',
      userName: 'Ana',
      voiceChannelId: 'v1',
      talk: false,
      reply: async (text, opts) => {
        replies.push({ text, ephemeral: opts?.ephemeral === true })
      },
    }
    return { ctx: { ...base, ...over }, replies }
  }

  test('join uses the invoker voice channel; the public reply is the notice', async () => {
    const c = setup()
    await c.service.start()
    const { ctx: x, replies } = ctx()
    await commandHandler(c)(x)
    expect(c.service.status().session?.channelId).toBe('v1')
    expect(replies).toHaveLength(1)
    expect(replies[0]?.ephemeral).toBe(false)
    expect(replies[0]?.text).toContain('transcribiendo')
    expect(c.gateway.announced).toHaveLength(0)
  })

  test('join without being in a voice channel is refused privately', async () => {
    const c = setup()
    await c.service.start()
    const { ctx: x, replies } = ctx({ voiceChannelId: null })
    await commandHandler(c)(x)
    expect(c.service.status().session).toBeNull()
    expect(replies[0]?.ephemeral).toBe(true)
  })

  test('leave works for members of the same channel, not for people outside it', async () => {
    const c = await joined()
    const outside = ctx({ name: 'leave', voiceChannelId: 'v2' })
    await commandHandler(c)(outside.ctx)
    expect(c.service.status().session).not.toBeNull()
    expect(outside.replies[0]?.ephemeral).toBe(true)

    const nowhere = ctx({ name: 'leave', voiceChannelId: null })
    await commandHandler(c)(nowhere.ctx)
    expect(c.service.status().session).not.toBeNull()

    const inside = ctx({ name: 'leave', voiceChannelId: 'v1' })
    await commandHandler(c)(inside.ctx)
    expect(c.service.status().session).toBeNull()
    expect(inside.replies[0]?.ephemeral).toBe(false)
  })

  test('leave with nothing active says so', async () => {
    const c = setup()
    await c.service.start()
    const { ctx: x, replies } = ctx({ name: 'leave' })
    await commandHandler(c)(x)
    expect(replies[0]?.text).toContain('no está')
  })

  test('a failing notice refuses the join with the safe message, not the raw error', async () => {
    const c = setup()
    await c.service.start()
    const seen: Array<{ text: string; ephemeral: boolean }> = []
    const { ctx: x } = ctx({
      reply: async (text, opts) => {
        if (!opts?.ephemeral) throw new Error('Missing Permissions: token=abc')
        seen.push({ text, ephemeral: true })
      },
    })
    await commandHandler(c)(x)
    expect(c.service.status().session).toBeNull()
    expect(c.gateway.conn.left).toBe(true)
    expect(seen[0]?.text).toContain('Sin aviso')
    expect(seen[0]?.text).not.toContain('token')
  })
})

// ---- speakers and session writes ---------------------------------------------------------------------------------

describe('speaker mapping and session writes', () => {
  test('each speaker gets their own stt link and utterances carry the real name', async () => {
    const c = await joined()
    c.gateway.conn.names.set('u1', 'Ana')
    c.gateway.conn.names.set('u2', 'Beto')
    speak(c, 'u1', 'Ana', 'Hola a todos')
    speak(c, 'u2', 'Beto', 'Buenas')
    expect(c.stt.links).toHaveLength(2)
    const t = c.store.current?.transcript ?? []
    expect(t.map((e) => [e.speaker, e.speakerName, e.text])).toEqual([
      ['user', 'Ana', 'Hola a todos'],
      ['user', 'Beto', 'Buenas'],
    ])
    expect(c.service.status().session?.speakers).toEqual(['Ana', 'Beto'])
  })

  test('audio of one speaker is routed only to their own link', async () => {
    const c = await joined()
    const h = handlersOf(c)
    h.onAudio('u1', new Uint8Array([1, 1]))
    h.onAudio('u2', new Uint8Array([2, 2]))
    h.onAudio('u1', new Uint8Array([3, 3]))
    const [a, b] = c.stt.links as [FakeLink, FakeLink]
    expect(a.frames.map((f) => f[0])).toEqual([1, 3])
    expect(b.frames.map((f) => f[0])).toEqual([2])
  })

  test('speaking end feeds silence to that speaker so the vad closes the segment', async () => {
    const c = await joined()
    const h = handlersOf(c)
    h.onAudio('u1', new Uint8Array(640))
    h.onSpeakingEnd('u1')
    const link = c.stt.links[0] as FakeLink
    const last = link.frames.at(-1) as Uint8Array
    expect(last.byteLength).toBe(silence(FLUSH_SILENCE_MS).byteLength)
    expect(rms(last)).toBe(0)
  })

  test('the stored session is source=discord with speaker names; the note names real people', async () => {
    const c = await joined()
    const callId = c.store.current?.id as string
    c.notesLlm.summaries.push(
      JSON.stringify({
        summary: 'Ana y Beto planearon el viaje.',
        open_questions: [],
        raised: ['Viaje'],
      }),
    )
    speak(c, 'u1', 'Ana', 'Armemos el viaje')
    speak(c, 'u2', 'Beto', 'Dale, yo reservo')
    await c.service.leave({ notice: false })
    await c.notes.recorder.idle()

    expect(c.notes.sessions.get(callId)).toMatchObject({
      source: 'discord',
      status: 'ended',
    })
    const rows = c.notes.utterances.list(callId)
    expect(rows.map((r) => [r.speaker, r.speakerName, r.text])).toEqual([
      ['user', 'Ana', 'Armemos el viaje'],
      ['user', 'Beto', 'Dale, yo reservo'],
    ])
    const [note] = c.notes.notes.listExternal(callId)
    expect(note?.body).toContain('con Ana y Beto')
  })

  test('a mic call is still source=call with no speaker names', async () => {
    const c = setup()
    const call = c.store.start()
    c.notesLlm.summaries.push(
      JSON.stringify({ summary: 'x', open_questions: [], raised: [] }),
    )
    c.store.upsert({ id: 'u', speaker: 'user', text: 'hola', t: 1 }, true)
    c.store.end('client')
    await c.notes.recorder.idle()
    expect(c.notes.sessions.get(call.id)?.source).toBe('call')
    expect(c.notes.utterances.list(call.id)[0]?.speakerName ?? null).toBeNull()
  })

  test('an utterance still in flight when leaving is kept (drain)', async () => {
    const c = await joined()
    c.gateway.conn.names.set('u1', 'Ana')
    handlersOf(c).onAudio('u1', new Uint8Array(640))
    const link = c.stt.links[0] as FakeLink
    link.handlers.onEvent({ type: 'speech_start', t: 0 })
    const call = c.store.current
    const leaving = c.service.leave({ notice: false })
    await sleep(20)
    link.handlers.onEvent({
      type: 'final',
      text: 'último mensaje',
      raw: 'x',
      t_start: 0,
      t_end: 1,
      stt_ms: 1,
    })
    await leaving
    expect(call?.transcript.map((e) => e.text)).toEqual(['último mensaje'])
  })
})

// ---- talking ---------------------------------------------------------------------------------------------------

describe('talking: the TTS answer gate', () => {
  test('off by default: nothing is generated or spoken, even when addressed', async () => {
    const c = await joined()
    speak(c, 'u1', 'Ana', 'VoiceTalk, ¿me escuchás?')
    await sleep(40)
    expect((c.llm as FakeLlm).calls).toHaveLength(0)
    expect((c.tts as FakeTts).texts).toHaveLength(0)
    expect(c.gateway.conn.played).toHaveLength(0)
  })

  test('on, name mode: stays silent unless addressed', async () => {
    const c = await joined({ talk: true })
    speak(c, 'u1', 'Ana', 'Estamos charlando entre nosotros')
    await sleep(40)
    expect((c.llm as FakeLlm).calls).toHaveLength(0)
    expect(c.gateway.conn.played).toHaveLength(0)
  })

  test('on, addressed: the answer is played into the channel and recorded as the agent', async () => {
    const c = await joined({ talk: true })
    speak(c, 'u1', 'Ana', 'VoiceTalk, ¿estás ahí?')
    await until(() => c.gateway.conn.played.length > 0)
    await until(() => (c.store.current?.transcript.length ?? 0) >= 2)
    const llm = c.llm as FakeLlm
    expect(llm.calls).toHaveLength(1)
    const last = llm.calls[0]?.at(-1)
    expect(last?.role).toBe('user')
    expect(last?.content).toContain('Ana: VoiceTalk, ¿estás ahí?')
    expect((c.tts as FakeTts).texts.length).toBeGreaterThan(0)
    const agent = c.store.current?.transcript.find((e) => e.speaker === 'agent')
    expect(agent?.text).toContain('Acá estoy')
  })

  test('room context reaches the model: earlier lines from other people are history', async () => {
    const c = await joined({ talk: true })
    speak(c, 'u2', 'Beto', 'Mañana tengo examen')
    speak(c, 'u1', 'Ana', 'voicetalk, qué dijo Beto?')
    await until(() => (c.llm as FakeLlm).calls.length === 1)
    const text = ((c.llm as FakeLlm).calls[0] ?? [])
      .map((m) => m.content)
      .join('\n')
    expect(text).toContain('Beto: Mañana tengo examen')
    expect(text).toContain('Ana: voicetalk, qué dijo Beto?')
  })

  test('always mode answers without the name', async () => {
    const c = await joined({ talk: true, address: 'always' })
    speak(c, 'u1', 'Ana', 'Hola')
    await until(() => c.gateway.conn.played.length > 0)
  })

  test('setTalk toggles at runtime and tells the room', async () => {
    const c = await joined()
    const before = c.gateway.announced.length
    expect(c.service.setTalk(true).talk).toBe(true)
    await until(() => c.gateway.announced.length > before)
    expect(c.gateway.announced.at(-1)).toContain('responde por voz')
    speak(c, 'u1', 'Ana', 'voicetalk hola')
    await until(() => c.gateway.conn.played.length > 0)
    expect(c.service.setTalk(false).talk).toBe(false)
  })

  test('setTalk without an active call or without TTS is refused', async () => {
    const c = setup({ tts: null })
    await c.service.start()
    expect(() => c.service.setTalk(true)).toThrow(DiscordError)
    await c.service.join(TARGET)
    expect(() => c.service.setTalk(true)).toThrow(/CARTESIA/)
  })
})

describe('talking: barge-in', () => {
  test('someone starting to talk stops playback and nothing more is queued', async () => {
    const c = await joined({ talk: true, tts: new FakeTts(15) })
    speak(c, 'u1', 'Ana', 'voicetalk, contame algo largo')
    await until(() => c.gateway.conn.played.length > 0)
    const stops = c.gateway.conn.stops
    handlersOf(c).onSpeakingStart('u2')
    expect(c.gateway.conn.stops).toBe(stops + 1)
    const played = c.gateway.conn.played.length
    await sleep(60)
    expect(c.gateway.conn.played.length).toBe(played)
  })

  test('the interrupted answer is recorded as what was actually said', async () => {
    const c = await joined({
      talk: true,
      tts: new FakeTts(15),
      llm: new FakeLlm([
        'Primera frase. ',
        'Segunda frase. ',
        'Tercera frase.',
      ]),
    })
    speak(c, 'u1', 'Ana', 'voicetalk, hablame')
    await until(() => c.gateway.conn.played.length > 0)
    handlersOf(c).onSpeakingStart('u2')
    const agent = c.store.current?.transcript.find((e) => e.speaker === 'agent')
    expect(agent).toBeDefined()
    expect(agent?.text).toContain('Primera frase')
  })

  test('speaking while the bot is silent does not touch playback', async () => {
    const c = await joined({ talk: true })
    handlersOf(c).onSpeakingStart('u2')
    expect(c.gateway.conn.stops).toBe(0)
  })
})

describe('announcement text', () => {
  test('says who transcribes, whether it talks, and how to remove it', () => {
    expect(announcement('General', false)).toContain('No habla')
    expect(announcement('General', true)).toContain('responder por voz')
    expect(announcement('General', false)).toContain('/voicetalk leave')
  })
})

// ---- graphql ---------------------------------------------------------------------------------------------------

const gql = async (q: string) => {
  const res = await createCore({
    port: 4310,
    cartesiaApiKey: undefined,
  }).app.handle(
    new Request('http://127.0.0.1/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: q }),
    }),
  )
  return (await res.json()) as {
    data?: Record<string, any>
    errors?: Array<{ message: string; extensions?: { code?: string } }>
  }
}

describe('graphql', () => {
  afterEach(() => setDiscordService(null))

  test('without a service the status is unavailable, with no guilds', async () => {
    setDiscordService(null)
    const res = await gql(
      '{ discordStatus { available state session { callId } } discordGuilds { id } }',
    )
    expect(res.data?.discordStatus).toEqual({
      available: false,
      state: 'unavailable',
      session: null,
    })
    expect(res.data?.discordGuilds).toEqual([])
    const join = await gql(
      'mutation { discordJoin(guildId: "g1", channelId: "v1") { callId } }',
    )
    expect(join.errors?.[0]?.extensions?.code).toBe('DISCORD_UNAVAILABLE')
  })

  test('join, status, talk toggle and leave go through the service', async () => {
    const c = setup()
    await c.service.start()
    setDiscordService(c.service)

    const guilds = await gql(
      '{ discordGuilds { id name voiceChannels { id name } } }',
    )
    expect(guilds.data?.discordGuilds).toEqual([GUILD])

    const join = await gql(
      'mutation { discordJoin(guildId: "g1", channelId: "v1", talk: false) { channelName talk } }',
    )
    expect(join.errors).toBeUndefined()
    expect(join.data?.discordJoin).toEqual({
      channelName: 'General',
      talk: false,
    })

    const status = await gql(
      '{ discordStatus { state botName canTalk session { guildName channelName } } }',
    )
    expect(status.data?.discordStatus).toEqual({
      state: 'ready',
      botName: 'VoiceTalk',
      canTalk: true,
      session: { guildName: 'Los Pibes', channelName: 'General' },
    })

    const talk = await gql('mutation { discordSetTalk(talk: true) { talk } }')
    expect(talk.data?.discordSetTalk).toEqual({ talk: true })

    const leave = await gql('mutation { discordLeave }')
    expect(leave.data?.discordLeave).toBe(true)
    expect(c.service.status().session).toBeNull()
  })

  test('service errors surface with a safe message and code', async () => {
    const c = setup()
    await c.service.start()
    setDiscordService(c.service)
    const res = await gql(
      'mutation { discordJoin(guildId: "g1", channelId: "nope") { callId } }',
    )
    expect(res.errors?.[0]?.extensions?.code).toBe('DISCORD_ERROR')
    expect(res.errors?.[0]?.message).toContain('canal')
  })

  test('the schema exposes no token field and keyStatus.discord is a boolean', async () => {
    const schema = await gql('{ __schema { types { name fields { name } } } }')
    const types = (schema.data?.__schema.types ?? []) as Array<{
      name: string
      fields: Array<{ name: string }> | null
    }>
    const names = types
      .filter((t) => t.name.startsWith('Discord') || t.name === 'KeyStatus')
      .flatMap((t) => t.fields?.map((f) => f.name) ?? [])
    expect(names.length).toBeGreaterThan(0)
    expect(names.some((n) => /token/i.test(n))).toBe(false)
    const ks = await gql('{ keyStatus { discord } }')
    expect(typeof ks.data?.keyStatus.discord).toBe('boolean')
  })
})
