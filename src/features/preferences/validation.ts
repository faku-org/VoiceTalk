// Client-side checks that mirror core/src/prefs/schema.ts, so the form can
// explain a problem while typing. Core still validates; this only improves
// the message. Pure functions, unit-tested.

export interface Issue {
  field: string
  message: string
}

export function validateLlmUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return 'La dirección del modelo no puede estar vacía.'
  if (trimmed.length > 2048) return 'La dirección es demasiado larga.'
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'La dirección debe empezar con http:// o https://.'
    }
  } catch {
    return 'La dirección no es una URL válida.'
  }
  return null
}

export function validateVoiceId(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return 'El identificador de voz no puede estar vacío.'
  if (trimmed.length > 64) return 'El identificador de voz es demasiado largo.'
  return null
}

export function validateUnit(label: string, value: number): string | null {
  if (!Number.isFinite(value)) return `${label} debe ser un número.`
  if (value < 0 || value > 1) return `${label} debe estar entre 0 y 1.`
  return null
}

export function validateEndOfTurn(value: number): string | null {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return 'El silencio de cierre debe ser un número entero de milisegundos.'
  }
  if (value < 200 || value > 3000) {
    return 'El silencio de cierre debe estar entre 200 y 3000 ms.'
  }
  return null
}

export function validateLocation(value: string): string | null {
  return value.trim().length > 120
    ? 'La ubicación admite hasta 120 caracteres.'
    : null
}

/** Capture cannot be switched on without confirming the consent notice (mirrors core's gate). */
export function validateCaptureConsent(
  enabled: boolean,
  consentAck: boolean,
): string | null {
  return enabled && !consentAck
    ? 'Confirma que leíste el aviso para activar la captura.'
    : null
}

export function collect(entries: Array<[string, string | null]>): Issue[] {
  return entries.flatMap(([field, message]) =>
    message ? [{ field, message }] : [],
  )
}
