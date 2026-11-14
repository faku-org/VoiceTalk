import type { Database } from 'bun:sqlite'
import type { UtteranceRow } from '../notes/types.ts'
import type {
  ChatAction,
  ChatMessageRow,
  ChatThread,
  Correction,
  Highlight,
  MessageStatus,
  TargetKind,
} from './types.ts'

export interface ThreadRepo {
  create(thread: ChatThread): void
  get(id: string): ChatThread | null
  /** The thread that is not a fork (oldest first). */
  root(): ChatThread | null
  list(): ChatThread[]
  touch(id: string, at: number): void
  setTitle(id: string, title: string): void
}

export interface MessageRepo {
  add(row: ChatMessageRow): void
  get(id: string): ChatMessageRow | null
  /** Oldest first. */
  list(threadId: string): ChatMessageRow[]
  /** Final text, status and actions of a message that was streaming. */
  finish(
    id: string,
    patch: { text: string; status: MessageStatus; actions: ChatAction[] },
  ): void
}

export interface HighlightRepo {
  add(h: Highlight): void
  list(threadId: string): Highlight[]
}

export interface CorrectionRepo {
  add(c: Correction): void
  /** The correction in force for an utterance: the latest one that was not reverted. */
  active(utteranceId: string): Correction | null
  /** Active corrections of many utterances, keyed by utterance id. */
  activeFor(utteranceIds: string[]): Map<string, Correction>
  history(utteranceId: string): Correction[]
  /** Marks the active correction reverted; the original text is shown again. False when there was none. */
  revert(utteranceId: string, at: number): boolean
}

interface ThreadDbRow {
  id: string
  title: string
  created_at: number
  updated_at: number
  forked_from_thread: string | null
  forked_from_message: string | null
  cutoff_at: number | null
}

const toThread = (r: ThreadDbRow): ChatThread => ({
  id: r.id,
  title: r.title,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  forkedFromThread: r.forked_from_thread,
  forkedFromMessage: r.forked_from_message,
  cutoffAt: r.cutoff_at,
})

export class SqliteThreadRepo implements ThreadRepo {
  constructor(private readonly db: Database) {}

  create(t: ChatThread): void {
    this.db.run(
      `INSERT INTO chat_threads (id, title, created_at, updated_at, forked_from_thread, forked_from_message, cutoff_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        t.id,
        t.title,
        t.createdAt,
        t.updatedAt,
        t.forkedFromThread,
        t.forkedFromMessage,
        t.cutoffAt,
      ],
    )
  }

  get(id: string): ChatThread | null {
    const r = this.db
      .query<ThreadDbRow, [string]>('SELECT * FROM chat_threads WHERE id = ?')
      .get(id)
    return r ? toThread(r) : null
  }

  root(): ChatThread | null {
    const r = this.db
      .query<ThreadDbRow, []>(
        'SELECT * FROM chat_threads WHERE forked_from_thread IS NULL AND forked_from_message IS NULL ORDER BY created_at, id LIMIT 1',
      )
      .get()
    return r ? toThread(r) : null
  }

  list(): ChatThread[] {
    return this.db
      .query<ThreadDbRow, []>(
        'SELECT * FROM chat_threads ORDER BY updated_at DESC, id',
      )
      .all()
      .map(toThread)
  }

  touch(id: string, at: number): void {
    this.db.run('UPDATE chat_threads SET updated_at = ? WHERE id = ?', [at, id])
  }

  setTitle(id: string, title: string): void {
    this.db.run('UPDATE chat_threads SET title = ? WHERE id = ?', [title, id])
  }
}

interface MessageDbRow {
  id: string
  thread_id: string
  role: 'user' | 'assistant'
  text: string
  created_at: number
  status: MessageStatus
  reply_to_kind: TargetKind | null
  reply_to_id: string | null
  quote: string | null
  actions: string
  copied_from: string | null
}

function parseActions(json: string): ChatAction[] {
  try {
    const v: unknown = JSON.parse(json)
    if (Array.isArray(v)) return v as ChatAction[]
  } catch {
    // fall through
  }
  return []
}

const toMessage = (r: MessageDbRow): ChatMessageRow => ({
  id: r.id,
  threadId: r.thread_id,
  role: r.role,
  text: r.text,
  createdAt: r.created_at,
  status: r.status,
  replyToKind: r.reply_to_kind,
  replyToId: r.reply_to_id,
  quote: r.quote,
  actions: parseActions(r.actions),
  copiedFrom: r.copied_from,
})

export class SqliteMessageRepo implements MessageRepo {
  constructor(private readonly db: Database) {}

  add(m: ChatMessageRow): void {
    this.db.run(
      `INSERT INTO chat_messages (id, thread_id, role, text, created_at, status, reply_to_kind, reply_to_id, quote, actions, copied_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        m.id,
        m.threadId,
        m.role,
        m.text,
        m.createdAt,
        m.status,
        m.replyToKind,
        m.replyToId,
        m.quote,
        JSON.stringify(m.actions),
        m.copiedFrom,
      ],
    )
  }

