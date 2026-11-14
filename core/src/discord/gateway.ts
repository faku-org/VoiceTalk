// What the Discord feature needs from the outside world. The real implementation (discord-js-gateway.ts) wraps
// discord.js + @discordjs/voice; tests use a fake, so nothing here touches the network.

export interface ChannelRef {
  id: string
  name: string
}

export interface GuildRef {
  id: string
  name: string
  voiceChannels: ChannelRef[]
}

export interface JoinTarget {
  guildId: string
  channelId: string
}

/** Callbacks from a joined voice channel. Audio is already decoded: pcm_s16le, 16 kHz, mono, one user per call. */
export interface VoiceHandlers {
  /** A member started talking (also fires while the bot is speaking: this is the barge-in signal). */
  onSpeakingStart(userId: string): void
  onAudio(userId: string, pcm: Uint8Array): void
  /** No packets from that member for a short while. Discord sends nothing during silence. */
  onSpeakingEnd(userId: string): void
  /** Humans in the channel, bot excluded. */
  onMembers(humans: number): void
  /** The voice connection is gone (kicked, channel deleted, network). */
  onDisconnected(reason: string): void
}

export interface VoiceConnection {
  /** Server nickname, else global display name, else username. */
  displayName(userId: string): string
  /** Queues pcm_s16le, 24 kHz, mono for playback in the channel. */
  play(pcm: Uint8Array): void
  /** Drops everything queued or playing (barge-in). */
  stopPlayback(): void
  leave(): void
}

export type CommandName = 'join' | 'leave'

export interface CommandContext {
  name: CommandName
  guildId: string
  userId: string
  userName: string
  /** Voice channel the invoker is in, if any. */
  voiceChannelId: string | null
  /** `/voicetalk join talk:true`. */
  talk: boolean
  /** Reply in the channel where the command ran. Public by default: for `join` it is the transparency notice. */
  reply(text: string, opts?: { ephemeral?: boolean }): Promise<void>
}

export interface DiscordGateway {
  /** Display name of the bot user (also an address name). */
  botName(): string
  login(): Promise<void>
  guilds(): GuildRef[]
  joinVoice(
    target: JoinTarget,
    handlers: VoiceHandlers,
  ): Promise<VoiceConnection>
  /** Posts in the channel's text chat. Throws when the bot may not write there. */
  announce(target: JoinTarget, text: string): Promise<void>
  onCommand(handler: (ctx: CommandContext) => Promise<void>): void
  destroy(): Promise<void>
}
