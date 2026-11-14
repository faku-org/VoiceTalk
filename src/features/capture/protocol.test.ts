import { describe, expect, test } from 'bun:test'
import {
  blockText,
  errorText,
  formatClock,
  meterPercent,
  parseError,
  parseLevels,
  parseSources,
  parseStart,
  parseStop,
  platformLabel,
} from './protocol'

describe('capture protocol', () => {
  test('sources: valid rows kept, junk dropped', () => {
    const rows = parseSources([
      {
        pid: 4120,
        name: 'Discord.exe',
        platform: 'discord',
        known: true,
        playing: true,
        level: 0.12,
      },
      { pid: 0, name: 'System', platform: 'other' },
      { pid: 7, name: 'x.exe' },
      'nope',
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ pid: 4120, known: true, playing: true })
    expect(parseSources(null)).toEqual([])
  })

  test('start and stop payloads', () => {
    expect(
      parseStart({
        callId: 'c1',
        pid: 9,
        name: 'Zoom.exe',
        platform: 'zoom',
        mic: true,
        micError: null,
      }),
    ).toMatchObject({ callId: 'c1', mic: true, micError: null })
    expect(parseStart({ pid: 9 })).toBeNull()
    expect(parseStop({ callId: 'c1', utterances: 5, error: null })).toEqual({
      callId: 'c1',
      utterances: 5,
      error: null,
    })
    expect(
      parseStop({
        callId: 'c1',
        utterances: null,
        error: { code: 'stt', message: 'boom' },
      })?.error,
    ).toEqual({ code: 'stt', message: 'boom' })
    expect(parseStop('x')).toBeNull()
  })

  test('levels', () => {
    expect(parseLevels({ remote: 0.1, mic: 0, seconds: 3 })).toEqual({
      remote: 0.1,
      mic: 0,
      seconds: 3,
    })
    expect(parseLevels({ remote: 'a', mic: 0, seconds: 1 })).toBeNull()
  })

  test('errors come back as objects whatever Tauri rejects with', () => {
    expect(parseError({ code: 'busy', message: 'm' })).toEqual({
      code: 'busy',
      message: 'm',
    })
    expect(parseError('texto').message).toBe('texto')
    expect(parseError(undefined).code).toBe('unknown')
    expect(errorText({ code: 'busy', message: 'x' })).toMatch(/en curso/)
    expect(errorText({ code: 'device', message: 'sin audio' })).toBe(
      'sin audio',
    )
  })

  test('block messages and labels are neutral Spanish', () => {
    expect(blockText('disabled')).toMatch(/Actívala/)
    expect(blockText('env')).toMatch(/VT_CAPTURE=off/)
    expect(blockText('zzz')).toMatch(/no está disponible/)
    expect(platformLabel('teams')).toBe('Microsoft Teams')
    expect(platformLabel('nope')).toBe('nope')
  })

  test('meter and clock', () => {
    expect(meterPercent(0)).toBe(0)
    expect(meterPercent(0.1)).toBe(40)
    expect(meterPercent(2)).toBe(100)
    expect(meterPercent(-1)).toBe(0)
    expect(formatClock(7)).toBe('00:07')
    expect(formatClock(723)).toBe('12:03')
    expect(formatClock(3729)).toBe('1:02:09')
  })
})
