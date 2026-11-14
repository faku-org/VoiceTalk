import type { Database } from 'bun:sqlite'
import type { ChatProvider } from '../llm/index.ts'
import type { NotesService } from '../notes/index.ts'
import {
  SqliteCorrectionRepo,
  SqliteHighlightRepo,
  SqliteMessageRepo,
  SqliteThreadRepo,
  SqliteTranscriptRepo,
} from './repo.ts'
import { ChatService } from './service.ts'

export * from './context.ts'
export * from './ops.ts'
export * from './repo.ts'
export * from './service.ts'
export * from './types.ts'

/** Chat tab services: threads and messages, the transcript overlay (corrections) and the turn runner. */
export function createChatService(deps: {
  db: Database
  notes: NotesService
  llm: ChatProvider | null
}): ChatService {
  return new ChatService({
    db: deps.db,
    threads: new SqliteThreadRepo(deps.db),
    messages: new SqliteMessageRepo(deps.db),
    highlights: new SqliteHighlightRepo(deps.db),
    corrections: new SqliteCorrectionRepo(deps.db),
    transcripts: new SqliteTranscriptRepo(deps.db),
    sessions: deps.notes.sessions,
    search: deps.notes.search,
    llm: deps.llm,
  })
}
