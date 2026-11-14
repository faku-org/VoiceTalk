import { describe, expect, test } from 'bun:test'
import {
  addFolders,
  completionRecord,
  isLastStep,
  isOnboardingComplete,
  levelFromRms,
  MAX_FOLDERS,
  nextStepIndex,
  ONBOARDING_STEPS,
  ONBOARDING_VERSION,
  onboardingProgress,
  previousStepIndex,
  removeFolder,
  rms,
} from './onboarding'

describe('completion', () => {
  test('null or other version is not complete', () => {
    expect(isOnboardingComplete(null)).toBe(false)
    expect(isOnboardingComplete(undefined)).toBe(false)
    expect(
      isOnboardingComplete({
        version: ONBOARDING_VERSION + 1,
        completedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBe(false)
  })
  test('a fresh record is complete and carries the date', () => {
    const record = completionRecord(new Date('2026-11-14T12:00:00Z'))
    expect(record).toEqual({
      version: ONBOARDING_VERSION,
      completedAt: '2026-11-14T12:00:00.000Z',
    })
    expect(isOnboardingComplete(record)).toBe(true)
  })
})

describe('navigation', () => {
  const total = ONBOARDING_STEPS.length
  test('clamps at both ends', () => {
    expect(nextStepIndex(total - 1, total)).toBe(total - 1)
    expect(previousStepIndex(0, total)).toBe(0)
    expect(nextStepIndex(0, total)).toBe(1)
    expect(previousStepIndex(3, total)).toBe(2)
  })
  test('last step and progress', () => {
    expect(isLastStep(total - 1, total)).toBe(true)
    expect(isLastStep(0, total)).toBe(false)
    expect(isLastStep(0, 0)).toBe(false)
    expect(onboardingProgress(0, 4)).toBe(25)
    expect(onboardingProgress(3, 4)).toBe(100)
    expect(onboardingProgress(9, 4)).toBe(100)
    expect(onboardingProgress(0, 0)).toBe(0)
  })
  test('flow starts at welcome and ends at theme', () => {
    expect(ONBOARDING_STEPS[0]).toBe('welcome')
    expect(ONBOARDING_STEPS.at(-1)).toBe('theme')
  })
})

describe('folders', () => {
  test('trims, skips blanks and case-insensitive duplicates', () => {
    expect(addFolders(['D:/Notas'], [' d:/notas ', '', 'E:/Docs'])).toEqual([
      'D:/Notas',
      'E:/Docs',
    ])
  })
  test('caps the list', () => {
    const many = Array.from({ length: MAX_FOLDERS + 5 }, (_, i) => `D:/f${i}`)
    expect(addFolders([], many)).toHaveLength(MAX_FOLDERS)
  })
  test('removes by exact path', () => {
    expect(removeFolder(['a', 'b'], 'a')).toEqual(['b'])
  })
})

describe('microphone level', () => {
  test('silence is zero', () => {
    expect(rms(new Float32Array(128))).toBe(0)
    expect(rms([])).toBe(0)
    expect(levelFromRms(0)).toBe(0)
  })
  test('rms of a square wave is its amplitude', () => {
    expect(rms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5)
  })
  test('meter maps -60..0 dBFS to 0..1', () => {
    expect(levelFromRms(1)).toBe(1)
    expect(levelFromRms(10 ** (-30 / 20))).toBeCloseTo(0.5)
    expect(levelFromRms(0.001)).toBeCloseTo(0)
    expect(levelFromRms(0.0001)).toBe(0)
    expect(levelFromRms(5)).toBe(1)
  })
})
