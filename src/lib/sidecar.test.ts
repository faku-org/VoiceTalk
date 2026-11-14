import { describe, expect, test } from 'bun:test'
import { parseStatus } from './sidecar'

describe('parseStatus', () => {
  test('accepts a well-formed payload', () => {
    const status = parseStatus({
      core: { port: 51234, state: 'healthy', detail: null },
      voice: { port: 51235, state: 'down', detail: 'uv no encontrado' },
    })
    expect(status?.core.state).toBe('healthy')
    expect(status?.voice.detail).toBe('uv no encontrado')
  })

  test('rejects unknown states and bad ports', () => {
    const base = { port: 1, state: 'healthy', detail: null }
    expect(
      parseStatus({ core: { ...base, state: 'ok' }, voice: base }),
    ).toBeNull()
    expect(
      parseStatus({ core: { ...base, port: 1.5 }, voice: base }),
    ).toBeNull()
  })

  test('rejects non-objects and missing sidecars', () => {
    expect(parseStatus(null)).toBeNull()
    expect(parseStatus('x')).toBeNull()
    expect(parseStatus({ core: { port: 1, state: 'down' } })).toBeNull()
  })
})
