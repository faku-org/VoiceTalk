import { describe, expect, test } from 'bun:test'
import {
  collect,
  validateEndOfTurn,
  validateLlmUrl,
  validateLocation,
  validateUnit,
  validateVoiceId,
} from './validation'

describe('validation', () => {
  test('llm url', () => {
    expect(validateLlmUrl('http://127.0.0.1:8080/v1')).toBeNull()
    expect(validateLlmUrl('https://api.example.com')).toBeNull()
    expect(validateLlmUrl('')).not.toBeNull()
    expect(validateLlmUrl('ftp://x')).toContain('http')
    expect(validateLlmUrl('no es url')).not.toBeNull()
  })
  test('voice id', () => {
    expect(validateVoiceId('4663e61a')).toBeNull()
    expect(validateVoiceId('  ')).not.toBeNull()
    expect(validateVoiceId('x'.repeat(65))).not.toBeNull()
  })
  test('unit interval', () => {
    expect(validateUnit('Confianza', 0)).toBeNull()
    expect(validateUnit('Confianza', 1)).toBeNull()
    expect(validateUnit('Confianza', 1.1)).toContain('entre 0 y 1')
    expect(validateUnit('Confianza', Number.NaN)).toContain('número')
  })
  test('end of turn', () => {
    expect(validateEndOfTurn(700)).toBeNull()
    expect(validateEndOfTurn(199)).not.toBeNull()
    expect(validateEndOfTurn(3001)).not.toBeNull()
    expect(validateEndOfTurn(700.5)).not.toBeNull()
  })
  test('location', () => {
    expect(validateLocation('Montevideo')).toBeNull()
    expect(validateLocation('x'.repeat(121))).not.toBeNull()
  })
  test('collect drops nulls', () => {
    expect(
      collect([
        ['a', null],
        ['b', 'mal'],
      ]),
    ).toEqual([{ field: 'b', message: 'mal' }])
  })
})
