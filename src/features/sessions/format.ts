export type SessionStatus = 'active' | 'ended' | 'interrupted'

const STATUS_LABEL: Record<SessionStatus, string> = {
  active: 'En curso',
  ended: 'Finalizada',
  interrupted: 'Interrumpida',
}

export const statusLabel = (status: string): string =>
  STATUS_LABEL[status as SessionStatus] ?? status

/** Real name when the capture knew it (Discord), else the generic label. */
export const speakerLabel = (speaker: string, name?: string | null): string => {
  const n = name?.trim()
  if (n) return n
  return speaker === 'agent' ? 'Agente' : 'Tú'
}

/** Where a session was captured. `call` (the microphone) is the default and needs no badge. */
export const sourceLabel = (source: string | undefined): string | null =>
  source === 'discord' ? 'Discord' : null

/** "14 nov 2026, 18:30" in the user's locale (Spanish). `timeZone` exists for tests. */
export function formatStarted(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('es', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(ms))
}

/** "45 s", "12 min", "1 h 05 min". Null while the session has no end. */
export function formatDuration(
  startedAt: number,
  endedAt: number | null,
): string | null {
  if (endedAt === null || endedAt < startedAt) return null
  const total = Math.round((endedAt - startedAt) / 1000)
  if (total < 60) return `${total} s`
  const minutes = Math.round(total / 60)
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  return `${h} h ${String(minutes % 60).padStart(2, '0')} min`
}

/** Time of an utterance inside its session: "00:07", "12:03", "1:02:09". Never negative. */
export function formatOffset(startedAt: number, t: number): string {
  const total = Math.max(0, Math.floor((t - startedAt) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** Title for the list: the stored one, or the date when none was written. */
export function sessionLabel(title: string | null, startedAt: number): string {
  const t = title?.trim()
  return t ? t : `Conversación del ${formatStarted(startedAt)}`
}
