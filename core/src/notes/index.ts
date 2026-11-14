import type { Database } from 'bun:sqlite'
import type { CallEvents } from '../call/events.ts'
import { callEvents } from '../call/events.ts'
import type { ChatProvider } from '../llm/index.ts'
import type { Embedder } from '../rag/index.ts'
import { NotesRecorder, type RecorderPrefs } from './recorder.ts'
import {
  SqliteNoteRepo,
  SqliteSessionRepo,
  SqliteSummaryRepo,
  SqliteUtteranceRepo,
  type NoteRepo,
  type SessionRepo,
  type SummaryRepo,
  type UtteranceRepo,
} from './repo.ts'
import { createNoteSearch, type NoteSearch } from './search.ts'

export * from './decision.ts'
export * from './recorder.ts'
export * from './repo.ts'
export * from './search.ts'
export * from './summary.ts'
export * from './types.ts'

/** Phase 3 services: repos, note search and the recorder that feeds them from the call events. */
export interface NotesService {
  sessions: SessionRepo
  utterances: UtteranceRepo
  notes: NoteRepo
  summaries: SummaryRepo
  search: NoteSearch
  recorder: NotesRecorder
}

export function createNotesService(deps: {
  db: Database
  embedder: Embedder
  llm: ChatProvider | null
  events?: CallEvents
  prefs?: () => RecorderPrefs
  intervalMs?: number
}): NotesService {
  const sessions = new SqliteSessionRepo(deps.db)
  const utterances = new SqliteUtteranceRepo(deps.db)
  const notes = new SqliteNoteRepo(deps.db)
  const summaries = new SqliteSummaryRepo(deps.db)
  const search = createNoteSearch({ notes, embedder: deps.embedder })
  const recorder = new NotesRecorder({
    events: deps.events ?? callEvents,
    sessions,
    utterances,
    notes,
    summaries,
    search,
    embedder: deps.embedder,
    llm: deps.llm,
    prefs: deps.prefs,
    intervalMs: deps.intervalMs,
  })
  return { sessions, utterances, notes, summaries, search, recorder }
}
