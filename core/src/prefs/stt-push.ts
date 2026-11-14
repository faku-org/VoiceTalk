import type { SttModelId } from './schema.ts'
import type { PrefsStore } from './store.ts'

// The voice sidecar owns the STT model; core owns the preference. This pushes the choice at startup
// (the sidecar may still be booting) and whenever it changes. Never fatal: voice down = log and retry.

export interface SttPusherOptions {
  port: number
  fetch?: typeof fetch
  /** Wait before retry n (0-based). Default: 1s doubling, capped at 15s. */
  delayMs?: (attempt: number) => number
  /** Retries after the first attempt. */
  maxRetries?: number
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

export interface SttPusher {
  /** Resolves true once the sidecar accepted the model (202), false on 422, giving up, or a newer push. */
  push(id: SttModelId): Promise<boolean>
  /** Pushes the current choice now and again on every change. Returns the unsubscribe. */
  watch(store: PrefsStore): () => void
}

const defaultDelay = (attempt: number): number =>
  Math.min(15_000, 1000 * 2 ** attempt)

export function createSttPusher(opts: SttPusherOptions): SttPusher {
  const doFetch = opts.fetch ?? fetch
  const delay = opts.delayMs ?? defaultDelay
  const maxRetries = opts.maxRetries ?? 12
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const log = opts.log ?? (() => {})
  const url = `http://127.0.0.1:${opts.port}/stt/model`
  // Latest choice wins: a newer push cancels the retries of an older one.
  let generation = 0

  async function push(id: SttModelId): Promise<boolean> {
    const mine = ++generation
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (mine !== generation) return false
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        })
        if (res.ok) {
          log(`[stt] voice switching to ${id}`)
          return true
        }
        if (res.status === 422) {
          log(`[stt] voice rejected model "${id}" (422)`)
          return false
        }
        log(`[stt] voice answered ${res.status} to model "${id}"`)
      } catch {
        // voice not reachable yet
      }
      if (attempt < maxRetries) await sleep(delay(attempt))
    }
    log(`[stt] gave up pushing model "${id}": voice unreachable`)
    return false
  }

  return {
    push,
    watch(store) {
      void push(store.get().stt)
      return store.subscribe((next, prev) => {
        if (next.stt !== prev.stt) void push(next.stt)
      })
    },
  }
}