  get(id: string): ChatMessageRow | null {
    const r = this.db
      .query<MessageDbRow, [string]>('SELECT * FROM chat_messages WHERE id = ?')
      .get(id)
    return r ? toMessage(r) : null
  }

  list(threadId: string): ChatMessageRow[] {
    return this.db
      .query<MessageDbRow, [string]>(
        'SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at, rowid',
      )
      .all(threadId)
      .map(toMessage)
  }

  finish(
    id: string,
    patch: { text: string; status: MessageStatus; actions: ChatAction[] },
  ): void {
    this.db.run(
      'UPDATE chat_messages SET text = ?, status = ?, actions = ? WHERE id = ?',
      [patch.text, patch.status, JSON.stringify(patch.actions), id],
    )
  }
}

interface HighlightDbRow {
  id: string
  thread_id: string
  target_kind: TargetKind
  target_id: string
  start_offset: number
  end_offset: number
  quoted: string
  note: string | null
  created_at: number
}

export class SqliteHighlightRepo implements HighlightRepo {
  constructor(private readonly db: Database) {}

  add(h: Highlight): void {
    this.db.run(
      `INSERT INTO chat_highlights (id, thread_id, target_kind, target_id, start_offset, end_offset, quoted, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        h.id,
        h.threadId,
        h.targetKind,
        h.targetId,
        h.start,
        h.end,
        h.quoted,
        h.note,
        h.createdAt,
      ],
    )
  }

  list(threadId: string): Highlight[] {
    return this.db
      .query<HighlightDbRow, [string]>(
        'SELECT * FROM chat_highlights WHERE thread_id = ? ORDER BY created_at, rowid',
      )
      .all(threadId)
      .map((r) => ({
        id: r.id,
        threadId: r.thread_id,
        targetKind: r.target_kind,
        targetId: r.target_id,
        start: r.start_offset,
        end: r.end_offset,
        quoted: r.quoted,
        note: r.note,
        createdAt: r.created_at,
      }))
  }
}

interface CorrectionDbRow {
  id: string
  utterance_id: string
  original_text: string
  corrected_text: string
  reason: string | null
  thread_id: string | null
  created_at: number
  reverted_at: number | null
}

const toCorrection = (r: CorrectionDbRow): Correction => ({
  id: r.id,
  utteranceId: r.utterance_id,
  originalText: r.original_text,
  correctedText: r.corrected_text,
  reason: r.reason,
  threadId: r.thread_id,
  createdAt: r.created_at,
  revertedAt: r.reverted_at,
})

export class SqliteCorrectionRepo implements CorrectionRepo {
  constructor(private readonly db: Database) {}

  add(c: Correction): void {
    this.db.run(
      `INSERT INTO utterance_corrections (id, utterance_id, original_text, corrected_text, reason, thread_id, created_at, reverted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        c.id,
        c.utteranceId,
        c.originalText,
        c.correctedText,
        c.reason,
        c.threadId,
        c.createdAt,
        c.revertedAt,
      ],
    )
  }

