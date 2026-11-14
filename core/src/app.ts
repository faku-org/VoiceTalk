import { Elysia } from 'elysia'
import { createYoga } from 'graphql-yoga'
import { GraphQLError } from 'graphql'
import type { CoreConfig } from './config.ts'
import { schema } from './graphql/schema.ts'
import type { Services } from './services.ts'

export interface Core {
  app: {
    handle(request: Request): Promise<Response>
    fetch(request: Request): Response | Promise<Response>
  }
  setReady(ready: boolean): void
}

// Elysia shell. Plain HTTP only for health/ready; everything else goes through /graphql.
export function createCore(config: CoreConfig, services?: Services): Core {
  let ready = false
  const yoga = createYoga({
    schema,
    graphqlEndpoint: '/graphql',
    graphiql: process.env.NODE_ENV !== 'production',
    landingPage: false,
    context: () => ({
      services: () => {
        if (!services) throw new GraphQLError('Storage is not configured')
        return services
      },
    }),
    // Only the app webview may call core from a browser context.
    cors: {
      origin: [
        'http://localhost:1420',
        'http://127.0.0.1:1420',
        'tauri://localhost',
        'http://tauri.localhost',
        'https://tauri.localhost',
      ],
      methods: ['POST', 'GET', 'OPTIONS'],
    },
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
