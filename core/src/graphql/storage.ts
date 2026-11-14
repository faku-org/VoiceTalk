import type { DocHit } from '../rag/index.ts'
import type { IngestStatus } from '../ingest/index.ts'
import type { CodemodeRun, TimelineEntry } from '../codemode/index.ts'
import type { Builder } from './schema.ts'

export type { DocHit, IngestStatus, CodemodeRun, TimelineEntry }

interface Folder {
  path: string
  exists: boolean
}

/**
 * Phase 4 GraphQL surface: `ingestStatus`, `searchDocs(q)` and `codemodeRun(code)`. Kept in its own module so
 * the shared schema file only gains one call.
 */
export function registerStorage(builder: Builder): void {
  const FolderType = builder.objectRef<Folder>('IngestFolder').implement({
    fields: (t) => ({
      path: t.exposeString('path'),
      exists: t.exposeBoolean('exists'),
    }),
  })

  const IngestStatusType = builder
    .objectRef<IngestStatus>('IngestStatus')
    .implement({
      fields: (t) => ({
        folders: t.field({
          type: [FolderType],
          resolve: (s) => s.folders,
        }),
        documents: t.exposeInt('documents'),
        chunks: t.exposeInt('chunks'),
        scanning: t.exposeBoolean('scanning'),
        lastScanAt: t.float({
          nullable: true,
          resolve: (s) => s.lastScanAt,
        }),
        lastScanMs: t.int({ nullable: true, resolve: (s) => s.lastScanMs }),
        failed: t.exposeInt('failed'),
        lastError: t.string({ nullable: true, resolve: (s) => s.lastError }),
        embedderUp: t.boolean({
          nullable: true,
          resolve: (s) => s.embedderUp,
        }),
      }),
    })

  const DocHitType = builder.objectRef<DocHit>('DocHit').implement({
    fields: (t) => ({
      path: t.exposeString('path'),
      heading: t.exposeString('heading'),
      line: t.exposeInt('line'),
      score: t.exposeFloat('score'),
      text: t.exposeString('text'),
    }),
  })

  const TimelineType = builder
    .objectRef<TimelineEntry>('CodemodeCall')
    .implement({
      fields: (t) => ({
        op: t.exposeString('op'),
        startMs: t.exposeInt('startMs'),
        ms: t.exposeInt('ms'),
        ok: t.exposeBoolean('ok'),
        code: t.string({ nullable: true, resolve: (e) => e.code }),
        args: t.exposeString('args'),
        summary: t.exposeString('summary'),
      }),
    })

  const ErrorType = builder
    .objectRef<{ code: string; message: string }>('CodemodeError')
    .implement({
      fields: (t) => ({
        code: t.exposeString('code'),
        message: t.exposeString('message'),
      }),
    })

  const RunType = builder.objectRef<CodemodeRun>('CodemodeRun').implement({
    fields: (t) => ({
      ok: t.exposeBoolean('ok'),
      /** JSON text of the value the code returned. */
      resultJson: t.string({ nullable: true, resolve: (r) => r.resultJson }),
      truncated: t.exposeBoolean('truncated'),
      error: t.field({
        type: ErrorType,
        nullable: true,
        resolve: (r) => r.error,
      }),
      logs: t.stringList({ resolve: (r) => r.logs }),
      calls: t.exposeInt('calls'),
      ms: t.exposeInt('ms'),
      timeline: t.field({ type: [TimelineType], resolve: (r) => r.timeline }),
    }),
  })

  builder.queryFields((t) => ({
    ingestStatus: t.field({
      type: IngestStatusType,
      resolve: (_root, _args, ctx) => ctx.services().ingester.status(),
    }),
    searchDocs: t.field({
      type: [DocHitType],
      args: {
        q: t.arg.string({ required: true }),
        k: t.arg.int(),
      },
      resolve: (_root, args, ctx) =>
        ctx.services().retriever.search(args.q, args.k ?? 5),
    }),
  }))

  // A mutation, not a query: it executes agent code and appends to the audit log, and Yoga refuses
  // mutations over GET, so a web page cannot trigger it with an image tag.
  builder.mutationFields((t) => ({
    codemodeRun: t.field({
      type: RunType,
      args: { code: t.arg.string({ required: true }) },
      resolve: (_root, args, ctx) =>
        ctx.services().codemode.run(args.code, 'graphql'),
    }),
  }))
}
