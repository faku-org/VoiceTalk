import SchemaBuilder from '@pothos/core'
import { VERSION } from '../version.ts'

interface Health {
  ok: boolean
  version: string
}

const builder = new SchemaBuilder<{ Objects: { Health: Health } }>({})

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

export const schema = builder.toSchema()
