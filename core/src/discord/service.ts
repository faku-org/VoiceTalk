// Owns the Discord bot: login, slash commands, and the one active voice session (a bot can sit in one channel per
// guild; VoiceTalk keeps one session in total to keep the UI and the voice sidecar simple).

import { callEvents } from '../call/events.ts'
import { CallStore } from '../call/store.ts'
import type { SttConnector } from '../call/stt-client.ts'
import type { ChatProvider } from '../llm/provider.ts'
import type { TtsProvider } from '../tts/provider.ts'
import { DiscordAnswerer } from './answerer.ts'
import {
  discordAvailable,
  inviteUrl,
  type AddressMode,
  type DiscordConfig,
} from './config.ts'
import type {
  CommandContext,
  DiscordGateway,
  GuildRef,
  JoinTarget,
  VoiceConnection,
} from './gateway.ts'
import { DiscordSession } from './session.ts'

export type DiscordState = 'unavailable' | 'connecting' | 'ready' | 'error'

export interface DiscordSessionInfo {
  callId: string
  guildId: string
  guildName: string
  channelId: string
  channelName: string
  /** The agent answers by voice. Off unless asked for. */
  talk: boolean
  startedAt: number
  speakers: string[]
}

export interface DiscordStatus {
  /** Token present and not VT_DISCORD=off. When false the UI hides the feature. */
  available: boolean
  state: DiscordState
  error: string | null
  botName: string | null
  /** Whether talking can be turned on (needs a TTS provider). */
  canTalk: boolean
  address: AddressMode
  names: string[]
  inviteUrl: string | null
  session: DiscordSessionInfo | null
}

/** A failure with a message safe to show in the UI. */
export class DiscordError extends Error {}

export interface DiscordServiceDeps {
  config: DiscordConfig
  /** Null when the feature is unavailable: the service then only reports that. */
  gateway: DiscordGateway | null
  llm: ChatProvider
  tts: TtsProvider | null
  stt: SttConnector
  /** Dedicated store: the mic call keeps its own, and a Discord session must not collide with it. */
  store?: CallStore
  log?: (line: string) => void
  /** Leave after the room has had no humans for this long. */
  emptyGraceMs?: number
}

export const EMPTY_GRACE_MS = 60_000

interface Active {
  target: JoinTarget
  guildName: string
  channelName: string
  session: DiscordSession
  answerer: DiscordAnswerer
  conn: VoiceConnection
  startedAt: number
  emptyTimer: ReturnType<typeof setTimeout> | null
}

export class DiscordService {
  readonly #d: DiscordServiceDeps
  readonly #store: CallStore
  #state: DiscordState
  #error: string | null = null
  #active: Active | null = null
  #joining = false

  constructor(deps: DiscordServiceDeps) {
    this.#d = deps
    this.#store = deps.store ?? new CallStore(callEvents)
    this.#state =
      deps.gateway && discordAvailable(deps.config)
        ? 'connecting'
        : 'unavailable'
  }

