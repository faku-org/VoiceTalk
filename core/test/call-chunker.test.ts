import { describe, expect, test } from 'bun:test'
import { SentenceChunker, cleanForSpeech } from '../src/call/chunker.ts'

function run(tokens: string[], opts = {}): string[] {
  const c = new SentenceChunker(opts)
  const out: string[] = []
  for (const t of tokens) out.push(...c.push(t))
  out.push(...c.flush())
  return out
}

describe('SentenceChunker', () => {
  test('cuts on sentence ends and keeps token boundaries irrelevant', () => {
    const text = 'Hola, ¿cómo estás? Estoy bien. Gracias por preguntar.'
    const whole = run([text])
    const bytoken = run(text.split(/(?<= )/))
    const bychar = run(text.split(''))
    expect(whole).toEqual([
      'Hola, ¿cómo estás?',
      'Estoy bien.',
      'Gracias por preguntar.',
    ])
    expect(bytoken).toEqual(whole)
    expect(bychar).toEqual(whole)
  })

  test('first chunk may end at a clause to cut latency; later ones wait for sentences', () => {
    const text =
      'Claro que sí, puedo ayudarte con eso ahora mismo, sin problema. Otra cosa, algo corto.'
    const out = run(text.split(/(?<= )/))
    expect(out[0]).toBe('Claro que sí, puedo ayudarte con eso ahora mismo,')
    expect(out[1]).toBe('sin problema.')
    expect(out[2]).toBe('Otra cosa, algo corto.')
  })

  test('does not cut on decimals or abbreviations', () => {
    expect(run(['La cifra es 3.5 millones. Habló el Dr. Pérez ayer.'])).toEqual(
      ['La cifra es 3.5 millones.', 'Habló el Dr. Pérez ayer.'],
    )
  })

  test('a short sentence is sent alone', () => {
    expect(run(['Claro. Dime qué necesitas.'])).toEqual([
      'Claro.',
      'Dime qué necesitas.',
    ])
  })

  test('hard cap cuts at a space when there is no punctuation', () => {
    const long = Array.from({ length: 60 }, () => 'palabra').join(' ')
    const out = run([long], { maxChars: 50 })
    expect(out.length).toBeGreaterThan(1)
    for (const chunk of out) expect(chunk.length).toBeLessThanOrEqual(50)
    expect(out.join(' ')).toBe(long)
  })

  test('flush returns the tail without a final period; empty tail returns nothing', () => {
    const c = new SentenceChunker()
    expect(c.push('Una frase sin punto final')).toEqual([])
    expect(c.flush()).toEqual(['Una frase sin punto final'])
    expect(c.flush()).toEqual([])
  })
})

describe('cleanForSpeech', () => {
  test('strips markdown and emoji, drops punctuation-only text', () => {
    expect(cleanForSpeech('**Hola** `mundo` 😀')).toBe('Hola mundo')
    expect(cleanForSpeech('...')).toBe('')
    expect(cleanForSpeech('  dos   espacios ')).toBe('dos espacios')
  })
})
