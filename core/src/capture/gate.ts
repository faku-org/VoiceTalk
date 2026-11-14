// Capture is off by default and needs two things from the user: the preference switched on and the consent notice
// acknowledged. `VT_CAPTURE=off` overrides everything (ADR 0009).

export interface CapturePrefs {
  enabled: boolean
  consentAck: boolean
}

export type CaptureBlock = 'env' | 'disabled' | 'consent'

export const captureDisabledByEnv = (
  env: Record<string, string | undefined> = process.env,
): boolean => env.VT_CAPTURE?.trim().toLowerCase() === 'off'

/** Why capture cannot start, or null when it can. */
export function captureBlock(
  prefs: CapturePrefs,
  env: Record<string, string | undefined> = process.env,
): CaptureBlock | null {
  if (captureDisabledByEnv(env)) return 'env'
  if (!prefs.enabled) return 'disabled'
  if (!prefs.consentAck) return 'consent'
  return null
}

export const BLOCK_MESSAGE: Record<CaptureBlock, string> = {
  env: 'La captura de llamadas está desactivada por VT_CAPTURE=off.',
  disabled: 'La captura de llamadas está desactivada en Preferencias.',
  consent:
    'Confirma el aviso de consentimiento en Preferencias para capturar llamadas.',
}
