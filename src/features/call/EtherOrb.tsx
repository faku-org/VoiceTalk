import { useEffect, useRef, useState } from 'react'
import {
  EtherStage,
  createEther,
  react,
  setMood,
  setState,
  type Ether,
} from '@wefaber/orb/rig'
import {
  etherLabel,
  reactionFor,
  routeLevels,
  type EtherMood,
  type EtherState,
  type ReactionContext,
} from './ether-state'
import type { CallLevels, CallPhase } from './use-call'

// The body is `size` px wide; the ring and its sway need room around it.
const STAGE_PER_BODY = 1.6
// Listening keeps this much of the bands even in silence.
const LISTEN_FLOOR = 0.25

export interface EtherOrbProps {
  state: EtherState
  /** Call phase, only to time the one-shot reactions. */
  phase: CallPhase
  /** Written state ("Escuchando"); the canvas label becomes "Ether: escuchando". */
  word: string
  /** Stage side in CSS px (240 in the side column, 120 on narrow windows). */
  stage: number
  /** Mic and playback loudness, read every frame. Omit for a silent Ether. */
  levels?: CallLevels
  /** Lasting mood, set on topic changes only. Neutral by default and after the call. */
  mood?: EtherMood
}

/**
 * Ether on the call screen: one instance, `awake`, fixed in place, no sound. The call owns her state; the host
 * feeds voice each frame. Reduced motion is handled by `EtherStage`. Never a loading indicator.
 */
export function EtherOrb({
  state,
  phase,
  word,
  stage,
  levels,
  mood = 'neutral',
}: EtherOrbProps) {
  // Created once: motion.x / motion.y stay at their centred defaults, so she never moves while the user reads.
  const [ether] = useState(() => createEther({ mode: 'awake', state }))
  const stateRef = useRef(state)
  const levelsRef = useRef(levels)
  const prev = useRef<ReactionContext>({ phase, state })

  useEffect(() => {
    levelsRef.current = levels
  })

  useEffect(() => {
    stateRef.current = state
    setState(ether, state)
    const next = { phase, state }
    const reaction = reactionFor(prev.current, next)
    if (reaction) react(ether, reaction)
    prev.current = next
  }, [ether, state, phase])

  useEffect(() => {
    setMood(ether, mood, 1)
  }, [ether, mood])

  // Per frame, before drawing: route the right level to the right channel.
  const feed = (e: Ether) => {
    const src = levelsRef.current
    const { listen, speak } = routeLevels(
      stateRef.current,
      src?.mic() ?? 0,
      src?.playback() ?? 0,
    )
    // `setState` owns body.listen (0.7 while listening, reset otherwise): only ride it while she listens, and
    // never let the bands go slack between words. body.speak is ours alone, so it is always written.
    if (stateRef.current === 'listening')
      e.target.body.listen = Math.max(LISTEN_FLOOR, listen)
    e.target.body.speak = speak
  }

  const size = Math.round(stage / STAGE_PER_BODY)
  return (
    <EtherStage
      ether={ether}
      width={stage}
      height={stage}
      size={size}
      onFrame={feed}
      label={etherLabel(word)}
      className="shrink-0"
    />
  )
}
