import { invoke } from '@tauri-apps/api/core'

/** Dev fallback when the webview runs in a plain browser (no Tauri bridge). */
const DEV_CORE_URL = 'http://127.0.0.1:4310'

export function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

let cached: string | null = null

/** Core base URL. Retries while the supervisor is still starting. */
export async function coreUrl(): Promise<string> {
  if (cached) return cached
  if (!inTauri()) return (cached = DEV_CORE_URL)
  let lastError: unknown
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      cached = await invoke<string>('core_url')
      return cached
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
  throw new Error(
    `No se pudo obtener la dirección del núcleo (${String(lastError)}).`,
  )
}

export class GraphQLRequestError extends Error {
  readonly code: string | null
  constructor(message: string, code: string | null) {
    super(message)
    this.name = 'GraphQLRequestError'
    this.code = code
  }
}

interface GraphQLResponse<T> {
  data?: T
  errors?: Array<{ message: string; extensions?: { code?: string } }>
}

export async function gql<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const base = await coreUrl()
  const res = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const body = (await res.json()) as GraphQLResponse<T>
  const first = body.errors?.[0]
  if (first) {
    throw new GraphQLRequestError(first.message, first.extensions?.code ?? null)
  }
  if (!body.data) throw new Error('Respuesta vacía del núcleo.')
  return body.data
}
