// Pure helpers of the shared timeline (voice and text turns): wire types, SSE parsing, highlight anchoring, selection -> range. No DOM, no React.

export type TargetKind = 'message' | 'utterance'

export interface ChatThread {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  forkedFromThread: string | null
  forkedFromMessage: string | null
  sessionId: string | null
  cutoffAt: number | null
}

export interface ChatReply {
  kind: TargetKind
  id: string
  label: string
  text: string
}

export interface ChatAction {
  type: 'correction' | 'highlight' | 'fork' | 'resume' | 'rejected'
  op: string | null
  reason: string | null
  utteranceId: string | null
  original: string | null
  corrected: string | null
  highlightId: string | null
  targetKind: string | null
  targetId: string | null
  quoted: string | null
  threadId: string | null
  title: string | null
  query: string | null
  utteranceIds: string[] | null
}

export interface ChatItem {
  kind: TargetKind
  id: string
  at: number
  text: string
  role: 'user' | 'assistant' | null
  status: 'done' | 'streaming' | 'interrupted' | 'error' | null
  replyTo: ChatReply | null
  quote: string | null
  actions: ChatAction[]
  sessionId: string | null
  speaker: string | null
  label: string | null
  speakerName: string | null
  originalText: string | null
  corrected: boolean
  /** The turn being spoken or written right now: it has no stored copy yet. */
  pending?: boolean
}

export interface ChatHighlight {
  id: string
  targetKind: TargetKind
  targetId: string
  start: number
  end: number
  quoted: string
  note: string | null
  createdAt: number
}

export interface ChatSession {
  id: string
  title: string | null
  startedAt: number
  endedAt: number | null
  source: string
}

export interface ChatTimeline {
  thread: ChatThread
  items: ChatItem[]
  sessions: ChatSession[]
  highlights: ChatHighlight[]
  busy: boolean
}

/** What the composer is pointing at: a message or utterance to reply to, and an optional selected fragment. */
export interface ComposerTarget {
  kind: TargetKind
  id: string
  label: string
  /** The text of the target, only to show a preview in the composer. */
  text: string
  /** Selected fragment (follow-up from a selection). */
  quote: string | null
  /** Why the composer points here: a plain reply or a correction the user is about to write. */
  intent?: 'reply' | 'correct'
}

// --- SSE -----------------------------------------------------------------------------------------------------------

/** A message as the SSE stream sends it (the core's own shape: absent keys instead of GraphQL nulls). */
export interface StreamMessage {
  id: string
  at: number
  role: 'user' | 'assistant'
  text: string
  status: NonNullable<ChatItem['status']>
  replyTo: ChatReply | null
  quote: string | null
  actions: Array<Partial<ChatAction> & { type: ChatAction['type'] }>
}

export type ChatStreamEvent =
  | { type: 'user'; message: StreamMessage }
  | { type: 'delta'; text: string }
  | {
      type: 'action'
      action: Partial<ChatAction> & { type: ChatAction['type'] }
    }
  | { type: 'done'; message: StreamMessage }
  | { type: 'error'; message: string }

/** Fills the keys a stream action does not carry, so it has the same shape as one read through GraphQL. */
export function normalizeAction(
  a: Partial<ChatAction> & { type: ChatAction['type'] },
): ChatAction {
  return {
    op: null,
    reason: null,
    utteranceId: null,
    original: null,
    corrected: null,
    highlightId: null,
    targetKind: null,
    targetId: null,
    quoted: null,
    threadId: null,
    title: null,
    query: null,
    utteranceIds: null,
    ...a,
  }
}

export function messageToItem(m: StreamMessage): ChatItem {
  return {
    kind: 'message',
    id: m.id,
    at: m.at,
    text: m.text,
    role: m.role,
    status: m.status,
    replyTo: m.replyTo,
    quote: m.quote,
    actions: m.actions.map(normalizeAction),
    sessionId: null,
    speaker: null,
    label: null,
    speakerName: null,
    originalText: null,
    corrected: false,
  }
}

/**
 * Splits an SSE buffer into complete events. The tail without a blank line is returned as `rest`, to be prepended to
 * the next chunk. Unknown or malformed events are dropped.
 */
export function parseSse(buffer: string): {
  events: ChatStreamEvent[]
  rest: string
} {
  const events: ChatStreamEvent[] = []
  const normalized = buffer.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n\n')
  const rest = parts.pop() ?? ''
  for (const block of parts) {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!data) continue
    try {
      const ev = JSON.parse(data) as { type?: unknown }
      if (
        ev.type === 'user' ||
        ev.type === 'delta' ||
        ev.type === 'action' ||
        ev.type === 'done' ||
        ev.type === 'error'
      )
        events.push(ev as ChatStreamEvent)
    } catch {
      // Not JSON: ignore the block.
    }
  }
  return { events, rest }
}

// --- Highlights ----------------------------------------------------------------------------------------------------