  #log(line: string): void {
    this.#d.log?.(line)
  }

  status(): DiscordStatus {
    const a = this.#active
    return {
      available: this.#state !== 'unavailable',
      state: this.#state,
      error: this.#error,
      botName:
        this.#state === 'ready' ? (this.#d.gateway?.botName() ?? null) : null,
      canTalk: this.#d.tts !== null,
      address: this.#d.config.address,
      names: this.#d.config.names,
      inviteUrl: inviteUrl(this.#d.config.appId),
      session: a ? this.#info(a) : null,
    }
  }

  guilds(): GuildRef[] {
    return this.#state === 'ready' ? (this.#d.gateway?.guilds() ?? []) : []
  }

  /** Logs the bot in and wires the slash commands. Never throws: a bad token becomes `state = error`. */
  async start(): Promise<void> {
    const gw = this.#d.gateway
    if (!gw || this.#state === 'unavailable') return
    gw.onCommand((ctx) => this.#command(ctx))
    try {
      await gw.login()
      this.#state = 'ready'
      this.#log(`[discord] ready as ${gw.botName()}`)
    } catch (err) {
      this.#state = 'error'
      // The message can name the cause ("invalid token") but never carries the token itself.
      this.#error = err instanceof Error ? err.message : 'login failed'
      this.#log(`[discord] login failed: ${this.#error}`)
    }
  }

  async stop(): Promise<void> {
    await this.leave().catch(() => {})
    await this.#d.gateway?.destroy().catch(() => {})
  }

  async join(
    target: JoinTarget,
    opts: {
      talk?: boolean
      /** Where the transparency notice goes. Defaults to the channel's own text chat. */
      announce?: (text: string) => Promise<void>
    } = {},
  ): Promise<DiscordSessionInfo> {
    const gw = this.#d.gateway
    if (!gw || this.#state !== 'ready')
      throw new DiscordError('Discord no está conectado')
    if (this.#active || this.#joining)
      throw new DiscordError('VoiceTalk ya está en una llamada de Discord')
    const talk = opts.talk ?? false
    if (talk && !this.#d.tts)
      throw new DiscordError('Para hablar falta CARTESIA_API_KEY')
    const guild = gw.guilds().find((g) => g.id === target.guildId)
    const channel = guild?.voiceChannels.find((c) => c.id === target.channelId)
    if (!guild || !channel)
      throw new DiscordError('No encuentro ese canal de voz')

    this.#joining = true
    try {
      const session = new DiscordSession({
        store: this.#store,
        stt: this.#d.stt,
        log: this.#d.log,
        onUtterance: (name, text) => this.#active?.answerer.hear(name, text),
        onSpeakingStart: () => this.#active?.answerer.interrupt(),
        onMembers: (n) => this.#members(n),
        onDisconnected: (reason) => void this.#lost(reason),
      })
      const answerer = this.#answerer()
      // Audio is dropped until the session starts: nothing is transcribed before the notice is out.
      const conn = await gw.joinVoice(target, session.handlers)
      session.bind(conn)
      try {
        await (opts.announce ?? ((t) => gw.announce(target, t)))(
          announcement(channel.name, talk),
        )
      } catch {
        conn.leave()
        throw new DiscordError(
          'No puedo avisar en el canal (falta el permiso Enviar mensajes). Sin aviso no transcribo.',
        )
      }
      session.start()
      this.#active = {
        target,
        guildName: guild.name,
        channelName: channel.name,
        session,
        answerer,
        conn,
        startedAt: Date.now(),
        emptyTimer: null,
      }
      answerer.talk = talk
      this.#log(
        `[discord] joined ${guild.name} / ${channel.name} (talk=${talk})`,
      )
      return this.#info(this.#active)
    } finally {
      this.#joining = false
    }
  }

  async leave(opts: { notice?: boolean } = {}): Promise<boolean> {
    const a = this.#active
    if (!a) return false
    this.#active = null
    if (a.emptyTimer) clearTimeout(a.emptyTimer)
    a.answerer.stop()
    a.conn.leave()
    await a.session.stop('client')
    this.#log(`[discord] left ${a.guildName} / ${a.channelName}`)
    if (opts.notice !== false)
      await this.#d.gateway
        ?.announce(a.target, 'VoiceTalk salió del canal y dejó de transcribir.')
        .catch(() => {})
    return true
  }

  setTalk(talk: boolean): DiscordSessionInfo {
    const a = this.#active
    if (!a) throw new DiscordError('No hay una llamada de Discord activa')
    if (talk && !this.#d.tts)
      throw new DiscordError('Para hablar falta CARTESIA_API_KEY')
    if (a.answerer.talk !== talk) {
      a.answerer.talk = talk
      if (!talk) a.answerer.interrupt()
      void this.#d.gateway
        ?.announce(
          a.target,
          talk
            ? 'VoiceTalk ahora responde por voz cuando lo nombran.'
            : 'VoiceTalk dejó de responder por voz. Sigue transcribiendo.',
        )
        .catch(() => {})
    }
    return this.#info(a)
  }

  #answerer(): DiscordAnswerer {
    const { tts, llm, config, gateway } = this.#d
    return new DiscordAnswerer({
      llm,
      // Without a TTS provider talking is refused up front; the stub never runs.
      tts: tts ?? { name: 'none', stream: async function* () {} },
      play: (pcm) => this.#active?.conn.play(pcm),
      stopPlayback: () => this.#active?.conn.stopPlayback(),
      record: (text, t) =>
        this.#store.upsert(
          { id: crypto.randomUUID(), speaker: 'agent', text, t },
          true,
        ),
      mode: config.address,
      names: () => [...config.names, ...(gateway ? [gateway.botName()] : [])],
      log: this.#d.log,
    })
  }

  #info(a: Active): DiscordSessionInfo {
    return {
      callId: a.session.callId ?? '',
      guildId: a.target.guildId,
      guildName: a.guildName,
      channelId: a.target.channelId,
      channelName: a.channelName,
      talk: a.answerer.talk,
      startedAt: a.startedAt,
      speakers: a.session.speakers,
    }
  }

  #members(humans: number): void {
    const a = this.#active
    if (!a) return
    if (humans > 0) {
      if (a.emptyTimer) clearTimeout(a.emptyTimer)
      a.emptyTimer = null
      return
    }
    if (a.emptyTimer) return
    a.emptyTimer = setTimeout(
      () => void this.leave().catch(() => {}),
      this.#d.emptyGraceMs ?? EMPTY_GRACE_MS,
    )
    a.emptyTimer.unref?.()
  }

  async #lost(reason: string): Promise<void> {
    const a = this.#active
    if (!a) return
    this.#log(`[discord] connection lost: ${reason}`)
    this.#active = null
    if (a.emptyTimer) clearTimeout(a.emptyTimer)
    a.answerer.stop()
    await a.session.stop('error')
  }

  async #command(ctx: CommandContext): Promise<void> {
    try {
      if (ctx.name === 'join') {
        if (!ctx.voiceChannelId) {
          await ctx.reply('Únete primero a un canal de voz.', {
            ephemeral: true,
          })
          return
        }
        await this.join(
          { guildId: ctx.guildId, channelId: ctx.voiceChannelId },
          { talk: ctx.talk, announce: (t) => ctx.reply(t) },
        )
        return
      }
      const a = this.#active
      if (!a || a.target.guildId !== ctx.guildId) {
        await ctx.reply('VoiceTalk no está en una llamada de este servidor.', {
          ephemeral: true,
        })
        return
      }
      // Anyone in the call can remove the recorder; people outside it cannot.
      if (ctx.voiceChannelId !== a.target.channelId) {
        await ctx.reply(
          'Solo quien está en la llamada puede sacar a VoiceTalk.',
          {
            ephemeral: true,
          },
        )
        return
      }
      await this.leave({ notice: false })
      await ctx.reply('VoiceTalk salió del canal y dejó de transcribir.')
    } catch (err) {
      const message =
        err instanceof DiscordError
          ? err.message
          : 'No se pudo completar el comando'
      if (!(err instanceof DiscordError))
        this.#log(
          `[discord] command failed: ${err instanceof Error ? err.message : err}`,
        )
      await ctx.reply(message, { ephemeral: true }).catch(() => {})
    }
  }
}

/** The transparency notice: who is transcribing, whether it talks, and how to remove it. */
export function announcement(channelName: string, talk: boolean): string {
  return [
    `VoiceTalk entró a **${channelName}** y está transcribiendo esta llamada: cada persona queda en el texto con su nombre.`,
    talk
      ? 'Puede responder por voz cuando lo nombran.'
      : 'No habla, solo transcribe.',
    'Para sacarlo: `/voicetalk leave`.',
  ].join(' ')
}
