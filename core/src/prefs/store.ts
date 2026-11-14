import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  DEFAULT_PREFERENCES,
  mergePreferences,
  patchSchema,
  preferencesSchema,
  type Preferences,
} from './schema.ts'

export const APP_IDENTIFIER = 'com.wefaber.voicetalk'
const FILE_NAME = 'preferences.json'

/**
 * App data dir. `VT_DATA_DIR` wins; otherwise the same folder Tauri uses for
 * `app_data_dir` (`%APPDATA%\com.wefaber.voicetalk` on Windows).
 */
export function resolveDataDir(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): string {
  const override = env.VT_DATA_DIR?.trim()
  if (override) return override
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming')
    return join(appData, APP_IDENTIFIER)
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', APP_IDENTIFIER)
  }
  const xdg = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share')
  return join(xdg, APP_IDENTIFIER)
}

export class PreferencesError extends Error {}

export interface PrefsStore {
  readonly path: string
  get(): Preferences
  update(patch: unknown): Preferences
}

/** Preferences as one JSON file. Secrets never go in here (see ADR 0007). */
export function createPrefsStore(dir: string): PrefsStore {
  const path = join(dir, FILE_NAME)
  let current: Preferences | null = null

  function read(): Preferences {
    if (!existsSync(path)) return DEFAULT_PREFERENCES
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
      const partial = patchSchema.safeParse(raw)
      if (partial.success) {
        const merged = preferencesSchema.safeParse(
          mergePreferences(DEFAULT_PREFERENCES, partial.data),
        )
        if (merged.success) return merged.data
      }
    } catch {
      // fall through: unreadable or invalid file
    }
    // Keep the broken file for inspection and start from defaults.
    try {
      renameSync(path, `${path}.corrupt`)
    } catch {
      // best effort
    }
    return DEFAULT_PREFERENCES
  }

  function write(prefs: Preferences): void {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  }

  return {
    path,
    get() {
      current ??= read()
      return current
    },
    update(patch) {
      const parsed = patchSchema.safeParse(patch)
      if (!parsed.success) {
        throw new PreferencesError(
          parsed.error.issues
            .map((i) => `${i.path.join('.') || 'preferences'}: ${i.message}`)
            .join('; '),
        )
      }
      const next = preferencesSchema.safeParse(
        mergePreferences(this.get(), parsed.data),
      )
      if (!next.success) {
        throw new PreferencesError(
          next.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
        )
      }
      write(next.data)
      current = next.data
      return next.data
    },
  }
}

let shared: PrefsStore | null = null

/** Process-wide store used by the GraphQL resolvers. */
export function getPrefsStore(): PrefsStore {
  shared ??= createPrefsStore(resolveDataDir())
  return shared
}

/** Test hook. */
export function setPrefsStore(store: PrefsStore | null): void {
  shared = store
}
