// What Ether says out loud about a task: one or two short sentences, no markdown, never a file listing.

const MAX_SPOKEN = 180
const MAX_SENTENCES = 2

/** Plain-text version of a Hermes answer: code, links and markdown marks removed. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^[\s#>*+|-]+/gm, '')
    .replace(/[*_~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The short spoken line for a finished task. Falls back to "Listo." when there is nothing speakable. */
export function spokenSummary(output: string, max = MAX_SPOKEN): string {
  const clean = plainText(output)
  if (!clean) return 'Listo.'
  // A boundary is punctuation followed by a space or the end, so "a.txt" stays in one piece.
  const parts = clean.match(/.+?(?:[.!?]+(?=\s|$)|$)/g) ?? [clean]
  let out = ''
  let count = 0
  for (const part of parts) {
    const next = `${out} ${part.trim()}`.trim()
    if (next.length > max) break
    out = next
    if (++count >= MAX_SENTENCES) break
  }
  if (out) return out
  // A single long sentence: cut at a word boundary.
  const cut = clean.slice(0, max).replace(/\s+\S*$/, '')
  return `${cut || clean.slice(0, max)}.`
}

/** One short line for what the agent wants permission to do. */
export function spokenPermission(description: string, max = 120): string {
  const clean = plainText(description)
  const text =
    clean.length > max ? clean.slice(0, max).replace(/\s+\S*$/, '') : clean
  return text
    ? `Necesito tu permiso: ${text}.`
    : 'Necesito tu permiso para continuar.'
}
