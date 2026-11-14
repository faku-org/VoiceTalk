// First-run flow state: step order, navigation, completion record, and the
// small pure helpers the steps use. No React, so it is unit-testable.
// Ported from Lux `src/lib/onboarding.ts`; persistence moved from
// localStorage to the core preferences file (`onboarding` field).

export type OnboardingStepId =
  | 'welcome'
  | 'microphone'
  | 'folders'
  | 'models'
  | 'voice'
  | 'theme'

export const ONBOARDING_STEPS: readonly OnboardingStepId[] = [
  'welcome',
  'microphone',
  'folders',
  'models',
  'voice',
  'theme',
]

/**
 * Raising this shows the flow once more: a record saved with another version
 * does not count as completed. Must match ONBOARDING_VERSION in core/src/prefs.
 */
export const ONBOARDING_VERSION = 1

export interface OnboardingRecord {
  version: number
  completedAt: string
}

export function isOnboardingComplete(
  record: { version: number; completedAt: string } | null | undefined,
): boolean {
  return (
    !!record &&
    record.version === ONBOARDING_VERSION &&
    record.completedAt.length > 0
  )
}

export function completionRecord(now: Date = new Date()): OnboardingRecord {
  return { version: ONBOARDING_VERSION, completedAt: now.toISOString() }
}

// ── Navigation ───────────────────────────────────────────────────────────────

function clamp(index: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(Math.max(index, 0), total - 1)
}

export function nextStepIndex(index: number, total: number): number {
  return clamp(index + 1, total)
}

export function previousStepIndex(index: number, total: number): number {
  return clamp(index - 1, total)
}

export function isLastStep(index: number, total: number): boolean {
  return total > 0 && index >= total - 1
}

/** Percentage up to the current step (the first one already counts). */
export function onboardingProgress(index: number, total: number): number {
  if (total <= 0) return 0
  return Math.round(((clamp(index, total) + 1) / total) * 100)
}

// ── Folders step ─────────────────────────────────────────────────────────────

export const MAX_FOLDERS = 50

/** Adds paths, trimmed, without duplicates (case-insensitive on Windows paths). */
export function addFolders(
  current: readonly string[],
  added: readonly string[],
): string[] {
  const seen = new Set(current.map((p) => p.toLowerCase()))
  const next = [...current]
  for (const raw of added) {
    const path = raw.trim()
    if (!path || seen.has(path.toLowerCase())) continue
    if (next.length >= MAX_FOLDERS) break
    seen.add(path.toLowerCase())
    next.push(path)
  }
  return next
}

export function removeFolder(
  current: readonly string[],
  path: string,
): string[] {
  return current.filter((p) => p !== path)
}

// ── Microphone step ──────────────────────────────────────────────────────────

/** Root-mean-square of time-domain samples in [-1, 1]. */
export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!
  return Math.sqrt(sum / samples.length)
}

/**
 * Meter position 0..1 from an RMS value. Speech sits around -30 to -15 dBFS,
 * so the scale maps -60 dBFS to 0 and 0 dBFS to 1.
 */
export function levelFromRms(value: number): number {
  if (value <= 0) return 0
  const db = 20 * Math.log10(value)
  return Math.min(1, Math.max(0, (db + 60) / 60))
}

/** The test counts as passed once the signal crossed this level. */
export const MIC_PASS_LEVEL = 0.35
