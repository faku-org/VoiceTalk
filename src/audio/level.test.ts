import { describe, expect, test } from 'bun:test'
import { rmsOf } from './level'

describe('rmsOf', () => {
  test('silence and empty blocks are 0', () => {
    expect(rmsOf([])).toBe(0)
    expect(rmsOf([0, 0, 0])).toBe(0)
  })

  test('a square wave of amplitude a has rms a', () => {
    expect(rmsOf([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5, 5)
  })
})
