import { describe, expect, test } from 'bun:test'
import { chunkMarkdown, estimateTokens } from '../src/ingest/index.ts'

describe('chunkMarkdown', () => {
  test('splits at headings and keeps the breadcrumb', () => {
    const md =
      '# Plan\nintro\n\n## Goals\nship it\n\n## Risks\nnone\n\n# Log\nentry'
    const chunks = chunkMarkdown(md)
    expect(chunks.map((c) => c.heading)).toEqual([
      'Plan',
      'Plan > Goals',
      'Plan > Risks',
      'Log',
    ])
    expect(chunks[1]!.startLine).toBe(4)
    expect(chunks[1]!.text).toContain('ship it')
  })

  test('text before the first heading has an empty heading; plain text is one chunk', () => {
    expect(chunkMarkdown('just some text\nmore')).toEqual([
      { heading: '', startLine: 1, text: 'just some text\nmore' },
    ])
    expect(chunkMarkdown('pre\n# H\nbody').map((c) => c.heading)).toEqual([
      '',
      'H',
    ])
  })

  test('ignores # lines inside code fences', () => {
    const md = '# A\n```sh\n# not a heading\n```\nafter'
    const chunks = chunkMarkdown(md)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.text).toContain('# not a heading')
  })

  test('empty and whitespace-only input yields no chunks', () => {
    expect(chunkMarkdown('')).toEqual([])
    expect(chunkMarkdown('  \n\n')).toEqual([])
    expect(chunkMarkdown('# Only heading')).toHaveLength(1)
  })

  test('long sections become overlapping windows under the token budget', () => {
    const lines = Array.from(
      { length: 200 },
      (_, i) => `line ${i} ${'word '.repeat(10)}`,
    )
    const md = `# Big\n${lines.join('\n')}`
    const chunks = chunkMarkdown(md, { maxTokens: 100, overlapTokens: 20 })
    expect(chunks.length).toBeGreaterThan(3)
    for (const c of chunks) {
      expect(estimateTokens(c.text)).toBeLessThanOrEqual(100)
      expect(c.heading).toBe('Big')
    }
    // Windows move forward and consecutive ones share at least one line (overlap).
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startLine).toBeGreaterThan(chunks[i - 1]!.startLine)
      const prev = new Set(chunks[i - 1]!.text.split('\n').map((l) => l.trim()))
      expect(chunks[i]!.text.split('\n').some((l) => prev.has(l.trim()))).toBe(
        true,
      )
    }
    // Every source line appears in some window.
    const joined = chunks.map((c) => c.text).join('\n')
    for (const l of lines) expect(joined).toContain(l.trim())
  })

  test('a single huge line is cut by characters and terminates', () => {
    const chunks = chunkMarkdown('x'.repeat(20_000), {
      maxTokens: 100,
      overlapTokens: 10,
    })
    expect(chunks.length).toBeGreaterThan(40)
    for (const c of chunks)
      expect(estimateTokens(c.text)).toBeLessThanOrEqual(100)
  })

  test('CRLF input behaves like LF', () => {
    expect(chunkMarkdown('# A\r\nx\r\n## B\r\ny')).toEqual(
      chunkMarkdown('# A\nx\n## B\ny'),
    )
  })
})
