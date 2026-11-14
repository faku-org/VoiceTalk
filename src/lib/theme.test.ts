import { describe, expect, test } from 'bun:test'
import { isThemePreference, resolveTheme } from './theme'

describe('resolveTheme', () => {
  test('explicit choices ignore the system', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
  test('system follows the OS', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })
})

describe('isThemePreference', () => {
  test('accepts only the three values', () => {
    expect(['system', 'light', 'dark'].every(isThemePreference)).toBe(true)
    expect(isThemePreference('auto')).toBe(false)
    expect(isThemePreference(null)).toBe(false)
  })
})
