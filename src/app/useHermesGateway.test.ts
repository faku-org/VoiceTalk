import { describe, expect, test } from 'bun:test'
import { gatewayAction } from './useHermesGateway'

const agent = {
  enabled: true,
  url: ' http://127.0.0.1:8650 ',
  profile: ' voicetalk ',
  model: '',
}

describe('gatewayAction', () => {
  test('enabled: ensure with trimmed profile and url', () => {
    expect(gatewayAction(agent)).toEqual({
      kind: 'ensure',
      profile: 'voicetalk',
      url: 'http://127.0.0.1:8650',
    })
  })

  test('disabled or not loaded yet: stop (only what the shell started)', () => {
    expect(gatewayAction({ ...agent, enabled: false })).toEqual({
      kind: 'stop',
    })
    expect(gatewayAction(undefined)).toEqual({ kind: 'stop' })
  })
})
