// The real gateway: discord.js (REST + WebSocket), @discordjs/voice (UDP, DAVE end-to-end encryption) and
// opusscript (WASM Opus, no native build). Bot account only: no user tokens, ever (ADR 0010).
// Not exercised by the test suite (it needs a live token); the logic around it is, through the fake gateway.

import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection as DjsConnection,
} from '@discordjs/voice'
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type VoiceBasedChannel,
} from 'discord.js'
import OpusScript from 'opusscript'
import { PassThrough } from 'node:stream'
import {
  Downsampler48kStereoTo16kMono,
  Upsampler24kMonoTo48kStereo,
} from './audio.ts'
import type {
  CommandContext,
  DiscordGateway,
  GuildRef,
  JoinTarget,
  VoiceConnection,
  VoiceHandlers,
} from './gateway.ts'

/** A member pausing longer than this ends the packet stream; the next speaking event re-subscribes. */
const INACTIVITY_MS = 500
/** Playback streams are closed after this long without audio so the player goes idle. */
const PLAYBACK_IDLE_MS = 400
const READY_TIMEOUT_MS = 15_000

export const COMMAND_NAME = 'voicetalk'

export const commandDefinition = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('VoiceTalk en llamadas de voz')
  .setContexts(0) // guild only
  .addSubcommand((s) =>
    s
      .setName('join')
      .setDescription('Entra a tu canal de voz y transcribe la llamada')
      .addBooleanOption((o) =>
        o
          .setName('talk')
          .setDescription(
            'Que responda por voz cuando lo nombran (apagado por defecto)',
          ),
      ),
  )
  .addSubcommand((s) =>
    s.setName('leave').setDescription('Saca a VoiceTalk del canal de voz'),
  )

export class DiscordJsGateway implements DiscordGateway {
  readonly #token: string
  readonly #client: Client
  readonly #log: (line: string) => void

  constructor(token: string, log: (line: string) => void = () => {}) {
    this.#token = token
    this.#log = log
    // Minimal intents: no Message Content, no Guild Members, no Presences.
    this.#client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    })
  }

  botName(): string {
    return this.#client.user?.username ?? 'VoiceTalk'
  }

  async login(): Promise<void> {
    const ready = new Promise<void>((resolve) =>
      this.#client.once(Events.ClientReady, () => resolve()),
    )
    await this.#client.login(this.#token)
    await ready
    this.#client.on(Events.GuildCreate, (g) => void this.#register(g))
    for (const g of this.#client.guilds.cache.values()) await this.#register(g)
  }

  // Guild-scoped commands appear instantly (global ones take up to an hour).
  async #register(guild: Guild): Promise<void> {
    try {
      await guild.commands.set([commandDefinition.toJSON()])
    } catch (err) {
      this.#log(
        `[discord] could not register /${COMMAND_NAME} in ${guild.name}: ${err instanceof Error ? err.message : err} (invite with the applications.commands scope)`,
      )
    }
  }

  guilds(): GuildRef[] {
    return [...this.#client.guilds.cache.values()].map((g) => ({
      id: g.id,
      name: g.name,
      voiceChannels: [...g.channels.cache.values()]
        .filter(
          (c): c is VoiceBasedChannel =>
            c.type === ChannelType.GuildVoice && c.joinable,
        )
        .sort((a, b) => a.rawPosition - b.rawPosition)
        .map((c) => ({ id: c.id, name: c.name })),
    }))
  }

  async announce(target: JoinTarget, text: string): Promise<void> {
    const guild = await this.#client.guilds.fetch(target.guildId)
    const channel = await guild.channels.fetch(target.channelId)
    if (!channel?.isTextBased()) throw new Error('the channel has no text chat')
    await channel.send({ content: text, allowedMentions: { parse: [] } })
  }

  onCommand(handler: (ctx: CommandContext) => Promise<void>): void {
    this.#client.on(Events.InteractionCreate, (i) => {
      if (!i.isChatInputCommand() || i.commandName !== COMMAND_NAME) return
      if (!i.inGuild() || !i.guild) return
      void this.#dispatch(i, handler)
    })
  }

  async #dispatch(
    i: ChatInputCommandInteraction,
    handler: (ctx: CommandContext) => Promise<void>,
  ): Promise<void> {
    // Joining can take longer than the 3 s an interaction allows: acknowledge first.
    await i.deferReply().catch(() => {})
    let first = true
    const reply: CommandContext['reply'] = async (text, opts) => {
      const ephemeral = opts?.ephemeral === true
      if (first) {
        first = false
        if (!ephemeral) {
          await i.editReply({ content: text, allowedMentions: { parse: [] } })
          return
        }
        await i.deleteReply().catch(() => {})
      }
      await i.followUp({
        content: text,
        allowedMentions: { parse: [] },
        ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
      })
    }
    try {
      const guild = i.guild as Guild
      const member = await guild.members.fetch(i.user.id).catch(() => null)
      await handler({
        name: i.options.getSubcommand() === 'leave' ? 'leave' : 'join',
        guildId: guild.id,
        userId: i.user.id,
        userName: member?.displayName ?? i.user.username,
        voiceChannelId: member?.voice.channelId ?? null,
        talk: i.options.getBoolean('talk') ?? false,
        reply,
      })
    } catch (err) {
      this.#log(
        `[discord] command error: ${err instanceof Error ? err.message : err}`,
      )
      await reply('No se pudo completar el comando', { ephemeral: true }).catch(
        () => {},
      )
    }
  }

  async joinVoice(
    target: JoinTarget,
    handlers: VoiceHandlers,
  ): Promise<VoiceConnection> {
    const guild = await this.#client.guilds.fetch(target.guildId)
    const channel = await guild.channels.fetch(target.channelId)
    if (!channel?.isVoiceBased()) throw new Error('not a voice channel')
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    })
    try {
      await entersState(
        connection,
        VoiceConnectionStatus.Ready,
        READY_TIMEOUT_MS,
      )
    } catch {
      connection.destroy()
      throw new Error('no pude conectarme al canal de voz')
    }
    return new DjsVoiceLink(this.#client, guild, channel, connection, handlers)
  }

  async destroy(): Promise<void> {
    await this.#client.destroy()
  }
}

