export type SessionStatus = 'active' | 'ended' | 'interrupted'
export type NoteKind = 'internal' | 'external'
export type SpeakerId = 'user' | 'agent'

export interface Session {
  id: string
  startedAt: number
  endedAt: number | null
  location: string
  title: string | null
  status: SessionStatus
}

export interface UtteranceRow {
  id: string
  sessionId: string
  speaker: SpeakerId
  tStart: number
  tEnd: number
  text: string
  source: 'stt' | 'agent'
}

export interface Note {
  id: number
  sessionId: string | null
  kind: NoteKind
  body: string
  createdAt: number
  location: string
  speakers: SpeakerId[]
  /** Null when the embedder was down at write time. */
  embedding: Float32Array | null
}

export interface Summary {
  sessionId: string
  summary: string
  openQuestions: string[]
  raised: string[]
}

/** A note without its vector: what search and the UI-facing layers see. */
export type NoteView = Omit<Note, 'embedding'>
