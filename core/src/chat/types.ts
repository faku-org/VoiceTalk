export type ChatRole = 'user' | 'assistant'
export type MessageStatus = 'complete' | 'interrupted' | 'error'
export type TargetKind = 'message' | 'utterance'

export interface ChatThread {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  forkedFromThread: string | null
  forkedFromMessage: string | null
  /** Call transcripts after this instant are not part of the thread (forks). Null: all of them. */
  cutoffAt: number | null
}

/** What the model did in a turn. Shown to the user next to the answer; never contains internal notes. */
export type ChatAction =
  | {
      type: 'correction'
      utteranceId: string
      original: string
      corrected: string
      reason: string | null
    }
  | {
      type: 'highlight'
      highlightId: string
      targetKind: TargetKind
      targetId: string
      quoted: string
    }
  | { type: 'fork'; threadId: string; title: string }
  | { type: 'resume'; query: string; utteranceIds: string[] }
  /** The model tried an operation that was refused (unknown id, bad range). Shown so nothing fails silently. */
  | { type: 'rejected'; op: string; reason: string }

export interface ChatMessageRow {
  id: string
  threadId: string
  role: ChatRole
  text: string
  createdAt: number
  status: MessageStatus
  replyToKind: TargetKind | null
  replyToId: string | null
  quote: string | null
  actions: ChatAction[]
  copiedFrom: string | null
}

export interface Highlight {
  id: string
  threadId: string
  targetKind: TargetKind
  targetId: string
  start: number
  end: number
  quoted: string
  note: string | null
  createdAt: number
}

export interface Correction {
  id: string
  utteranceId: string
  originalText: string
  correctedText: string
  reason: string | null
  threadId: string | null
  createdAt: number
  revertedAt: number | null
}

/** The message or utterance a message answers, as the model and the UI see it. */
export interface ReplyRef {
  kind: TargetKind
  id: string
  /** Who wrote it: "Usuario", "Asistente" or the speaker name of the utterance. */
  label: string
  text: string
}

export interface TimelineMessage {
  kind: 'message'
  id: string
  threadId: string
  at: number
  role: ChatRole
  text: string
  status: MessageStatus
  replyTo: ReplyRef | null
  quote: string | null
  actions: ChatAction[]
}

export interface TimelineUtterance {
  kind: 'utterance'
  id: string
  sessionId: string
  at: number
  speaker: string
  label: string | null
  speakerName: string | null
  /** Effective text: the active correction when there is one, else what was transcribed. */
  text: string
  /** What was transcribed, only when a correction is active. */
  originalText: string | null
  corrected: boolean
}

export type TimelineItem = TimelineMessage | TimelineUtterance
