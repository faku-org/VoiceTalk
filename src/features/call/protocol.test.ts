import { describe, expect, test } from 'bun:test'
import { parseServerEvent, upsertEntry } from './protocol'

describe('parseServerEvent', () => {
  test('accepts the documented events', () => {
    expect(parseServerEvent('{"type":"state","state":"thinking"}')).toEqual({
      type: 'state',
      state: 'thinking',
    })
    expect(parseServerEvent('{"type":"level","rms":0.2}')).toEqual({
      type: 'level',
      rms: 0.2,
    })
    expect(parseServerEvent('{"type":"stop_playback"}')).toEqual({
      type: 'stop_playback',
    })
    expect(
      parseServerEvent(
        '{"type":"transcript","final":true,"entry":{"id":"a","speaker":"agent","text":"hola","t":1}}',
      ),
    ).toEqual({
      type: 'transcript',
      final: true,
      entry: { id: 'a', speaker: 'agent', text: 'hola', t: 1 },
    })
  })

  test('rejects malformed or unknown input', () => {
    for (const bad of [
      'no es json',
      '[]',
      '{"type":"state","state":"dormido"}',
      '{"type":"level","rms":"alto"}',
      '{"type":"transcript","final":true,"entry":{"id":"a","speaker":"otro","text":"x","t":1}}',
      '{"type":"latency","turn":1,"latency":{"totalMs":1}}',
      '{"type":"desconocido"}',
    ])
      expect(parseServerEvent(bad)).toBeNull()
  })
})

describe('upsertEntry', () => {
  test('replaces by id and appends new ids in order', () => {
    const a = { id: 'a', speaker: 'user', text: 'uno', t: 1 } as const
    const b = { id: 'b', speaker: 'agent', text: 'dos', t: 2 } as const
    const list = upsertEntry(upsertEntry([], a), b)
    expect(list.map((e) => e.id)).toEqual(['a', 'b'])
    const grown = upsertEntry(list, { ...b, text: 'dos y más' })
    expect(grown.map((e) => e.text)).toEqual(['uno', 'dos y más'])
    expect(list[1]?.text).toBe('dos')
  })
})
