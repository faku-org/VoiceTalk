// Pure rules that turn the call into Ether's state, voice levels and one-shot reactions.
// No React, no canvas: tested in ether-state.test.ts. Contract: DESIGN.md > Ether.

import type { CallPhase } from './use-call'
import type { AgentState, CallState } from './protocol'

/** Subset of the rig's `OrbState` this app drives. `working` and `attention` come from the local agent. */
export type EtherState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'working'
  | 'attention'
  | 'error'
  | 'resting'
  | 'offline'

/** Moods the design allows (the other six are too loud for a calm companion). */
export type EtherMood = 'neutral' | 'happy' | 'curious' | 'focused' | 'tired'

/** One-shot reactions the design allows. */
export type EtherReaction = 'nod' | 'done' | 'think' | 'flash' | 'hop'

export interface CallSnapshot {
  phase: CallPhase
  agentState: CallState
  /** The local agent: `attention` (waiting for a permission) and `working` (acting) show on Ether. */
  agent: AgentState
  /** A call-level error is showing (failed start, mic denied, socket closed). */
  error: boolean
  /** Sidecar or model missing: the call cannot start. */
  offline: boolean
  /** The app has sat idle outside a call for a long time. */
  longIdle: boolean
}

/** Idle time outside a call before Ether goes to `resting`. */
export const RESTING_AFTER_MS = 5 * 60 * 1000

/**
 * Call -> Ether state. Precedence: offline, then error (only outside an active call, so a stray mid-call
 * error never freezes her expression), then the agent state; `resting` only for a long idle outside a call.
 * During a call a pending permission (`attention`) wins over everything: only the user can unblock it. `working`
 * shows only while the voice is idle, so she never stops listening or speaking to look busy. An unreachable agent
 * (`offline`) does not touch her: the call keeps working and the screen says so in words.
 */
export function etherStateFor(call: CallSnapshot): EtherState {
  if (call.phase === 'idle') {
    if (call.offline) return 'offline'
    if (call.error) return 'error'
    return call.longIdle ? 'resting' : 'idle'
  }
  if (call.phase === 'connecting') return 'idle'
  if (call.agent === 'attention') return 'attention'
  if (call.agent === 'working' && call.agentState === 'idle') return 'working'
  return call.agentState
}

const WORD: Record<EtherState, string> = {
  idle: 'En espera',
  listening: 'Escuchando',
  thinking: 'Pensando',
  speaking: 'Hablando',
  working: 'Trabajando',
  attention: 'Esperando tu OK',
  error: 'Con un error',
  resting: 'Descansando',
  offline: 'Sin servicios',
}

/** The state in words, written next to her. `connecting` has no orb state of its own. */
export function stateWord(state: EtherState, phase: CallPhase): string {
  return phase === 'connecting' ? 'Conectando' : WORD[state]
}

/** aria-label of the canvas: "Ether: escuchando". */
export function etherLabel(word: string): string {
  return `Ether: ${word.toLowerCase()}`
}

export interface VoiceLevels {
  /** Mic level into `target.body.listen`. */
  listen: number
  /** Playback level into `target.body.speak`. */
  speak: number
}

/** RMS is linear 0..1 and speech sits low; the square root keeps it readable. Output 0..1. */
export function shapeLevel(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0
  return Math.min(1, Math.sqrt(rms) * 1.4)
}

/**
 * Which level feeds which channel: the mic only while she listens (the user talks), playback only while she
 * speaks. Every other state gets silence, so a barge-in (speaking -> listening) swaps channels at once.
 */
export function routeLevels(
  state: EtherState,
  micRms: number,
  playbackRms: number,
): VoiceLevels {
  return {
    listen: state === 'listening' ? shapeLevel(micRms) : 0,
    speak: state === 'speaking' ? shapeLevel(playbackRms) : 0,
  }
}

export interface ReactionContext {
  phase: CallPhase
  state: EtherState
}

/**
 * Calm by design: `hop` when the call goes live, `nod` when the user's turn ends (she stops listening and
 * starts thinking). Nothing else reacts.
 */
export function reactionFor(
  prev: ReactionContext,
  next: ReactionContext,
): EtherReaction | null {
  if (prev.phase !== 'active' && next.phase === 'active') return 'hop'
  if (
    next.phase === 'active' &&
    prev.state === 'listening' &&
    next.state === 'thinking'
  )
    return 'nod'
  return null
}
