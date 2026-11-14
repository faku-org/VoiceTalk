import { describe, expect, test } from 'bun:test'
import {
  formatDuration,
  formatOffset,
  formatStarted,
  sessionLabel,
  sourceLabel,
  speakerLabel,
  statusLabel,
} from './format'

describe('sessions format', () => {
  test('duration', () => {
    expect(formatDuration(0, null)).toBeNull()
    expect(formatDuration(5000, 1000)).toBeNull()
    expect(formatDuration(0, 45_000)).toBe('45 s')
    expect(formatDuration(0, 12 * 60_000)).toBe('12 min')
    expect(formatDuration(0, (60 + 5) * 60_000)).toBe('1 h 05 min')
  })

  test('offset inside the session', () => {
    expect(formatOffset(1000, 8000)).toBe('00:07')
    expect(formatOffset(0, 12 * 60_000 + 3000)).toBe('12:03')
    expect(formatOffset(0, 3_729_000)).toBe('1:02:09')
    expect(formatOffset(5000, 1000)).toBe('00:00')
  })

  test('labels are neutral Spanish', () => {
    expect(statusLabel('active')).toBe('En curso')
    expect(statusLabel('ended')).toBe('Finalizada')
    expect(statusLabel('interrupted')).toBe('Interrumpida')
    expect(statusLabel('other')).toBe('other')
    expect(speakerLabel('user')).toBe('Tú')
    expect(speakerLabel('agent')).toBe('Agente')
  })

  test('captured calls: remote label and platform', () => {
    expect(speakerLabel('remote', 'Discord')).toBe('Discord')
    expect(speakerLabel('remote', '  ')).toBe('Interlocutor')
    expect(speakerLabel('user', null)).toBe('Tú')
    expect(sourceLabel('call')).toBeNull()
    expect(sourceLabel('teams')).toBe('Microsoft Teams')
    expect(sourceLabel('legacy')).toBe('legacy')
  })

  test('date and title', () => {
    expect(formatStarted(Date.UTC(2026, 10, 14, 18, 30), 'UTC')).toMatch(
      /14.*nov.*2026.*18:30/,
    )
    expect(sessionLabel('  Mi hermana  ', 0)).toBe('Mi hermana')
    expect(sessionLabel(null, Date.UTC(2026, 10, 14))).toMatch(
      /^Conversación del .*2026/,
    )
    expect(sessionLabel('   ', 0)).toMatch(/^Conversación del /)
  })
})