/** One joined channel: receive per user, play one stream at a time. */
class DjsVoiceLink implements VoiceConnection {
  readonly #client: Client
  readonly #guild: Guild
  readonly #channel: VoiceBasedChannel
  readonly #conn: DjsConnection
  readonly #handlers: VoiceHandlers
  readonly #player: AudioPlayer = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  })
  readonly #listening = new Set<string>()
  readonly #up = new Upsampler24kMonoTo48kStereo()
  #stream: PassThrough | null = null
  #idle: ReturnType<typeof setTimeout> | null = null
  #left = false
  #onVoiceState: (() => void) | null = null

  constructor(
    client: Client,
    guild: Guild,
    channel: VoiceBasedChannel,
    conn: DjsConnection,
    handlers: VoiceHandlers,
  ) {
    this.#client = client
    this.#guild = guild
    this.#channel = channel
    this.#conn = conn
    this.#handlers = handlers
    conn.subscribe(this.#player)
    this.#player.on('error', () => this.stopPlayback())

    conn.receiver.speaking.on('start', (userId) => {
      if (userId === this.#client.user?.id) return
      // Resolve the display name while the utterance is still being transcribed.
      if (!this.#guild.members.cache.has(userId))
        void this.#guild.members.fetch(userId).catch(() => {})
      handlers.onSpeakingStart(userId)
      this.#listen(userId)
    })

    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this.#left) return
      try {
        // Moved to another channel or a brief network blip: the library reconnects by itself.
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5000),
        ])
      } catch {
        this.#end('disconnected')
      }
    })
    conn.on(VoiceConnectionStatus.Destroyed, () => this.#end('destroyed'))

    this.#onVoiceState = () => handlers.onMembers(this.#humans())
    client.on(Events.VoiceStateUpdate, this.#onVoiceState)
    // Names of people already in the channel.
    for (const id of channel.members.keys())
      void guild.members.fetch(id).catch(() => {})
    handlers.onMembers(this.#humans())
  }

  #humans(): number {
    const ch = this.#guild.channels.cache.get(this.#channel.id)
    return ch?.isVoiceBased() ? ch.members.filter((m) => !m.user.bot).size : 0
  }

  #end(reason: string): void {
    if (this.#left) return
    this.leave()
    this.#handlers.onDisconnected(reason)
  }

  displayName(userId: string): string {
    return (
      this.#guild.members.cache.get(userId)?.displayName ??
      this.#client.users.cache.get(userId)?.displayName ??
      userId
    )
  }

  #listen(userId: string): void {
    if (this.#left || this.#listening.has(userId)) return
    this.#listening.add(userId)
    const opus = this.#conn.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterInactivity,
        duration: INACTIVITY_MS,
      },
    })
    // Decoder state is per stream: a fresh one per burst of speech keeps packet loss from leaking across.
    const decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO)
    const down = new Downsampler48kStereoTo16kMono()
    let closed = false
    const done = (): void => {
      if (closed) return
      closed = true
      this.#listening.delete(userId)
      decoder.delete()
      this.#handlers.onSpeakingEnd(userId)
    }
    opus.on('data', (packet: Buffer) => {
      if (closed) return
      try {
        const pcm = down.push(decoder.decode(packet))
        if (pcm.byteLength) this.#handlers.onAudio(userId, pcm)
      } catch {
        // A corrupt or undecryptable packet is dropped; the next one decodes on its own.
      }
    })
    opus.once('end', done)
    opus.once('close', done)
    opus.once('error', done)
  }

  play(pcm: Uint8Array): void {
    if (this.#left) return
    if (!this.#stream) {
      const stream = new PassThrough()
      this.#stream = stream
      this.#player.play(
        createAudioResource(stream, { inputType: StreamType.Raw }),
      )
    }
    this.#stream.write(this.#up.push(pcm))
    if (this.#idle) clearTimeout(this.#idle)
    this.#idle = setTimeout(() => this.#closeStream(), PLAYBACK_IDLE_MS)
  }

  #closeStream(): void {
    if (this.#idle) clearTimeout(this.#idle)
    this.#idle = null
    this.#stream?.end()
    this.#stream = null
  }

  stopPlayback(): void {
    if (this.#idle) clearTimeout(this.#idle)
    this.#idle = null
    this.#stream?.destroy()
    this.#stream = null
    if (this.#player.state.status !== AudioPlayerStatus.Idle)
      this.#player.stop(true)
  }

  leave(): void {
    if (this.#left) return
    this.#left = true
    this.stopPlayback()
    if (this.#onVoiceState)
      this.#client.off(Events.VoiceStateUpdate, this.#onVoiceState)
    try {
      this.#conn.destroy()
    } catch {
      // already destroyed
    }
  }
}
