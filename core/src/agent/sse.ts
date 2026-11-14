// Minimal SSE reader for the Hermes run stream. Comment lines (`: keepalive`) are skipped; only `data:` frames count.

/** Yields the parsed JSON of each `data:` frame. Malformed frames are skipped, never thrown. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        const frame = parseDataLine(line)
        if (frame) yield frame
      }
    }
    const tail = parseDataLine(buf.trim())
    if (tail) yield tail
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

export function parseDataLine(line: string): Record<string, unknown> | null {
  if (!line.startsWith('data:')) return null // `: keepalive`, `event:`, `id:`, blank
  const raw = line.slice(5).trim()
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
