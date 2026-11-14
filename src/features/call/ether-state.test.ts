import { describe, expect, test } from 'bun:test'
import {
  etherLabel,
  etherStateFor,
  reactionFor,
  routeLevels,
  shapeLevel,
  stateWord,
  type CallSnapshot,
} from './ether-state'

const base: CallSnapshot = {
  phase: 'active',
  agentState: 'idle',
  error: false,
  offline: false,
  longIdle: false,
}

describe('etherStateFor', () => {
  test('follows the agent state during an active call', () => {
    for (const s of ['idle', 'listening', 'thinking', 'speaking'] as const)
      expect(etherStateFor({ ...base, agentState: s })).toBe(s)
  })

  test('connecting stays idle, never a loading animation', () => {
    expect(etherStateFor({ ...base, phase: 'connecting' })).toBe('idle')
  })

  test('offline wins outside a call, even over an error', () => {
    expect(
      etherStateFor({ ...base, phase: 'idle', offline: true, error: true }),
    ).toBe('offline')
  })

  test('a failed start shows error; a mid-call error does not', () => {
    expect(etherStateFor({ ...base, phase: 'idle', error: true })).toBe('error')
    expect(
      etherStateFor({ ...base, agentState: 'speaking', error: true }),
    ).toBe('speaking')
  })

  test('resting only after long idle outside a call', () => {
    expect(etherStateFor({ ...base, phase: 'idle', longIdle: true })).toBe(
      'resting',
    )
    expect(etherStateFor({ ...base, phase: 'idle' })).toBe('idle')
    expect(etherStateFor({ ...base, longIdle: true })).toBe('idle')
  })
})

describe('words and labels', () => {
  test('state word and aria-label', () => {
    expect(stateWord('listening', 'active')).toBe('Escuchando')
    expect(etherLabel(stateWord('listening', 'active'))).toBe(
      'Ether: escuchando',
    )
    expect(stateWord('idle', 'connecting')).toBe('Conectando')
    expect(etherLabel(stateWord('offline', 'idle'))).toBe(
      'Ether: sin servicios',
    )
  })
})

describe('level routing', () => {
  test('mic feeds listen only while listening', () => {
    expect(routeLevels('listening', 0.1, 0.5)).toEqual({
      listen: shapeLevel(0.1),
      speak: 0,
    })
  })

  test('playback feeds speak only while speaking', () => {
    expect(routeLevels('speaking', 0.1, 0.25)).toEqual({
      listen: 0,
      speak: shapeLevel(0.25),
    })
  })

  test('barge-in: speaking -> listening swaps channels at once', () => {
    const before = routeLevels('speaking', 0.2, 0.3)
    const after = routeLevels('listening', 0.2, 0.3)
    expect(before.listen).toBe(0)
    expect(before.speak).toBeGreaterThan(0)
    expect(after.speak).toBe(0)
    expect(after.listen).toBeGreaterThan(0)
  })

  test('every other state is silent', () => {
    for (const s of [
      'idle',
      'thinking',
      'error',
      'offline',
      'resting',
    ] as const)
      expect(routeLevels(s, 0.9, 0.9)).toEqual({ listen: 0, speak: 0 })
  })

  test('shapeLevel clamps and ignores junk', () => {
    expect(shapeLevel(-1)).toBe(0)
    expect(shapeLevel(Number.NaN)).toBe(0)
    expect(shapeLevel(4)).toBe(1)
    expect(shapeLevel(0.04)).toBeCloseTo(0.28, 2)
  })
})

describe('reactionFor', () => {
  test('hop when the call goes live', () => {
    expect(
      reactionFor(
        { phase: 'connecting', state: 'idle' },
        { phase: 'active', state: 'idle' },
      ),
    ).toBe('hop')
  })

  test('nod when the user turn ends', () => {
    expect(
      reactionFor(
        { phase: 'active', state: 'listening' },
        { phase: 'active', state: 'thinking' },
      ),
    ).toBe('nod')
  })

  test('nothing else reacts', () => {
    expect(
      reactionFor(
        { phase: 'active', state: 'thinking' },
        { phase: 'active', state: 'speaking' },
      ),
    ).toBeNull()
    expect(
      reactionFor(
        { phase: 'active', state: 'speaking' },
        { phase: 'active', state: 'listening' },
      ),
    ).toBeNull()
    expect(
      reactionFor(
        { phase: 'active', state: 'idle' },
        { phase: 'idle', state: 'idle' },
      ),
    ).toBeNull()
  })
})
