// Pure parts of the `voicetalk` profile setup (core/scripts/hermes-profile.ts): what to set, never how to run it.
// Nothing here touches the disk or spawns a process, so it is unit tested. Every command is for the
// voicetalk profile; the default profile is Faku's personal one and is never configured here.
import { randomBytes } from 'node:crypto'
import {
  DEFAULT_AGENT_PORT,
  PROFILE_NAME,
  assertNotDefault,
} from './profile.ts'

/** The only toolsets the agent gets: eyes and hands on the desktop, files, shell. */
export const AGENT_TOOLSETS = [
  'computer_use',
  'vision',
  'file',
  'terminal',
] as const

/** The gateway platform that serves the Runs API. */
export const API_PLATFORM = 'api_server'

/** 8642 is the Ether VPS tunnel. */
const RESERVED_PORTS = new Set([8642])

export interface ProfileSetup {
  /** OpenAI-compatible base URL of the local llama-server (VoiceTalk's local LLM URL). */
  llmUrl: string
  /** Model id sent to that server. llama-server serves one model and ignores the name. */
  model: string
  port: number
}

export const DEFAULT_SETUP_MODEL = 'local'

export function validateSetup(setup: ProfileSetup): void {
  assertNotDefault(PROFILE_NAME)
  let url: URL
  try {
    url = new URL(setup.llmUrl)
  } catch {
    throw new Error(`Invalid LLM URL: ${setup.llmUrl}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid LLM URL: ${setup.llmUrl}`)
  }
  if (!setup.model.trim()) throw new Error('Model id must not be empty')
  if (
    !Number.isInteger(setup.port) ||
    setup.port < 1024 ||
    setup.port > 65535 ||
    RESERVED_PORTS.has(setup.port)
  ) {
    throw new Error(
      `Invalid port ${setup.port}: use 1024-65535, not ${[...RESERVED_PORTS].join(', ')} (Ether VPS tunnel)`,
    )
  }
}

/** `hermes -p voicetalk <args>`: the only way the script addresses a profile. */
export function withProfile(args: string[]): string[] {
  assertNotDefault(PROFILE_NAME)
  return ['-p', PROFILE_NAME, ...args]
}

/** `config set` calls: local model, manual approvals. Run through `withProfile`. */
export function configCommands(setup: ProfileSetup): string[][] {
  validateSetup(setup)
  return [
    ['config', 'set', 'model.provider', 'custom'],
    ['config', 'set', 'model.base_url', setup.llmUrl],
    ['config', 'set', 'model.default', setup.model],
    // Local servers need no key; a placeholder keeps the OpenAI client happy. Not a secret.
    ['config', 'set', 'model.api_key', 'local'],
    // Writes, commands and clicks always wait for the user (the approval step in the call timeline).
    ['config', 'set', 'approvals.mode', 'manual'],
    // Hermes v0.23 refuses a gateway per named profile unless it opts out of the host gateway (Faku's default
    // profile, cloud model). The key lives in the voicetalk config only; the host never serves this profile.
    // Temporary Hermes shim: see ADR 0017.
    ['config', 'set', 'gateway.standalone', 'true'],
  ]
}

/** Names of the toolsets marked enabled in `hermes tools list` output. */
export function enabledToolsets(listOutput: string): string[] {
  const names: string[] = []
  for (const line of listOutput.split(/\r?\n/)) {
    const m = /^\s*✓\s+enabled\s+(\S+)/.exec(line)
    if (m?.[1]) names.push(m[1])
  }
  return names
}

/** Enables the agent toolsets and disables every other enabled one, for the API server platform. */
export function toolsetCommands(listOutput: string): string[][] {
  const enabled = new Set(enabledToolsets(listOutput))
  const allowed: ReadonlySet<string> = new Set(AGENT_TOOLSETS)
  const toDisable = [...enabled].filter((name) => !allowed.has(name))
  const toEnable = AGENT_TOOLSETS.filter((name) => !enabled.has(name))
  const commands: string[][] = []
  if (toEnable.length) {
    commands.push(['tools', 'enable', '--platform', API_PLATFORM, ...toEnable])
  }
  if (toDisable.length) {
    commands.push([
      'tools',
      'disable',
      '--platform',
      API_PLATFORM,
      ...toDisable,
    ])
  }
  return commands
}

/** A fresh API key. Only ever written to the profile .env. */
export function generateKey(): string {
  return `vt_${randomBytes(32).toString('hex')}`
}

/** `.env` values of the profile. The key is kept when the profile already has one, so a rerun does not rotate it. */
export function profileEnvValues(
  setup: ProfileSetup,
  existing: Record<string, string>,
  makeKey: () => string = generateKey,
): Record<string, string> {
  validateSetup(setup)
  return {
    API_SERVER_ENABLED: 'true',
    API_SERVER_HOST: '127.0.0.1',
    API_SERVER_PORT: String(setup.port),
    API_SERVER_KEY: existing.API_SERVER_KEY?.trim() || makeKey(),
  }
}

export const DEFAULT_SETUP_PORT = DEFAULT_AGENT_PORT
