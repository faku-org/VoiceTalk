import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Models the app needs on disk. Both live in the Hugging Face cache layout
// (`models--<org>--<repo>/snapshots/<rev>/<file>`), which is where the voice
// sidecar and llama.cpp's `-hf` flag already put them.
export interface ModelSpec {
  id: 'stt' | 'lfm'
  name: string
  repo: string
  /** File that must exist in a snapshot. Null = any file counts. */
  file: string | null
  /** How the model gets installed when it is missing. */
  install: 'automatic' | 'manual'
  /** Shell command for the manual case. */
  command: string | null
}

export const MODELS: readonly ModelSpec[] = [
  {
    id: 'stt',
    name: 'Reconocimiento de voz (Fluid Speech Pro)',
    repo: 'FluidVoice-Labs/fluid-speech-pro',
    file: null,
    install: 'automatic',
    command: null,
  },
  {
    id: 'lfm',
    name: 'Modelo de decisiones (LFM3 1.7B, GGUF)',
    repo: 'LiquidAI/LFM3-1.7B-GGUF',
    file: 'LFM3-1.7B-Q4_K_M.gguf',
    install: 'manual',
    command: 'hf download LiquidAI/LFM3-1.7B-GGUF LFM3-1.7B-Q4_K_M.gguf',
  },
]

export interface ModelStatus {
  id: ModelSpec['id']
  name: string
  repo: string
  present: boolean
  install: ModelSpec['install']
  command: string | null
}

export function resolveHubDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const direct = env.HF_HUB_CACHE?.trim()
  if (direct) return direct
  const home = env.HF_HOME?.trim()
  if (home) return join(home, 'hub')
  return join(homedir(), '.cache', 'huggingface', 'hub')
}

export function isPresent(spec: ModelSpec, hubDir: string): boolean {
  const snapshots = join(
    hubDir,
    `models--${spec.repo.replace('/', '--')}`,
    'snapshots',
  )
  if (!existsSync(snapshots)) return false
  try {
    return readdirSync(snapshots).some((rev) =>
      spec.file
        ? existsSync(join(snapshots, rev, spec.file))
        : readdirSync(join(snapshots, rev)).length > 0,
    )
  } catch {
    return false
  }
}

export function modelStatuses(hubDir: string = resolveHubDir()): ModelStatus[] {
  return MODELS.map((spec) => ({
    id: spec.id,
    name: spec.name,
    repo: spec.repo,
    present: isPresent(spec, hubDir),
    install: spec.install,
    command: spec.command,
  }))
}
