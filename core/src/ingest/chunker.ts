export interface Chunk {
  /** Heading breadcrumb of the section (`A > B`), empty before the first heading. */
  heading: string
  /** 1-based line where the chunk starts in the source file. */
  startLine: number
  text: string
}

export interface ChunkOptions {
  /** Window size in estimated tokens. Default 800. */
  maxTokens?: number
  /** Overlap between consecutive windows of one section, in estimated tokens. Default 100. */
  overlapTokens?: number
}

/**
 * Token estimate without a tokenizer: ~4 characters per token holds for Spanish and English prose with
 * Gemma's SentencePiece vocabulary closely enough to size windows (the model accepts 2048).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

interface Section {
  heading: string
  startLine: number
  lines: string[]
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** Splits markdown into sections at ATX headings (`#`…`######`), ignoring `#` lines inside code fences. */
export function splitSections(source: string): Section[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const sections: Section[] = []
  const path: string[] = []
  let current: Section = { heading: '', startLine: 1, lines: [] }
  let fence: string | null = null
  lines.forEach((line, i) => {
    const f = FENCE.exec(line)
    if (f) {
      const mark = f[1]!
      if (fence === null) fence = mark[0]!.repeat(mark.length)
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null
    }
    const h = fence === null && !f ? HEADING.exec(line) : null
    if (h) {
      sections.push(current)
      const level = h[1]!.length
      path.length = level - 1
      path[level - 1] = h[2]!
      current = {
        heading: path.filter(Boolean).join(' > '),
        startLine: i + 1,
        lines: [line],
      }
    } else current.lines.push(line)
  })
  sections.push(current)
  return sections.filter((s) => s.lines.some((l) => l.trim() !== ''))
}

/**
 * Markdown-aware chunking: one chunk per heading section, sections longer than `maxTokens` split into windows on
 * line boundaries with `overlapTokens` of overlap. A single line longer than the window is cut by characters.
 * Plain text is one section with no heading.
 */
export function chunkMarkdown(
  source: string,
  options: ChunkOptions = {},
): Chunk[] {
  const max = options.maxTokens ?? 800
  const overlap = Math.min(options.overlapTokens ?? 100, Math.floor(max / 2))
  const maxChars = max * 4
  const out: Chunk[] = []
  for (const s of splitSections(source)) {
    const text = s.lines.join('\n').trim()
    if (estimateTokens(text) <= max) {
      out.push({ heading: s.heading, startLine: firstNonBlank(s), text })
      continue
    }
    // Windows over (line, part) units so an over-long line is still split.
    const units: { line: number; text: string }[] = []
    s.lines.forEach((l, i) => {
      if (l.length <= maxChars) units.push({ line: s.startLine + i, text: l })
      else
        for (let c = 0; c < l.length; c += maxChars - overlap * 4)
          units.push({ line: s.startLine + i, text: l.slice(c, c + maxChars) })
    })
    let start = 0
    while (start < units.length) {
      let end = start
      let tokens = 0
      while (end < units.length) {
        const t = estimateTokens(units[end]!.text + '\n')
        if (end > start && tokens + t > max) break
        tokens += t
        end++
      }
      const slice = units.slice(start, end)
      const body = slice
        .map((u) => u.text)
        .join('\n')
        .trim()
      if (body)
        out.push({
          heading: s.heading,
          startLine: slice.find((u) => u.text.trim())?.line ?? slice[0]!.line,
          text: body,
        })
      if (end >= units.length) break
      // Step back over the last units until the overlap budget is used, always moving forward.
      let back = end
      let o = 0
      while (back > start + 1) {
        const t = estimateTokens(units[back - 1]!.text + '\n')
        if (o + t > overlap) break
        o += t
        back--
      }
      start = back
    }
  }
  return out
}

function firstNonBlank(s: Section): number {
  const i = s.lines.findIndex((l) => l.trim() !== '')
  return s.startLine + Math.max(0, i)
}
