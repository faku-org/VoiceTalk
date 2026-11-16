import type { Database } from 'bun:sqlite'
import { fromBlob, toBlob } from '../rag/index.ts'
import type {
  Note,
  NoteKind,
  NoteView,
  Session,
  SessionStatus,
  SpeakerId,
  Summary,
  UtteranceRow,
} from './types.ts'

export interface SessionRepo {
  create(
    session: Pick<Session, 'id' | 'startedAt' | 'location'> & {
      source?: string
    },
  ): void
  get(id: string): Session | null
  /** Newest first. `source` keeps only that session source ('journal', 'call', a platform key). */
  list(limit: number, offset: number, source?: string): Session[]
  end(id: string, endedAt: number, status: SessionStatus): void
  setTitle(id: string, title: string): void
  /** Sessions still marked active (a crash or a forced quit left them open). */
  listActive(): Session[]
  delete(id: string): void
}

export interface UtteranceRepo {
  add(row: UtteranceRow): void
  list(sessionId: string): UtteranceRow[]
  count(sessionId: string): number
}

export interface NewNote {
  sessionId: string | null
  kind: NoteKind
  body: string
  createdAt: number
  location: string
  speakers: SpeakerId[]
  embedding: Float32Array | null
}

export interface NoteRepo {
  add(note: NewNote): Note
  get(id: number): Note | null
  /** Every note of the given kinds, newest first. Internal notes are for the model: never hand them to GraphQL. */
  all(kinds: NoteKind[]): Note[]
  /** External notes only: the single entry point the GraphQL layer uses. */
  listExternal(sessionId: string): NoteView[]
  setEmbedding(id: number, embedding: Float32Array): void
}

export interface SummaryRepo {
  save(summary: Summary): void
  get(sessionId: string): Summary | null
}

interface SessionDbRow {
  id: string
  started_at: number
  ended_at: number | null
  location: string
  title: string | null
  status: SessionStatus
  source: string
}

const toSession = (r: SessionDbRow): Session => ({
  id: r.id,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  location: r.location,
  title: r.title,
  status: r.status,
  source: r.source,
})

export class SqliteSessionRepo implements SessionRepo {
  constructor(private readonly db: Database) {}

  create(
    s: Pick<Session, 'id' | 'startedAt' | 'location'> & { source?: string },
  ): void {
    this.db.run(
      `INSERT INTO sessions (id, started_at, location, status, source) VALUES (?, ?, ?, 'active', ?)
       ON CONFLICT(id) DO NOTHING`,
      [s.id, s.startedAt, s.location, s.source ?? 'call'],
    )
  }

  get(id: string): Session | null {
    const r = this.db
      .query<SessionDbRow, [string]>('SELECT * FROM sessions WHERE id = ?')
      .get(id)
    return r ? toSession(r) : null
  }

  list(limit: number, offset: number, source?: string): Session[] {
    return this.db
      .query<SessionDbRow, [string | null, number, number]>(
        'SELECT * FROM sessions WHERE (?1 IS NULL OR source = ?1) ORDER BY started_at DESC, id LIMIT ?2 OFFSET ?3',
      )
      .all(source ?? null, limit, offset)
      .map(toSession)
  }

  end(id: string, endedAt: number, status: SessionStatus): void {
    this.db.run('UPDATE sessions SET ended_at = ?, status = ? WHERE id = ?', [
      endedAt,
      status,
      id,
    ])
  }

  setTitle(id: string, title: string): void {
    this.db.run('UPDATE sessions SET title = ? WHERE id = ?', [title, id])
  }

  listActive(): Session[] {
    return this.db
      .query<SessionDbRow, []>("SELECT * FROM sessions WHERE status = 'active'")
      .all()
      .map(toSession)
  }

  delete(id: string): void {
    this.db.run('DELETE FROM sessions WHERE id = ?', [id])
  }
}

interface UtteranceDbRow {
  id: string
  session_id: string
  speaker: SpeakerId
  label: string | null
  t_start: number
  t_end: number
  text: string
  source: 'stt' | 'agent' | 'capture'
  speaker_name: string | null
}

export class SqliteUtteranceRepo implements UtteranceRepo {
  constructor(private readonly db: Database) {}

  add(u: UtteranceRow): void {
    this.db.run(
      `INSERT INTO utterances (id, session_id, speaker, label, t_start, t_end, text, source, speaker_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET text = excluded.text, t_end = excluded.t_end`,
      [
        u.id,
        u.sessionId,
        u.speaker,
        u.label ?? null,
        u.tStart,
        u.tEnd,
        u.text,
        u.source,
        u.speakerName ?? null,
      ],
    )
  }

