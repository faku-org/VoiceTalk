import { describe, expect, test } from 'bun:test'
import {
  parseServerEvent,
  pendingApproval,
  upsertEntry,
  upsertStep,
  type AgentStep,
} from './protocol'

const step = (over: Partial<AgentStep> = {}): AgentStep => ({
  id: 's1',
  kind: 'approval',
  status: 'pending',
  title: 'Borrar archivos',
  t: 1,
  ...over,
})

describe('agent events', () => {
  test('parses agent state and steps', () => {
    expect(parseServerEvent('{"type":"agent","state":"attention"}')).toEqual({
      type: 'agent',
      state: 'attention',
    })
    expect(
      parseServerEvent(
        '{"type":"agent_step","step":{"id":"s1","kind":"approval","status":"pending","title":"Borrar","detail":"rm x","t":3}}',
      ),
    ).toEqual({
      type: 'agent_step',
      step: {
        id: 's1',
        kind: 'approval',
        status: 'pending',
        title: 'Borrar',
        detail: 'rm x',
        t: 3,
      },
    })
  })

  test('rejects malformed agent frames', () => {
    for (const bad of [
      '{"type":"agent","state":"dormido"}',
      '{"type":"agent_step","step":{"id":"s","kind":"otra","status":"pending","title":"x","t":1}}',
      '{"type":"agent_step","step":{"id":"s","kind":"task","status":"raro","title":"x","t":1}}',
      '{"type":"agent_step","step":{"id":"s","kind":"task","status":"done","t":1}}',
      '{"type":"agent_step"}',
    ])
      expect(parseServerEvent(bad)).toBeNull()
  })

  test('upsertStep keeps the row and its position', () => {
    const a = step({ id: 'a', kind: 'task', status: 'running' })
    const b = step({ id: 'b' })
    const list = upsertStep(upsertStep([], a), b)
    const next = upsertStep(list, { ...b, status: 'allowed' })
    expect(next.map((s) => s.id)).toEqual(['a', 'b'])
    expect(next[1]?.status).toBe('allowed')
  })

  test('pendingApproval finds only a pending approval', () => {
    expect(pendingApproval([])).toBeNull()
    expect(
      pendingApproval([step({ kind: 'task', status: 'pending' })]),
    ).toBeNull()
    expect(pendingApproval([step({ status: 'allowed' })])).toBeNull()
    expect(pendingApproval([step({ id: 'p' })])?.id).toBe('p')
  })
})

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
