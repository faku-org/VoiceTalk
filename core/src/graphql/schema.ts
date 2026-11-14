import SchemaBuilder from '@pothos/core'
import { VERSION } from '../version.ts'
import { registerStorage } from './storage.ts'
import type { Services } from '../services.ts'

interface Health {
  ok: boolean
  version: string
}

/** Per-request GraphQL context. `services()` throws when the core runs without storage (tests, smoke). */
export interface GraphQLContext {
  services(): Services
}

export const builder = new SchemaBuilder<{
  Objects: { Health: Health }
  Context: GraphQLContext
}>({})

export type Builder = typeof builder

const HealthType = builder.objectRef<Health>('Health').implement({
  fields: (t) => ({
    ok: t.exposeBoolean('ok'),
    version: t.exposeString('version'),
  }),
})

builder.queryType({
  fields: (t) => ({
    health: t.field({
      type: HealthType,
      resolve: (): Health => ({ ok: true, version: VERSION }),
    }),
  }),
})

builder.mutationType({})

registerStorage(builder)

export const schema = builder.toSchema()
