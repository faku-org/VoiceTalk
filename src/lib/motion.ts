import type { Transition } from 'motion/react'

/**
 * Motion policy (DESIGN.md): 120ms for hover/press, 180ms for panels and
 * section changes, 240ms for layout. Reduced motion keeps opacity only.
 * Durations mirror --dur-fast / --dur-panel / --dur-layout in @wefaber/tokens.
 */
export const DUR = { fast: 0.12, panel: 0.18, layout: 0.24 } as const
export const EASE = [0.2, 0, 0, 1] as const

export const transition: Transition = { duration: DUR.panel, ease: EASE }

/** Section / step change: fade, plus a small rise unless motion is reduced. */
export function fadeVariants(reduced: boolean | null) {
  return {
    initial: { opacity: 0, y: reduced ? 0 : 6 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: 0 },
  }
}
