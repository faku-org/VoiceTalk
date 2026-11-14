// Typed view of the Hermes Runs API (ADR 0017). Hermes speaks loose JSON; the client narrows it to these.

/** Run lifecycle as VoiceTalk cares about it. */
export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'

export const TERMINAL_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
])

/** What the user may answer to an approval. VoiceTalk only ever sends `once` and `deny`. */
export type ApprovalChoice = 'once' | 'deny'

/** A step Hermes wants permission for (write, exec, click). `command` is already redacted by Hermes. */
export interface ApprovalRequest {
  /** Prompt id; only present with the canonical session owner. */
  requestId: string | undefined
  executionGeneration: number | undefined
  /** One-line description of what is about to happen. */
  description: string
  /** The flagged command or action, when Hermes sends it. */
  command: string | undefined
}

export type AgentEvent =
  | { type: 'started'; runId: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; preview: string }
  | { type: 'tool_done'; name: string; failed: boolean }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval_settled'; choice: string | undefined }
  | { type: 'completed'; output: string }
  | { type: 'failed'; error: string }
  | { type: 'cancelled' }

export interface AgentCapabilities {
  /** The server advertises the approval route (needed to gate writes). */
  approval: boolean
  /** Runs API available at all. */
  runs: boolean
  raw: Record<string, unknown>
}

export interface AgentHealth {
  ok: boolean
  /** Why it is not ok (unreachable, bad key...). Never contains the key. */
  reason?: string
}

export interface StartRunOptions {
  /** Hermes-side session key; keeps a call's tasks in one conversation. */
  sessionKey?: string
  /** Per-request model override (agent model pref). */
  model?: string
  signal?: AbortSignal
}

export class AgentError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'AgentError'
  }
}
