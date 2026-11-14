import SchemaBuilder from '@pothos/core'
import { callStore, type CallSnapshot } from '../call/store.ts'
import type { TranscriptEntry } from '../call/events.ts'
import { VERSION } from '../version.ts'
import { registerStorage } from './storage.ts'
import type { Services } from '../services.ts'
import { registerPrefs } from '../prefs/graphql.ts'

interface Health {
  ok: boolean
  version: string
}

/** Per-request GraphQL context. `services()` throws when the core runs without storage (tests, smoke). */
export interface GraphQLContext {
  services(): Services
}

export const builder = new SchemaBuilder<{
  Objects: { Health: Health; Call: CallSnapshot; Utterance: TranscriptEntry }
  Context: GraphQLContext
}>({})

export type Builder = typeof builder

const HealthType = builder.objectRef<Health>('Health').implement({
  fields: (t) => ({
    ok: t.exposeBoolean('ok'),
    version: t.exposeString('version'),
  }),
})

const UtteranceType = builder
  .objectRef<TranscriptEntry>('Utterance')
  .implement({
    fields: (t) => ({
      id: t.exposeString('id'),
      speaker: t.exposeString('speaker'),
      text: t.exposeString('text'),
      // Epoch ms.
      t: t.exposeFloat('t'),
    }),
  })

const CallType = builder.objectRef<CallSnapshot>('Call').implement({
  fields: (t) => ({
    id: t.exposeString('id'),
    startedAt: t.exposeFloat('startedAt'),
    state: t.exposeString('state'),
    transcript: t.field({
      type: [UtteranceType],
      resolve: (call) => call.transcript,
    }),
  }),
})

builder.queryType({
  fields: (t) => ({
    currentCall: t.field({
      type: CallType,
      nullable: true,
      resolve: () => callStore.current,
    }),
    health: t.field({
      type: HealthType,
      resolve: (): Health => ({ ok: true, version: VERSION }),
    }),
  }),
})

// The Mutation root is declared once here; each module adds fields.
builder.mutationType({})

registerStorage(builder)
registerPrefs(builder)

export const schema = builder.toSchema()
