import { describe, expect, test } from 'bun:test'
import {
  AGENT_TOOLSETS,
  configCommands,
  enabledToolsets,
  profileEnvValues,
  toolsetCommands,
  validateSetup,
  withProfile,
  type ProfileSetup,
} from '../src/agent/setup.ts'
import {
  assertNotDefault,
  hermesBin,
  hermesHome,
  parseEnv,
  profileDir,
  readAgentKey,
  upsertEnv,
} from '../src/agent/profile.ts'

const setup: ProfileSetup = {
  llmUrl: 'http://127.0.0.1:8080/v1',
  model: 'local',
  port: 8650,
}

const LISTING = [
  'Tools for api_server:',
  '  ✓ enabled   web   Web Search & Scraping',
  '  ✓ enabled   terminal   Terminal & Processes',
  '  ✓ enabled   file   File Operations',
  '  ✓ enabled   vision   Vision / Image Analysis',
  '  ✓ enabled   memory   Memory',
  '  ✗ disabled  computer_use   Computer Use',
  '  ✗ disabled  tts   Text-to-Speech',
].join('\n')

describe('assertNotDefault', () => {
  test('rejects the default profile and path-like names', () => {
    for (const name of [
      'default',
      'Default',
      ' DEFAULT ',
      '',
      '.',
      'a/b',
      'a\\b',
    ]) {
      expect(() => assertNotDefault(name)).toThrow()
    }
  })
  test('accepts voicetalk', () => {
    expect(() => assertNotDefault('voicetalk')).not.toThrow()
  })
  test('profileDir refuses default', () => {
    expect(() => profileDir('default')).toThrow()
  })
})

describe('paths', () => {
  test('HERMES_HOME wins, profile dir sits under profiles/', () => {
    const env = { HERMES_HOME: '/h' }
    expect(hermesHome(env)).toBe('/h')
    expect(profileDir('voicetalk', env).replaceAll('\\', '/')).toBe(
      '/h/profiles/voicetalk',
    )
  })
  test('VT_HERMES_BIN overrides the binary', () => {
    expect(hermesBin({ VT_HERMES_BIN: '/x/hermes' })).toBe('/x/hermes')
  })
})

describe('validateSetup', () => {
  test('accepts a sane setup', () => {
    expect(() => validateSetup(setup)).not.toThrow()
  })
  test('rejects the Ether tunnel port and out-of-range ports', () => {
    for (const port of [8642, 80, 70000, 8650.5, Number.NaN]) {
      expect(() => validateSetup({ ...setup, port })).toThrow()
    }
  })
  test('rejects bad URLs and empty model', () => {
    expect(() => validateSetup({ ...setup, llmUrl: 'nope' })).toThrow()
    expect(() => validateSetup({ ...setup, llmUrl: 'ftp://x/v1' })).toThrow()
    expect(() => validateSetup({ ...setup, model: ' ' })).toThrow()
  })
})

describe('commands', () => {
  test('every command is addressed to the voicetalk profile', () => {
    const all = [...configCommands(setup), ...toolsetCommands(LISTING)].map(
      withProfile,
    )
    for (const args of all)
      expect(args.slice(0, 2)).toEqual(['-p', 'voicetalk'])
  })
  test('config sets a local custom model and manual approvals', () => {
    const flat = configCommands(setup).map((a) => a.join(' '))
    expect(flat).toContain('config set model.provider custom')
    expect(flat).toContain(`config set model.base_url ${setup.llmUrl}`)
    expect(flat).toContain('config set approvals.mode manual')
    expect(flat).toContain('config set gateway.standalone true')
  })
  test('enabledToolsets parses the listing', () => {
    expect(enabledToolsets(LISTING)).toEqual([
      'web',
      'terminal',
      'file',
      'vision',
      'memory',
    ])
  })
  test('toolsets: enables computer_use, disables everything else enabled', () => {
    const cmds = toolsetCommands(LISTING).map((a) => a.join(' '))
    expect(cmds).toEqual([
      'tools enable --platform api_server computer_use',
      'tools disable --platform api_server web memory',
    ])
  })
  test('toolsets: nothing to do once configured', () => {
    const done = AGENT_TOOLSETS.map((n) => `  ✓ enabled   ${n}   x`).join('\n')
    expect(toolsetCommands(done)).toEqual([])
  })
})

describe('env', () => {
  test('generates a key when absent, keeps the existing one', () => {
    const fresh = profileEnvValues(setup, {}, () => 'k1')
    expect(fresh.API_SERVER_KEY).toBe('k1')
    const kept = profileEnvValues(setup, { API_SERVER_KEY: 'old' }, () => 'k2')
    expect(kept.API_SERVER_KEY).toBe('old')
    expect(fresh.API_SERVER_HOST).toBe('127.0.0.1')
    expect(fresh.API_SERVER_PORT).toBe('8650')
    expect(fresh.API_SERVER_ENABLED).toBe('true')
  })
  test('generated keys are random and prefixed', () => {
    const a = profileEnvValues(setup, {}).API_SERVER_KEY
    const b = profileEnvValues(setup, {}).API_SERVER_KEY
    expect(a).not.toBe(b)
    expect(a?.startsWith('vt_')).toBe(true)
  })
  test('the key never appears in a command', () => {
    const key = 'SECRET-KEY'
    const values = profileEnvValues(setup, { API_SERVER_KEY: key })
    expect(values.API_SERVER_KEY).toBe(key)
    const cmds = [...configCommands(setup), ...toolsetCommands(LISTING)]
    expect(JSON.stringify(cmds)).not.toContain(key)
  })
  test('upsertEnv replaces in place, appends, keeps others', () => {
    const out = upsertEnv('A=1\n# c\nB=2\n', { B: '3', C: '4' })
    expect(out).toBe('A=1\n# c\nB=3\nC=4\n')
    expect(parseEnv(out)).toEqual({ A: '1', B: '3', C: '4' })
  })
  test('parseEnv strips quotes and skips comments', () => {
    expect(parseEnv('# x\nA="1"\nB=\'2\'\n\nC=3')).toEqual({
      A: '1',
      B: '2',
      C: '3',
    })
  })
  test('readAgentKey: env var wins, missing profile gives undefined', () => {
    expect(readAgentKey({ VT_AGENT_KEY: ' abc ' })).toBe('abc')
    expect(readAgentKey({ HERMES_HOME: 'Z:\\does-not-exist' })).toBeUndefined()
  })
})
