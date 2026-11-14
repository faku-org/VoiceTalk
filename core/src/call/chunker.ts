// Cuts a token stream into speakable chunks. The first chunk is cut early (clause or sentence) to
// cut time-to-first-audio; later chunks are whole sentences so the voice keeps its prosody.

export interface ChunkerOptions {
  // Shortest sentence worth sending alone.
  minSentenceChars?: number
  // First chunk only: a clause break (, ; :) is enough once this many characters are buffered.
  firstClauseChars?: number
  // Later chunks: clause break allowed after this many characters (long run-on sentences).
  laterClauseChars?: number
  // Hard cap without any punctuation.
  maxChars?: number
}

const ABBREVIATIONS = new Set([
  'sr',
  'sra',
  'srta',
  'dr',
  'dra',
  'lic',
  'ing',
  'etc',
  'vs',
  'ud',
  'uds',
  'pág',
  'núm',
  'av',
  'tel',
  'ej',
])

const SENTENCE_END = /[.!?…]+["'”»)\]]*(?=\s)/g
const CLAUSE_END = /[,;:](?=\s)/g

export class SentenceChunker {
  private buf = ''
  private emitted = 0
  private readonly minSentence: number
  private readonly firstClause: number
  private readonly laterClause: number
  private readonly max: number

  constructor(opts: ChunkerOptions = {}) {
    this.minSentence = opts.minSentenceChars ?? 4
    this.firstClause = opts.firstClauseChars ?? 24
    this.laterClause = opts.laterClauseChars ?? 90
    this.max = opts.maxChars ?? 180
  }

  // Returns the chunks that became complete with this token.
  push(token: string): string[] {
    this.buf += token
    const out: string[] = []
    for (;;) {
      const end = this.boundary()
      if (end < 0) break
      this.take(end, out)
    }
    return out
  }

  // End of the LLM stream: whatever is left is the last chunk.
  flush(): string[] {
    const out: string[] = []
    this.take(this.buf.length, out)
    return out
  }

  private take(end: number, out: string[]): void {
    const raw = this.buf.slice(0, end)
    this.buf = this.buf.slice(end)
    const text = cleanForSpeech(raw)
    if (text) {
      out.push(text)
      this.emitted++
    }
  }

  // End index (exclusive) of the next chunk in the buffer, or -1 when more tokens are needed.
  private boundary(): number {
    const buf = this.buf
    for (const m of buf.matchAll(SENTENCE_END)) {
      const end = m.index + m[0].length
      if (this.isAbbreviation(buf, m.index)) continue
      if (buf.slice(0, end).trim().length < this.minSentence) continue
      return end
    }
    const clauseMin = this.emitted === 0 ? this.firstClause : this.laterClause
    for (const m of buf.matchAll(CLAUSE_END)) {
      const end = m.index + 1
      if (end >= clauseMin) return end
    }
    if (buf.length > this.max) {
      const cut = buf.lastIndexOf(' ', this.max)
      return cut > 0 ? cut : this.max
    }
    return -1
  }

  private isAbbreviation(buf: string, periodIndex: number): boolean {
    if (buf[periodIndex] !== '.') return false
    const word = /([\p{L}]+)$/u.exec(buf.slice(0, periodIndex))
    return word !== null && ABBREVIATIONS.has(word[1]!.toLowerCase())
  }
}

// The persona forbids markdown and emoji; this is the safety net before the text reaches TTS.
export function cleanForSpeech(raw: string): string {
  const text = raw
    .replace(/[*_`#>~|]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  return /[\p{L}\p{N}]/u.test(text) ? text : ''
}
