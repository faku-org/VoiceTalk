import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { AgentPreference } from './prefsTypes'

/** What the shell should do for these prefs: start the gateway of the profile, or stop the one it started. */
export type GatewayAction =
  | { kind: 'ensure'; profile: string; url: string }
  | { kind: 'stop' }

export function gatewayAction(
  agent: AgentPreference | undefined,
): GatewayAction {
  if (!agent?.enabled) return { kind: 'stop' }
  return {
    kind: 'ensure',
    profile: agent.profile.trim(),
    url: agent.url.trim(),
  }
}

/**
 * Keeps the local Hermes gateway in line with Preferencias > Asistente > Agente (ADR 0017). The shell starts it
 * only when the agent is on and nothing answers yet, and stops only the process it started. Outside Tauri
 * (plain browser dev) the calls fail and are ignored.
 */
export function useHermesGateway(agent: AgentPreference | undefined) {
  const enabled = agent?.enabled ?? false
  const profile = agent?.profile ?? ''
  const url = agent?.url ?? ''

  useEffect(() => {
    // `agent` is rebuilt from the three fields below so the effect only runs when one of them changes.
    const action = gatewayAction({ enabled, profile, url, model: '' })
    const run =
      action.kind === 'ensure'
        ? invoke('hermes_ensure', { profile: action.profile, url: action.url })
        : invoke('hermes_stop')
    run.catch(() => {})
  }, [enabled, profile, url])
}
