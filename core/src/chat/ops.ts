// Operations the model asks for inside its text reply: `<<op {"op":"correct",...}>>` at the end of the answer.
//
// The ChatProvider interface streams text only (no tool calling) and the local 1.7B brain is unreliable with tool
// schemas, so operations are a plain-text directive. Three pieces:
//   - OpStripper: withholds the directive from the stream, so the user never sees it being typed.
//   - parseOps: extracts and validates the directives from the full reply (balanced JSON, like notes/decision.ts).
//   - searchTerms: turns a "resume" query into terms for the transcript search.

export const OP_OPEN = '<<op'
export const MAX_OPS_PER_TURN = 4

export type ModelOp =
  | { op: 'correct'; ref: string; text: string; reason: string | null }
  | { op: 'resume'; query: string }
  | { op: 'highlight'; ref: string; quote: string; note: string | null }
  | { op: 'fork'; ref: string; title: string | null }
  // Hand a task to the local Hermes agent (ADR 0017). Only the call loop acts on it.
  | { op: 'act'; task: string }

export interface RejectedOp {
  op: string
  reason: string
}

export interface ParsedReply {
  /** The reply without any directive, ready to show. */
  text: string
  ops: ModelOp[]
  rejected: RejectedOp[]
}

/** Streaming filter: pass text through, hold back everything from the first `<<op` (and a partial `<<o`). */
export class OpStripper {
  private held = ''
  private inOp = false
  private all = ''

  /** Text safe to show for this delta. */
  push(delta: string): string {
    this.all += delta
    if (this.inOp) return ''
    this.held += delta
    const at = this.held.indexOf(OP_OPEN)
    if (at >= 0) {
      const out = this.held.slice(0, at)
      this.held = ''
      this.inOp = true
      return out
    }
    let keep = 0
    for (let k = Math.min(OP_OPEN.length - 1, this.held.length); k > 0; k--) {
      if (OP_OPEN.startsWith(this.held.slice(this.held.length - k))) {
        keep = k
        break
      }
    }
    const out = this.held.slice(0, this.held.length - keep)
    this.held = this.held.slice(this.held.length - keep)
    return out
  }

  /** End of stream: whatever was held back as a possible prefix was plain text after all. */
  flush(): string {
    if (this.inOp) return ''
    const out = this.held
    this.held = ''
    return out
  }

  /** Everything the model produced, directives included. */
  get raw(): string {
    return this.all
  }
}

/** End index (exclusive) of the balanced `{...}` that starts at `start`, honoring strings; -1 when it never closes. */
export function balancedObjectEnd(s: string, start: number): number {
  if (s[start] !== '{') return -1
  let depth = 0
  let inString = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null

/** Checks one directive object. Returns the typed op or why it is not valid. */
export function validateOp(v: unknown): ModelOp | RejectedOp {
  if (typeof v !== 'object' || v === null)
    return { op: 'unknown', reason: 'La operación no es un objeto.' }
  const o = v as Record<string, unknown>
  const name = typeof o.op === 'string' ? o.op : 'unknown'
  switch (name) {
    case 'correct': {
      const ref = str(o.ref, 16)
      const text = str(o.text, 2000)
      if (!ref || !text)
        return { op: name, reason: 'Falta la frase o el texto corregido.' }
      return { op: 'correct', ref, text, reason: str(o.reason, 300) }
    }
    case 'resume': {
      const query = str(o.query, 200)
      if (!query) return { op: name, reason: 'Falta el tema a buscar.' }
      return { op: 'resume', query }
    }
    case 'highlight': {
      const ref = str(o.ref, 16)
      const quote = str(o.quote, 1000)
      if (!ref || !quote)
        return { op: name, reason: 'Falta el mensaje o el fragmento.' }
      return { op: 'highlight', ref, quote, note: str(o.note, 300) }
    }
    case 'fork': {
      const ref = str(o.ref, 16)
      if (!ref) return { op: name, reason: 'Falta el mensaje de origen.' }
      return { op: 'fork', ref, title: str(o.title, 80) }
    }
    case 'act': {
      const task = str(o.task, 500)
      if (!task) return { op: name, reason: 'Falta la tarea para el agente.' }
      return { op: 'act', task }
    }
    default:
      return { op: name, reason: 'Operación desconocida.' }
  }
}

// A `correct` op carries an optional `reason` too, so tell them apart by shape: every valid op has `ref`, `query`
// or (for `act`) `task`.
const isRejected = (v: ModelOp | RejectedOp): v is RejectedOp =>
  !('ref' in v) && !('query' in v) && !('task' in v)

/** Splits a full reply into visible text and validated operations. Directives never stay in `text`. */
export function parseOps(raw: string): ParsedReply {
  const ops: ModelOp[] = []
  const rejected: RejectedOp[] = []
  let text = ''
  let i = 0
  while (i < raw.length) {
    const at = raw.indexOf(OP_OPEN, i)
    if (at < 0) {
      text += raw.slice(i)
      break
    }
    text += raw.slice(i, at)
    const brace = raw.indexOf('{', at + OP_OPEN.length)
    const end = brace >= 0 ? balancedObjectEnd(raw, brace) : -1
    if (end < 0) {
      // Truncated or malformed: drop the rest of the directive up to the closing marks (or the end).
      rejected.push({ op: 'unknown', reason: 'Operación incompleta.' })
      const close = raw.indexOf('>>', at)
      i = close >= 0 ? close + 2 : raw.length
      continue
    }
    let parsed: unknown = null
    try {
      parsed = JSON.parse(raw.slice(brace, end))
    } catch {
      rejected.push({ op: 'unknown', reason: 'Operación ilegible.' })
    }
    if (parsed !== null) {
      const checked = validateOp(parsed)
      if (isRejected(checked)) rejected.push(checked)
      else if (ops.length < MAX_OPS_PER_TURN) ops.push(checked)
      else rejected.push({ op: checked.op, reason: 'Demasiadas operaciones.' })
    }
    i = end
    // Optional closing marks right after the object.
    const rest = raw.slice(i)
    const m = /^\s*>>/.exec(rest)
    if (m) i += m[0].length
  }
  return {
    text: text
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    ops,
    rejected,
  }
}

const STOP = new Set([
  'sobre',
  'para',
  'como',
  'cuando',
  'donde',
  'tema',
  'hablamos',
  'hablado',
  'seguir',
  'sigamos',
  'retomar',
  'retomamos',
  'transcript',
  'transcripcion',
  'llamada',
  'antes',
  'esto',
  'esta',
  'este',
  'esos',
  'esas',
  'aquel',
  'aquello',
  'desde',
  'hasta',
  'entre',
  'pero',
  'porque',
  'también',
])

const strip = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '')

/** Terms worth searching for in a "resume" query: lowercase words of 4+ letters, without filler, at most 6. */
export function searchTerms(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !STOP.has(w) && !STOP.has(strip(w)))
  return [...new Set(words)].slice(0, 6)
}
