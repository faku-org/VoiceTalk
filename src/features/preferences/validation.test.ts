import { describe, expect, test } from 'bun:test'
import {
  collect,
  validateAgentProfile,
  validateBrainEndpoint,
  validateBrainModel,
  validateCaptureConsent,
  validateEndOfTurn,
  validateSystemPrompt,
  validateLlmUrl,
  validateLocation,
  validateUnit,
  validateVoiceId,
} from './validation'

describe('validation', () => {
  test('agent profile: never default, safe characters only', () => {
    expect(validateAgentProfile('voicetalk')).toBeNull()
    expect(validateAgentProfile('voice_talk-2')).toBeNull()
    expect(validateAgentProfile('')).not.toBeNull()
    expect(validateAgentProfile('default')).toContain('default')
    expect(validateAgentProfile('DEFAULT')).toContain('default')
    expect(validateAgentProfile('../x')).not.toBeNull()
    expect(validateAgentProfile('a'.repeat(65))).not.toBeNull()
  })
  test('brain endpoint: empty only when optional', () => {
    expect(validateBrainEndpoint('', false)).toBeNull()
    expect(validateBrainEndpoint('  ', true)).not.toBeNull()
    expect(validateBrainEndpoint('http://10.0.0.5:1234', true)).toBeNull()
    expect(validateBrainEndpoint('ftp://x', false)).toContain('http')
  })
  test('brain model and system prompt limits', () => {
    expect(validateBrainModel('gpt-5-mini')).toBeNull()
    expect(validateBrainModel('x'.repeat(121))).not.toBeNull()
    expect(validateSystemPrompt('x'.repeat(2000), 2000)).toBeNull()
    expect(validateSystemPrompt('x'.repeat(2001), 2000)).not.toBeNull()
  })
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

describe('capture consent', () => {
  test('cannot enable without acknowledging the notice', () => {
    expect(validateCaptureConsent(true, false)).toMatch(/aviso/)
    expect(validateCaptureConsent(true, true)).toBeNull()
    expect(validateCaptureConsent(false, false)).toBeNull()
  })
})
