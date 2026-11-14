// Shape of `sidecar_status` (src-tauri/src/sidecar.rs). Validated at runtime:
// the webview treats whatever comes back from invoke as untrusted.

export type SidecarState = 'starting' | 'healthy' | 'down'

export interface SidecarInfo {
  port: number
  state: SidecarState
  detail: string | null
}

export interface SidecarStatus {
  core: SidecarInfo
  voice: SidecarInfo
}

const STATES: readonly string[] = ['starting', 'healthy', 'down']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseInfo(value: unknown): SidecarInfo | null {
  if (!isRecord(value)) return null
  const { port, state, detail } = value
  if (typeof port !== 'number' || !Number.isInteger(port)) return null
  if (typeof state !== 'string' || !STATES.includes(state)) return null
  return {
    port,
    state: state as SidecarState,
    detail: typeof detail === 'string' ? detail : null,
  }
}

export function parseStatus(value: unknown): SidecarStatus | null {
  if (!isRecord(value)) return null
  const core = parseInfo(value.core)
  const voice = parseInfo(value.voice)
  return core && voice ? { core, voice } : null
}
