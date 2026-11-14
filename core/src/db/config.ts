import { delimiter, join, resolve } from 'node:path'

export interface StorageConfig {
  /** Holds `voicetalk.db` and `codemode-audit.jsonl`. */
  dataDir: string
  /** Allowlisted folders: ingest watches them, Code Mode can read only inside them. */
  folders: string[]
  /** Full OpenAI-compatible embeddings endpoint of the local llama-server. */
  embedUrl: string
  embedModel: string
}

/** Dev default: `core/.data`, gitignored. Release builds set `VT_DATA_DIR` (app data dir). */
export const DEV_DATA_DIR = resolve(import.meta.dir, '..', '..', '.data')
export const DEFAULT_EMBED_URL = 'http://127.0.0.1:8891/v1/embeddings'
export const DEFAULT_EMBED_MODEL = 'embeddinggemma-2'

/**
 * `VT_DATA_DIR`, `VT_FOLDERS` (separated by the platform delimiter, `;` on Windows), `VT_EMBED_URL`,
 * `VT_EMBED_MODEL`. Without `VT_FOLDERS` the allowlist is `%USERPROFILE%\Documents\Personal`.
 */
export function loadStorageConfig(
  env: Record<string, string | undefined> = process.env,
): StorageConfig {
  const dataDir = env.VT_DATA_DIR?.trim()
    ? resolve(env.VT_DATA_DIR.trim())
    : DEV_DATA_DIR
  const rawFolders = env.VT_FOLDERS?.trim()
  const home = env.USERPROFILE?.trim() || env.HOME?.trim()
  const folders = rawFolders
    ? rawFolders
        .split(delimiter)
        .map((f) => f.trim())
        .filter(Boolean)
        .map((f) => resolve(f))
    : home
      ? [join(home, 'Documents', 'Personal')]
      : []
  return {
    dataDir,
    folders: [...new Set(folders)],
    embedUrl: env.VT_EMBED_URL?.trim() || DEFAULT_EMBED_URL,
    embedModel: env.VT_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL,
  }
}