export interface Segment {
  text: string
  /** Id of the highlight covering this segment, or null for plain text. */
  highlightId: string | null
}

/**
 * Where a highlight sits in `text` now. The stored range is trusted when it still holds the quoted text; otherwise
 * (the text was corrected, or the message changed) the quote is searched. Null when it cannot be placed.
 */
export function anchorHighlight(
  text: string,
  h: Pick<ChatHighlight, 'start' | 'end' | 'quoted'>,
): { start: number; end: number } | null {
  if (!h.quoted) return null
  if (text.slice(h.start, h.end) === h.quoted)
    return { start: h.start, end: h.end }
  const at = text.indexOf(h.quoted)
  return at >= 0 ? { start: at, end: at + h.quoted.length } : null
}

/** Splits `text` into plain and highlighted runs. Overlapping highlights: the earlier one wins the overlap. */
export function segmentText(
  text: string,
  highlights: ReadonlyArray<
    Pick<ChatHighlight, 'id' | 'start' | 'end' | 'quoted'>
  >,
): Segment[] {
  const placed = highlights
    .map((h) => ({ id: h.id, at: anchorHighlight(text, h) }))
    .filter(
      (p): p is { id: string; at: { start: number; end: number } } =>
        p.at !== null,
    )
    .sort((a, b) => a.at.start - b.at.start)
  const out: Segment[] = []
  let cursor = 0
  for (const p of placed) {
    const start = Math.max(p.at.start, cursor)
    if (p.at.end <= start) continue
    if (start > cursor)
      out.push({ text: text.slice(cursor, start), highlightId: null })
    out.push({ text: text.slice(start, p.at.end), highlightId: p.id })
    cursor = p.at.end
  }
  if (cursor < text.length)
    out.push({ text: text.slice(cursor), highlightId: null })
  return out.length > 0 ? out : [{ text, highlightId: null }]
}

// --- Selection -----------------------------------------------------------------------------------------------------

/**
 * Normalizes a selected fragment for a follow-up: collapses whitespace and caps the length. Null when there is
 * nothing meaningful selected.
 */
export function cleanSelection(raw: string, max = 600): string | null {
  const t = raw.replace(/\s+/g, ' ').trim()
  if (t.length < 2) return null
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** Short preview for a reply chip. */
export function preview(text: string, max = 90): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

// --- Timeline ------------------------------------------------------------------------------------------------------

/** Inserts or replaces an item (by id) keeping chronological order. */
export function upsertItem(items: ChatItem[], item: ChatItem): ChatItem[] {
  const at = items.findIndex((i) => i.id === item.id && i.kind === item.kind)
  const next =
    at >= 0 ? items.map((i, k) => (k === at ? item : i)) : [...items, item]
  return next.sort((a, b) => a.at - b.at)
}

/** A placeholder assistant item while its text streams in. */
export function streamingItem(id: string, at: number, text: string): ChatItem {
  return {
    kind: 'message',
    id,
    at,
    text,
    role: 'assistant',
    status: 'streaming',
    replyTo: null,
    quote: null,
    actions: [],
    sessionId: null,
    speaker: null,
    label: null,
    speakerName: null,
    originalText: null,
    corrected: false,
  }
}

/** Groups timeline items by the session they belong to (utterances) so the UI can draw a header per call. */
export function sessionHeaderFor(
  items: ChatItem[],
  index: number,
): string | null {
  const it = items[index]
  if (!it || it.kind !== 'utterance' || !it.sessionId) return null
  for (let k = index - 1; k >= 0; k--) {
    const prev = items[k]
    if (prev?.kind === 'utterance')
      return prev.sessionId === it.sessionId ? null : it.sessionId
  }
  return it.sessionId
}

// --- Live call ------------------------------------------------------------------------------------------------------

/** A line of the call as the call socket sends it, before it is stored. */
export interface LiveEntry {
  id: string
  speaker: 'user' | 'agent'
  text: string
  t: number
}

/**
 * Puts the lines of the call in progress into the stored timeline. The stored copy wins (it carries corrections);
 * a line that is not stored yet shows as the turn in progress.
 */
export function mergeLive(
  items: ChatItem[],
  live: ReadonlyArray<LiveEntry>,
  sessionId: string | null,
): ChatItem[] {
  if (live.length === 0) return items
  const stored = new Set(
    items.filter((i) => i.kind === 'utterance').map((i) => i.id),
  )
  const extra: ChatItem[] = live
    .filter((e) => !stored.has(e.id) && e.text.trim() !== '')
    .map((e) => ({
      kind: 'utterance',
      id: e.id,
      at: e.t,
      text: e.text,
      role: null,
      status: null,
      replyTo: null,
      quote: null,
      actions: [],
      sessionId,
      speaker: e.speaker,
      label: null,
      speakerName: null,
      originalText: null,
      corrected: false,
      pending: true,
    }))
  return extra.length === 0
    ? items
    : [...items, ...extra].sort((a, b) => a.at - b.at)
}
