import type { Builder } from '../graphql/schema.ts'
import type { NoteView, Session, Summary, UtteranceRow } from './types.ts'

const MAX_PAGE = 200

/**
 * Sessions surface: `sessions`, `session(id)`. Read-only, and it reads notes only through `listExternal`, so
 * internal notes (the model's private memory) and note embeddings have no path into the schema.
 */
export function registerNotes(builder: Builder): void {
  const UtteranceType = builder
    .objectRef<UtteranceRow>('SessionUtterance')
    .implement({
      fields: (t) => ({
        id: t.exposeString('id'),
        speaker: t.exposeString('speaker'),
        text: t.exposeString('text'),
        tStart: t.exposeFloat('tStart'),
        tEnd: t.exposeFloat('tEnd'),
      }),
    })

  const SummaryType = builder.objectRef<Summary>('SessionSummary').implement({
    fields: (t) => ({
      summary: t.exposeString('summary'),
      openQuestions: t.exposeStringList('openQuestions'),
      raised: t.exposeStringList('raised'),
    }),
  })

  const NoteType = builder.objectRef<NoteView>('ExternalNote').implement({
    fields: (t) => ({
      id: t.exposeInt('id'),
      body: t.exposeString('body'),
      createdAt: t.exposeFloat('createdAt'),
      location: t.exposeString('location'),
      speakers: t.exposeStringList('speakers'),
    }),
  })

  const SessionType = builder.objectRef<Session>('Session').implement({
    fields: (t) => ({
      id: t.exposeString('id'),
      startedAt: t.exposeFloat('startedAt'),
      endedAt: t.float({ nullable: true, resolve: (s) => s.endedAt }),
      location: t.exposeString('location'),
      title: t.string({ nullable: true, resolve: (s) => s.title }),
      status: t.exposeString('status'),
      utteranceCount: t.int({
        resolve: (s, _a, ctx) => ctx.services().notes.utterances.count(s.id),
      }),
      utterances: t.field({
        type: [UtteranceType],
        resolve: (s, _a, ctx) => ctx.services().notes.utterances.list(s.id),
      }),
      summary: t.field({
        type: SummaryType,
        nullable: true,
        resolve: (s, _a, ctx) => ctx.services().notes.summaries.get(s.id),
      }),
      externalNotes: t.field({
        type: [NoteType],
        resolve: (s, _a, ctx) => ctx.services().notes.notes.listExternal(s.id),
      }),
    }),
  })

  builder.queryFields((t) => ({
    sessions: t.field({
      type: [SessionType],
      args: { limit: t.arg.int(), offset: t.arg.int() },
      resolve: (_root, args, ctx) =>
        ctx
          .services()
          .notes.sessions.list(
            Math.min(Math.max(1, args.limit ?? 50), MAX_PAGE),
            Math.max(0, args.offset ?? 0),
          ),
    }),
    session: t.field({
      type: SessionType,
      nullable: true,
      args: { id: t.arg.string({ required: true }) },
      resolve: (_root, args, ctx) => ctx.services().notes.sessions.get(args.id),
    }),
  }))
}
