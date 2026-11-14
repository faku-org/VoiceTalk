import { GraphQLError } from 'graphql'
import type { Builder } from '../graphql/schema.ts'
import { ChatError, type SessionInfo, type Timeline } from './service.ts'
import type {
  ChatAction,
  ChatThread,
  Highlight,
  ReplyRef,
  TimelineItem,
} from './types.ts'

/** Refusals reach the client as GraphQL errors with their own (already user-facing) message. */
function fail(err: unknown): never {
  if (err instanceof ChatError)
    throw new GraphQLError(err.message, { extensions: { code: err.code } })
  throw err
}

const field = (a: ChatAction, key: string): unknown =>
  (a as unknown as Record<string, unknown>)[key]
const strOf = (a: ChatAction, key: string): string | null => {
  const v = field(a, key)
  return typeof v === 'string' ? v : null
}

/**
 * Chat tab surface. Everything here is built from chat rows and transcript lines: no GraphQL type reaches the
 * notes repo, so the model's internal notes have no path to the UI.
 */
export function registerChat(builder: Builder): void {
  const ThreadType = builder.objectRef<ChatThread>('ChatThread').implement({
    fields: (t) => ({
      id: t.exposeString('id'),
      title: t.exposeString('title'),
      createdAt: t.exposeFloat('createdAt'),
      updatedAt: t.exposeFloat('updatedAt'),
      forkedFromThread: t.string({
        nullable: true,
        resolve: (x) => x.forkedFromThread,
      }),
      forkedFromMessage: t.string({
        nullable: true,
        resolve: (x) => x.forkedFromMessage,
      }),
      cutoffAt: t.float({ nullable: true, resolve: (x) => x.cutoffAt }),
      sessionId: t.string({ nullable: true, resolve: (x) => x.sessionId }),
    }),
  })

  const ReplyType = builder.objectRef<ReplyRef>('ChatReply').implement({
    fields: (t) => ({
      kind: t.exposeString('kind'),
      id: t.exposeString('id'),
      label: t.exposeString('label'),
      text: t.exposeString('text'),
    }),
  })

  const ActionType = builder.objectRef<ChatAction>('ChatAction').implement({
    fields: (t) => ({
      type: t.exposeString('type'),
      op: t.string({ nullable: true, resolve: (a) => strOf(a, 'op') }),
      reason: t.string({ nullable: true, resolve: (a) => strOf(a, 'reason') }),
      utteranceId: t.string({
        nullable: true,
        resolve: (a) => strOf(a, 'utteranceId'),
      }),
      original: t.string({
        nullable: true,
        resolve: (a) => strOf(a, 'original'),
      }),
      corrected: t.string({
        nullable: true,
        resolve: (a) => strOf(a, 'corrected'),
      }),
      highlightId: t.string({
        nullable: true,
        resolve: (a) => strOf(a, 'highlightId'),
      }),
      targetKind: t.string({
        nullable: true,
        resolve: (a) => strOf(a, 'targetKind'),
      }),
      targetId: t.string({
        nullable: true,
        resolve: (a) => strOf(a, 'targetId'),
      }),
      quoted: t.string({ nullable: true, resolve: (a) => strOf(a, 'quoted') }),
      threadId: t.string({
        nullable: true,
        resolve: (a) => strOf(a, 'threadId'),
      }),
      title: t.string({ nullable: true, resolve: (a) => strOf(a, 'title') }),
      query: t.string({ nullable: true, resolve: (a) => strOf(a, 'query') }),
      utteranceIds: t.stringList({
        nullable: true,
        resolve: (a) => {
          const v = field(a, 'utteranceIds')
          return Array.isArray(v) ? (v as string[]) : null
        },
      }),
    }),
  })

  const ItemType = builder.objectRef<TimelineItem>('ChatItem').implement({
    fields: (t) => ({
      kind: t.exposeString('kind'),
      id: t.exposeString('id'),
      at: t.exposeFloat('at'),
      // Effective text: for an utterance, the active correction when there is one.
      text: t.exposeString('text'),
      role: t.string({
        nullable: true,
        resolve: (i) => (i.kind === 'message' ? i.role : null),
      }),
      status: t.string({
        nullable: true,
        resolve: (i) => (i.kind === 'message' ? i.status : null),
      }),
      replyTo: t.field({
        type: ReplyType,
        nullable: true,
        resolve: (i) => (i.kind === 'message' ? i.replyTo : null),
      }),
      quote: t.string({
        nullable: true,
        resolve: (i) => (i.kind === 'message' ? i.quote : null),
      }),
      actions: t.field({
        type: [ActionType],
        resolve: (i) => (i.kind === 'message' ? i.actions : []),
      }),
      sessionId: t.string({
        nullable: true,
        resolve: (i) => (i.kind === 'utterance' ? i.sessionId : null),
      }),
      speaker: t.string({
        nullable: true,
        resolve: (i) => (i.kind === 'utterance' ? i.speaker : null),
      }),
      label: t.string({
        nullable: true,
        resolve: (i) => (i.kind === 'utterance' ? i.label : null),
      }),
      speakerName: t.string({
        nullable: true,
        resolve: (i) => (i.kind === 'utterance' ? i.speakerName : null),
      }),
      originalText: t.string({
        nullable: true,
        resolve: (i) => (i.kind === 'utterance' ? i.originalText : null),
      }),
      corrected: t.boolean({
        resolve: (i) => i.kind === 'utterance' && i.corrected,
      }),
    }),
  })

  const HighlightType = builder
    .objectRef<Highlight>('ChatHighlight')
    .implement({
      fields: (t) => ({
        id: t.exposeString('id'),
        targetKind: t.exposeString('targetKind'),
        targetId: t.exposeString('targetId'),
        start: t.exposeInt('start'),
        end: t.exposeInt('end'),
        quoted: t.exposeString('quoted'),
        note: t.string({ nullable: true, resolve: (h) => h.note }),
        createdAt: t.exposeFloat('createdAt'),
      }),
    })

  const SessionType = builder.objectRef<SessionInfo>('ChatSession').implement({
    fields: (t) => ({
      id: t.exposeString('id'),
      title: t.string({ nullable: true, resolve: (s) => s.title }),
      startedAt: t.exposeFloat('startedAt'),
      endedAt: t.float({ nullable: true, resolve: (s) => s.endedAt }),
      source: t.exposeString('source'),
    }),
  })

  const TimelineType = builder.objectRef<Timeline>('ChatTimeline').implement({
    fields: (t) => ({
      thread: t.field({ type: ThreadType, resolve: (x) => x.thread }),
      items: t.field({ type: [ItemType], resolve: (x) => x.items }),
      sessions: t.field({ type: [SessionType], resolve: (x) => x.sessions }),
      highlights: t.field({
        type: [HighlightType],
        resolve: (x) => x.highlights,
      }),
      busy: t.exposeBoolean('busy'),
    }),
  })

  builder.queryFields((t) => ({
    chatMain: t.field({
      type: ThreadType,
      resolve: (_r, _a, ctx) => ctx.services().chat.mainThread(),
    }),
    // The thread of one conversation (created on first use) and the one of the conversation in progress.
    chatSessionThread: t.field({
      type: ThreadType,
      args: { sessionId: t.arg.string({ required: true }) },
      resolve: (_r, args, ctx) => {
        try {
          return ctx.services().chat.sessionThread(args.sessionId)
        } catch (err) {
          return fail(err)
        }
      },
    }),
    chatLive: t.field({
      type: ThreadType,
      nullable: true,
      resolve: (_r, _a, ctx) => ctx.services().chat.liveThread(),
    }),
    chatThreads: t.field({
      type: [ThreadType],
      resolve: (_r, _a, ctx) => ctx.services().chat.listThreads(),
    }),
    chatTimeline: t.field({
      type: TimelineType,
      args: {
        threadId: t.arg.string({ required: true }),
        limit: t.arg.int(),
      },
      resolve: (_r, args, ctx) => {
        try {
          return ctx
            .services()
            .chat.timeline(
              args.threadId,
              Math.min(Math.max(1, args.limit ?? 300), 1000),
            )
        } catch (err) {
          return fail(err)
        }
      },
    }),
  }))

  builder.mutationFields((t) => ({
    forkChat: t.field({
      type: ThreadType,
      args: {
        threadId: t.arg.string({ required: true }),
        messageId: t.arg.string({ required: true }),
        title: t.arg.string(),
      },
      resolve: (_r, args, ctx) => {
        try {
          return ctx
            .services()
            .chat.fork(args.threadId, args.messageId, args.title)
        } catch (err) {
          return fail(err)
        }
      },
    }),
    // Undo the active correction of an utterance: the previous text (or the original) is shown again.
    revertCorrection: t.boolean({
      args: { utteranceId: t.arg.string({ required: true }) },
      resolve: (_r, args, ctx) =>
        ctx.services().chat.revertCorrection(args.utteranceId),
    }),
  }))
}
