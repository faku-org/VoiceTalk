import { GraphQLError } from 'graphql'
import type { ChannelRef, GuildRef } from './gateway.ts'
import { getDiscordService } from './registry.ts'
import {
  DiscordError,
  type DiscordService,
  type DiscordSessionInfo,
  type DiscordStatus,
} from './service.ts'

// oxlint-disable-next-line typescript/no-explicit-any
type AnyBuilder = PothosSchemaTypes.SchemaBuilder<any>

const UNAVAILABLE: DiscordStatus = {
  available: false,
  state: 'unavailable',
  error: null,
  botName: null,
  canTalk: false,
  address: 'name',
  names: [],
  inviteUrl: null,
  session: null,
}

function service(): DiscordService {
  const s = getDiscordService()
  if (!s || !s.status().available)
    throw new GraphQLError('Discord no está disponible', {
      extensions: { code: 'DISCORD_UNAVAILABLE' },
    })
  return s
}

/** Service errors carry text safe for the UI; anything else is rethrown. */
async function guarded<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof DiscordError)
      throw new GraphQLError(err.message, {
        extensions: { code: 'DISCORD_ERROR' },
      })
    throw err
  }
}

/**
 * `discordStatus`, `discordGuilds`, `discordJoin`, `discordLeave`, `discordSetTalk`. No token field exists:
 * only booleans and display data reach the webview.
 */
export function registerDiscord(builder: AnyBuilder): void {
  const Session = builder
    .objectRef<DiscordSessionInfo>('DiscordSession')
    .implement({
      fields: (t) => ({
        callId: t.exposeString('callId'),
        guildId: t.exposeString('guildId'),
        guildName: t.exposeString('guildName'),
        channelId: t.exposeString('channelId'),
        channelName: t.exposeString('channelName'),
        talk: t.exposeBoolean('talk'),
        startedAt: t.exposeFloat('startedAt'),
        speakers: t.exposeStringList('speakers'),
      }),
    })

  const Status = builder.objectRef<DiscordStatus>('DiscordStatus').implement({
    fields: (t) => ({
      available: t.exposeBoolean('available'),
      state: t.exposeString('state'),
      error: t.exposeString('error', { nullable: true }),
      botName: t.exposeString('botName', { nullable: true }),
      canTalk: t.exposeBoolean('canTalk'),
      address: t.exposeString('address'),
      names: t.exposeStringList('names'),
      inviteUrl: t.exposeString('inviteUrl', { nullable: true }),
      session: t.field({
        type: Session,
        nullable: true,
        resolve: (s: DiscordStatus) => s.session,
      }),
    }),
  })

  const Channel = builder.objectRef<ChannelRef>('DiscordChannel').implement({
    fields: (t) => ({
      id: t.exposeString('id'),
      name: t.exposeString('name'),
    }),
  })

  const Guild = builder.objectRef<GuildRef>('DiscordGuild').implement({
    fields: (t) => ({
      id: t.exposeString('id'),
      name: t.exposeString('name'),
      voiceChannels: t.field({
        type: [Channel],
        resolve: (g: GuildRef) => g.voiceChannels,
      }),
    }),
  })

  builder.queryFields((t) => ({
    discordStatus: t.field({
      type: Status,
      resolve: () => getDiscordService()?.status() ?? UNAVAILABLE,
    }),
    discordGuilds: t.field({
      type: [Guild],
      resolve: () => getDiscordService()?.guilds() ?? [],
    }),
  }))

  builder.mutationFields((t) => ({
    discordJoin: t.field({
      type: Session,
      args: {
        guildId: t.arg.string({ required: true }),
        channelId: t.arg.string({ required: true }),
        talk: t.arg.boolean(),
      },
      resolve: (
        _root: unknown,
        a: { guildId: string; channelId: string; talk?: boolean | null },
      ) =>
        guarded(() =>
          service().join(
            { guildId: a.guildId, channelId: a.channelId },
            { talk: a.talk ?? false },
          ),
        ),
    }),
    discordLeave: t.boolean({
      resolve: () => guarded(() => service().leave()),
    }),
    discordSetTalk: t.field({
      type: Session,
      args: { talk: t.arg.boolean({ required: true }) },
      resolve: (_root: unknown, a: { talk: boolean }) =>
        guarded(() => service().setTalk(a.talk)),
    }),
  }))
}