  list(sessionId: string): UtteranceRow[] {
    return this.db
      .query<UtteranceDbRow, [string]>(
        'SELECT * FROM utterances WHERE session_id = ? ORDER BY t_start, rowid',
      )
      .all(sessionId)
      .map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        speaker: r.speaker,
        label: r.label,
        tStart: r.t_start,
        tEnd: r.t_end,
        text: r.text,
        source: r.source,
        speakerName: r.speaker_name,
      }))
  }

  count(sessionId: string): number {
    return (
      this.db
        .query<{ n: number }, [string]>(
          'SELECT COUNT(*) AS n FROM utterances WHERE session_id = ?',
        )
        .get(sessionId)?.n ?? 0
    )
  }
}

interface NoteDbRow {
  id: number
  session_id: string | null
  kind: NoteKind
  body: string
  created_at: number
  location: string
  speakers: string
  embedding: Uint8Array | null
}

function parseJsonList(json: string): unknown[] {
  try {
    const v: unknown = JSON.parse(json)
    if (Array.isArray(v)) return v
  } catch {
    // fall through
  }
  return []
}

const toNote = (r: NoteDbRow): Note => ({
  id: r.id,
  sessionId: r.session_id,
  kind: r.kind,
  body: r.body,
  createdAt: r.created_at,
  location: r.location,
  speakers: parseJsonList(r.speakers).filter(
    (s): s is SpeakerId => s === 'user' || s === 'agent' || s === 'remote',
  ),
  embedding: r.embedding ? fromBlob(r.embedding) : null,
})

export class SqliteNoteRepo implements NoteRepo {
  constructor(private readonly db: Database) {}

  add(n: NewNote): Note {
    const res = this.db.run(
      `INSERT INTO notes (session_id, kind, body, created_at, location, speakers, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        n.sessionId,
        n.kind,
        n.body,
        n.createdAt,
        n.location,
        JSON.stringify(n.speakers),
        n.embedding ? toBlob(n.embedding) : null,
      ],
    )
    return { ...n, id: Number(res.lastInsertRowid) }
  }

  get(id: number): Note | null {
    const r = this.db
      .query<NoteDbRow, [number]>('SELECT * FROM notes WHERE id = ?')
      .get(id)
    return r ? toNote(r) : null
  }

  all(kinds: NoteKind[]): Note[] {
    if (kinds.length === 0) return []
    const marks = kinds.map(() => '?').join(', ')
    return this.db
      .query<NoteDbRow, NoteKind[]>(
        `SELECT * FROM notes WHERE kind IN (${marks}) ORDER BY created_at DESC, id DESC`,
      )
      .all(...kinds)
      .map(toNote)
  }

  listExternal(sessionId: string): NoteView[] {
    return this.db
      .query<NoteDbRow, [string]>(
        "SELECT * FROM notes WHERE session_id = ? AND kind = 'external' ORDER BY created_at, id",
      )
      .all(sessionId)
      .map((r) => {
        const { embedding: _embedding, ...view } = toNote(r)
        return view
      })
  }

  setEmbedding(id: number, embedding: Float32Array): void {
    this.db.run('UPDATE notes SET embedding = ? WHERE id = ?', [
      toBlob(embedding),
      id,
    ])
  }
}

interface SummaryDbRow {
  session_id: string
  summary: string
  open_questions: string
  raised: string
}

const strings = (json: string): string[] =>
  parseJsonList(json).filter((s): s is string => typeof s === 'string')

export class SqliteSummaryRepo implements SummaryRepo {
  constructor(private readonly db: Database) {}

  save(s: Summary): void {
    this.db.run(
      `INSERT INTO summaries (session_id, summary, open_questions, raised) VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET summary = excluded.summary,
         open_questions = excluded.open_questions, raised = excluded.raised`,
      [
        s.sessionId,
        s.summary,
        JSON.stringify(s.openQuestions),
        JSON.stringify(s.raised),
      ],
    )
  }

  get(sessionId: string): Summary | null {
    const r = this.db
      .query<SummaryDbRow, [string]>(
        'SELECT * FROM summaries WHERE session_id = ?',
      )
      .get(sessionId)
    return r
      ? {
          sessionId: r.session_id,
          summary: r.summary,
          openQuestions: strings(r.open_questions),
          raised: strings(r.raised),
        }
      : null
  }
}
