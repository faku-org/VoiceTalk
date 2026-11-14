import { Elysia } from 'elysia'
import { createYoga } from 'graphql-yoga'
import type { CoreConfig } from './config.ts'
import { schema } from './graphql/schema.ts'

export interface Core {
  app: {
    handle(request: Request): Promise<Response>
    fetch(request: Request): Response | Promise<Response>
  }
  setReady(ready: boolean): void
}

// Elysia shell. Plain HTTP only for health/ready; everything else goes through /graphql.
export function createCore(config: CoreConfig): Core {
  let ready = false
  const yoga = createYoga({
    schema,
    graphqlEndpoint: '/graphql',
    graphiql: process.env.NODE_ENV !== 'production',
    landingPage: false,
  })

  const app = new Elysia()
    .get('/health', () => ({ ok: true }))
    .get('/ready', ({ set }) => {
      // The key is reported as a boolean only; its value is never returned or logged.
      const body = { ok: ready, cartesia: config.cartesiaApiKey !== undefined }
      if (!ready) set.status = 503
      return body
    })
    .all('/graphql', ({ request }) => yoga.fetch(request))

  return {
    app,
    setReady(value: boolean) {
      ready = value
    },
  }
}
