// The gate in front of talking: the agent answers in a voice channel only when it is enabled and addressed.

import type { AddressMode } from './config.ts'

/** Lowercase, no accents, punctuation to spaces, single spaces. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** True when any of `names` appears as whole words in `text` ("voicetalk, qué hora es" yes; "voicetalks" no). */
export function isAddressed(text: string, names: string[]): boolean {
  const hay = ` ${normalize(text)} `
  return names.some((n) => {
    const needle = normalize(n)
    return needle !== '' && hay.includes(` ${needle} `)
  })
}

export interface GateInput {
  /** Talking is opt-in per session. */
  talk: boolean
  mode: AddressMode
  names: string[]
  text: string
}

export function shouldAnswer({ talk, mode, names, text }: GateInput): boolean {
  if (!talk) return false
  if (normalize(text) === '') return false
  return mode === 'always' || isAddressed(text, names)
}
