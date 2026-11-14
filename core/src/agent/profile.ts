// The `voicetalk` Hermes profile (ADR 0017): where it lives, how its .env is read and written.
// Shared by the setup script and by core (which reads the API key from the profile .env).
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PROFILE_NAME = 'voicetalk'
/** 8642 is the Ether VPS tunnel; the default Hermes profile also lives there. */
export const DEFAULT_AGENT_PORT = 8650
export const DEFAULT_AGENT_URL = `http://127.0.0.1:${DEFAULT_AGENT_PORT}`

type Env = Record<string, string | undefined>

/** Throws on any profile name that could resolve to Faku's personal profile. Case-insensitive. */
export function assertNotDefault(name: string): void {
  const n = name.trim().toLowerCase()
  if (
    !n ||
    n === 'default' ||
    n === '.' ||
    n.includes('/') ||
    n.includes('\\')
  ) {
    throw new Error(
      `Refusing to touch Hermes profile "${name}": only "${PROFILE_NAME}" is managed here`,
    )
  }
}

/** `HERMES_HOME`, else `%LOCALAPPDATA%\hermes` on Windows, else `~/.hermes`. */
export function hermesHome(env: Env = process.env): string {
  const set = env.HERMES_HOME?.trim()
  if (set) return set
  const local = env.LOCALAPPDATA?.trim()
  return local ? join(local, 'hermes') : join(homedir(), '.hermes')
}

export function profileDir(
  name: string = PROFILE_NAME,
  env: Env = process.env,
): string {
  assertNotDefault(name)
  return join(hermesHome(env), 'profiles', name)
}

export function profileEnvPath(
  name: string = PROFILE_NAME,
  env: Env = process.env,
): string {
  return join(profileDir(name, env), '.env')
}

export function hermesBin(env: Env = process.env): string {
  const set = env.VT_HERMES_BIN?.trim()
  if (set) return set
  return join(
    hermesHome(env),
    'bin',
    process.platform === 'win32' ? 'hermes.exe' : 'hermes',
  )
}

/** `KEY=value` lines; comments and blanks skipped; surrounding quotes stripped. */
export function parseEnv(src: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/** Sets `values` in an env file's text: replaces existing keys in place, appends missing ones. */
export function upsertEnv(src: string, values: Record<string, string>): string {
  const pending = new Map(Object.entries(values))
  const lines = src.split(/\r?\n/).map((line) => {
    const eq = line.indexOf('=')
    if (eq <= 0 || line.trimStart().startsWith('#')) return line
    const key = line.slice(0, eq).trim()
    const next = pending.get(key)
    if (next === undefined) return line
    pending.delete(key)
    return `${key}=${next}`
  })
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  for (const [key, value] of pending) lines.push(`${key}=${value}`)
  return `${lines.join('\n')}\n`
}

/**
 * API key for the agent: `VT_AGENT_KEY` env var wins, else `API_SERVER_KEY` from the voicetalk
 * profile's .env. Undefined when neither exists (the agent is then offline). Never log it.
 */
export function readAgentKey(env: Env = process.env): string | undefined {
  const direct = env.VT_AGENT_KEY?.trim()
  if (direct) return direct
  try {
    const path = profileEnvPath(PROFILE_NAME, env)
    if (!existsSync(path)) return undefined
    return (
      parseEnv(readFileSync(path, 'utf8')).API_SERVER_KEY?.trim() || undefined
    )
  } catch {
    return undefined
  }
}