  active(utteranceId: string): Correction | null {
    const r = this.db
      .query<CorrectionDbRow, [string]>(
        `SELECT * FROM utterance_corrections WHERE utterance_id = ? AND reverted_at IS NULL
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(utteranceId)
    return r ? toCorrection(r) : null
  }

  activeFor(utteranceIds: string[]): Map<string, Correction> {
    const out = new Map<string, Correction>()
    // SQLite caps bound variables; chunk well below it.
    for (let i = 0; i < utteranceIds.length; i += 500) {
      const ids = utteranceIds.slice(i, i + 500)
      if (ids.length === 0) continue
      const marks = ids.map(() => '?').join(', ')
      const rows = this.db
        .query<CorrectionDbRow, string[]>(
          `SELECT * FROM utterance_corrections WHERE reverted_at IS NULL AND utterance_id IN (${marks})
           ORDER BY created_at, rowid`,
        )
        .all(...ids)
      // Ascending order: the latest correction of each utterance overwrites the earlier ones.
      for (const r of rows) out.set(r.utterance_id, toCorrection(r))
    }
    return out
  }

  history(utteranceId: string): Correction[] {
    return this.db
      .query<CorrectionDbRow, [string]>(
        'SELECT * FROM utterance_corrections WHERE utterance_id = ? ORDER BY created_at, rowid',
      )
      .all(utteranceId)
      .map(toCorrection)
  }

  revert(utteranceId: string, at: number): boolean {
    const active = this.active(utteranceId)
    if (!active) return false
    this.db.run(
      'UPDATE utterance_corrections SET reverted_at = ? WHERE id = ?',
      [at, active.id],
    )
    return true
  }
}

/** Read-only view over call transcripts (the `utterances` table owned by notes). Raw text: corrections are overlaid by the service. */
export interface TranscriptRepo {
  get(id: string): UtteranceRow | null
  /** Utterances of the most recent sessions, oldest first. `until` drops anything that started after it (forks). */
  recent(opts: { sessions: number; until: number | null }): UtteranceRow[]
  /** Utterances whose text contains any of the terms, newest first. */
  find(terms: string[], limit: number, until: number | null): UtteranceRow[]
}

interface UtteranceDbRow {
  id: string
  session_id: string
  speaker: UtteranceRow['speaker']
  label: string | null
  speaker_name: string | null
  t_start: number
  t_end: number
  text: string
  source: UtteranceRow['source']
}

const toUtterance = (r: UtteranceDbRow): UtteranceRow => ({
  id: r.id,
  sessionId: r.session_id,
  speaker: r.speaker,
  label: r.label,
  speakerName: r.speaker_name,
  tStart: r.t_start,
  tEnd: r.t_end,
  text: r.text,
  source: r.source,
})

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`)

export class SqliteTranscriptRepo implements TranscriptRepo {
  constructor(private readonly db: Database) {}

  get(id: string): UtteranceRow | null {
    const r = this.db
      .query<UtteranceDbRow, [string]>('SELECT * FROM utterances WHERE id = ?')
      .get(id)
    return r ? toUtterance(r) : null
  }

  recent(opts: { sessions: number; until: number | null }): UtteranceRow[] {
    const until = opts.until ?? Number.MAX_SAFE_INTEGER
    return this.db
      .query<UtteranceDbRow, [number, number]>(
        `SELECT u.* FROM utterances u
         WHERE u.t_start <= ?2 AND u.session_id IN (
           SELECT id FROM sessions WHERE started_at <= ?2 ORDER BY started_at DESC LIMIT ?1
         )
         ORDER BY u.t_start, u.rowid`,
      )
      .all(opts.sessions, until)
      .map(toUtterance)
  }

  find(terms: string[], limit: number, until: number | null): UtteranceRow[] {
    const clean = terms.map((t) => t.trim()).filter((t) => t.length >= 3)
    if (clean.length === 0) return []
    const likes = clean.map(() => "u.text LIKE ? ESCAPE '\\'").join(' OR ')
    const params = [
      ...clean.map((t) => `%${escapeLike(t)}%`),
      until ?? Number.MAX_SAFE_INTEGER,
      limit,
    ]
    return this.db
      .query<UtteranceDbRow, (string | number)[]>(
        `SELECT u.* FROM utterances u WHERE (${likes}) AND u.t_start <= ? ORDER BY u.t_start DESC LIMIT ?`,
      )
      .all(...params)
      .map(toUtterance)
  }
}
