import { gql } from '@/app/coreClient'

export type DiscordState = 'unavailable' | 'connecting' | 'ready' | 'error'

export interface DiscordSessionInfo {
  callId: string
  guildId: string
  guildName: string
  channelId: string
  channelName: string
  talk: boolean
  startedAt: number
  speakers: string[]
}

export interface DiscordStatus {
  available: boolean
  state: DiscordState
  error: string | null
  botName: string | null
  canTalk: boolean
  address: string
  names: string[]
  inviteUrl: string | null
  session: DiscordSessionInfo | null
}

export interface DiscordGuild {
  id: string
  name: string
  voiceChannels: Array<{ id: string; name: string }>
}

const STATUS_FIELDS = `available state error botName canTalk address names inviteUrl
  session { callId guildId guildName channelId channelName talk startedAt speakers }`

export async function fetchDiscordStatus(): Promise<DiscordStatus> {
  const data = await gql<{ discordStatus: DiscordStatus }>(
    `{ discordStatus { ${STATUS_FIELDS} } }`,
  )
  return data.discordStatus
}

export async function fetchDiscordGuilds(): Promise<DiscordGuild[]> {
  const data = await gql<{ discordGuilds: DiscordGuild[] }>(
    `{ discordGuilds { id name voiceChannels { id name } } }`,
  )
  return data.discordGuilds
}

export async function joinDiscord(
  guildId: string,
  channelId: string,
  talk: boolean,
): Promise<void> {
  await gql(
    `mutation ($guildId: String!, $channelId: String!, $talk: Boolean!) {
      discordJoin(guildId: $guildId, channelId: $channelId, talk: $talk) { callId }
    }`,
    { guildId, channelId, talk },
  )
}

export async function leaveDiscord(): Promise<void> {
  await gql(`mutation { discordLeave }`)
}

export async function setDiscordTalk(talk: boolean): Promise<void> {
  await gql(
    `mutation ($talk: Boolean!) { discordSetTalk(talk: $talk) { callId } }`,
    { talk },
  )
}
