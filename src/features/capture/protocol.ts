// Shapes of the Tauri capture commands and events (src-tauri/src/capture). Validated at runtime: the webview
// treats whatever comes back from invoke/listen as untrusted. Audio never reaches the webview (ADR 0009); only
// source lists, state and level numbers do.

export interface CaptureSource {
  pid: number
  name: string
  platform: string
  known: boolean
  playing: boolean
  level: number
}

export interface CaptureStart {
  callId: string
  pid: number
  name: string
  platform: string
  mic: boolean
  micError: string | null
}

export interface CaptureError {
  code: string
  message: string
}

export interface CaptureStop {
  callId: string
  utterances: number | null
  error: CaptureError | null
}

export interface CaptureLevels {
  remote: number
  mic: number
  seconds: number
}

/** Platform keys shared with core (`core/src/capture/platforms.ts`) and the Rust side. */
export const PLATFORMS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'discord', label: 'Discord' },
  { key: 'teams', label: 'Microsoft Teams' },
  { key: 'zoom', label: 'Zoom' },
  { key: 'slack', label: 'Slack' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'meet', label: 'Google Meet' },
  { key: 'other', label: 'Otra aplicación' },
]

export const platformLabel = (key: string): string =>
  PLATFORMS.find((p) => p.key === key)?.label ?? key

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

export function parseSource(value: unknown): CaptureSource | null {
  if (!isRecord(value)) return null
  const { pid, name, platform, known, playing, level } = value
  const p = num(pid)
  if (p === null || !Number.isInteger(p) || p <= 0) return null
  if (typeof name !== 'string' || typeof platform !== 'string') return null
  return {
    pid: p,
    name,
    platform,
    known: known === true,
    playing: playing === true,
    level: num(level) ?? 0,
  }
}

export function parseSources(value: unknown): CaptureSource[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((v) => {
    const s = parseSource(v)
    return s ? [s] : []
  })
}

export function parseError(value: unknown): CaptureError {
  if (isRecord(value) && typeof value.message === 'string') {
    return {
      code: typeof value.code === 'string' ? value.code : 'unknown',
      message: value.message,
    }
  }
  return {
    code: 'unknown',
    message:
      typeof value === 'string' ? value : 'No se pudo iniciar la captura.',
  }
}

export function parseStart(value: unknown): CaptureStart | null {
  if (!isRecord(value)) return null
  const { callId, pid, name, platform, mic, micError } = value
  const p = num(pid)
  if (typeof callId !== 'string' || p === null) return null
  if (typeof name !== 'string' || typeof platform !== 'string') return null
  return {
    callId,
    pid: p,
    name,
    platform,
    mic: mic === true,
    micError: typeof micError === 'string' ? micError : null,
  }
}

export function parseStop(value: unknown): CaptureStop | null {
  if (!isRecord(value) || typeof value.callId !== 'string') return null
  return {
    callId: value.callId,
    utterances: num(value.utterances),
    error: value.error ? parseError(value.error) : null,
  }
}

export function parseLevels(value: unknown): CaptureLevels | null {
  if (!isRecord(value)) return null
  const remote = num(value.remote)
  const mic = num(value.mic)
  const seconds = num(value.seconds)
  return remote === null || mic === null || seconds === null
    ? null
    : { remote, mic, seconds }
}

/** RMS 0..1 -> bar width 0..100. Speech RMS sits around 0.05-0.2, so the scale is boosted. */
export const meterPercent = (level: number): number =>
  Math.round(Math.min(1, Math.max(0, level) * 4) * 100)

/** "00:07", "12:03", "1:02:09". */
export function formatClock(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const mm = String(m).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export type CaptureBlock = 'env' | 'disabled' | 'consent'

const BLOCK_TEXT: Record<CaptureBlock, string> = {
  env: 'La captura está desactivada en este equipo (VT_CAPTURE=off).',
  disabled: 'La captura está apagada. Actívala en Preferencias, área Captura.',
  consent:
    'Falta confirmar el aviso de consentimiento en Preferencias, área Captura.',
}

export const blockText = (block: string): string =>
  BLOCK_TEXT[block as CaptureBlock] ?? 'La captura no está disponible.'

/** Spanish text for an error code coming from the shell or core. The raw message stays as detail. */
export function errorText(error: CaptureError): string {
  switch (error.code) {
    case 'busy':
      return 'Ya hay una llamada o una captura en curso.'
    case 'disabled':
    case 'env':
    case 'consent':
      return blockText(error.code)
    default:
      return error.message
  }
}
