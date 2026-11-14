import type { CallEvents, TranscriptEntry } from '../call/events.ts'
import type { ChatProvider } from '../llm/index.ts'
import type { Embedder } from '../rag/index.ts'
import { CALL_SOURCE } from '../capture/platforms.ts'
import { decide, type Line } from './decision.ts'
import type {
  NoteRepo,
  SessionRepo,
  SummaryRepo,
  UtteranceRepo,
} from './repo.ts'
import type { NoteHit, NoteSearch } from './search.ts'
import { externalNoteBody, sessionTitle, summarize } from './summary.ts'
import type { SpeakerId } from './types.ts'

/** What the recorder reads from preferences. Injected so tests and the core without P5 use defaults. */
export interface RecorderPrefs {
  /** Minimum `confidence` of a decision before it is acted on (prefs.thresholds.respondConfidence). */
  threshold: number
  /** Free-text location (prefs.location.manual). */
  location: string
}

export const DEFAULT_RECORDER_PREFS: RecorderPrefs = {
  threshold: 0.6,
  location: '',
}

export const DECISION_INTERVAL_MS = 30_000
/** The decision prompt sees at most this much new transcript per tick. */
const MAX_WINDOW_CHARS = 3000
const RECALL_K = 3
const RECALL_MIN_SCORE = 0.3

export interface RecorderDeps {
  events: CallEvents
  sessions: SessionRepo
  utterances: UtteranceRepo
  notes: NoteRepo
  summaries: SummaryRepo
  search: NoteSearch
  embedder: Embedder
  /** Local LLM. Null disables the decision model and falls back to plain summaries. */
  llm: ChatProvider | null
  prefs?: () => RecorderPrefs
  intervalMs?: number
  /** Receives what a `recall` decision found. The call loop can inject it into the next turn. */
  onRecall?: (callId: string, query: string, hits: NoteHit[]) => void
  now?: () => number
  log?: (message: string, err?: unknown) => void
}

interface ActiveCall {
  id: string
  startedAt: number
  location: string
  /** 'call' or the platform key of a captured call. */
  source: string
  /** Transcript kept in memory for the model; the database copy is the durable one. */
  lines: Line[]
  /** First line the decision model has not seen yet. */
  cursor: number
  timer: ReturnType<typeof setInterval>
  ticking: Promise<void> | null
  written: Set<string>
}

const key = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Persists calls from the P2 event stream and runs the decision model every ~30 s of transcript. Everything
 * heavy (LLM, embeddings, summary) happens off the call path: listeners only do one small SQLite write.
 */
export class NotesRecorder {
  readonly #d: RecorderDeps
  readonly #calls = new Map<string, ActiveCall>()
  readonly #pending = new Set<Promise<unknown>>()
  #off: Array<() => void> = []

  constructor(deps: RecorderDeps) {
    this.#d = deps
  }

  get #prefs(): RecorderPrefs {
    try {
      return this.#d.prefs?.() ?? DEFAULT_RECORDER_PREFS
    } catch {
      return DEFAULT_RECORDER_PREFS
    }
  }

  #log(message: string, err?: unknown): void {
    if (this.#d.log) this.#d.log(message, err)
    else
      console.warn(`notes: ${message}`, err instanceof Error ? err.message : '')
  }

  #now(): number {
    return (this.#d.now ?? Date.now)()
  }

  /** Subscribes to the call events. Sessions left `active` by a crash are closed as `interrupted`. */
  start(): void {
    if (this.#off.length) return
    this.recoverInterrupted()
    const e = this.#d.events
    this.#off = [
      e.on('callStarted', (p) => this.#onStarted(p.callId, p.t, p.source)),
      e.on('utteranceAdded', (p) => this.#onUtterance(p.callId, p.entry)),
      e.on('callEnded', (p) => this.#onEnded(p.callId, p.t, p.reason)),
    ]
  }

  /** Unsubscribes and waits for in-flight work (summaries) so shutdown loses nothing. */
  async stop(): Promise<void> {
    for (const off of this.#off) off()
    this.#off = []
    for (const call of this.#calls.values()) clearInterval(call.timer)
    await this.idle()
  }

  /** Resolves when every background task (decision tick, call-end summary) has settled. */
  async idle(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending])
  }

  recoverInterrupted(): void {
    for (const s of this.#d.sessions.listActive()) {
      if (this.#calls.has(s.id)) continue
      if (this.#d.utterances.count(s.id) === 0) this.#d.sessions.delete(s.id)
      else this.#d.sessions.end(s.id, s.startedAt, 'interrupted')
    }
  }

  #track<T>(p: Promise<T>): Promise<T> {
    this.#pending.add(p)
    const done = () => this.#pending.delete(p)
    p.then(done, done)
    return p
  }

  #onStarted(callId: string, t: number, source: string = CALL_SOURCE): void {
    try {
      const location = this.#prefs.location
      this.#d.sessions.create({ id: callId, startedAt: t, location, source })
      const call: ActiveCall = {
        id: callId,
        startedAt: t,
        location,
        source,
        lines: [],
        cursor: 0,
        ticking: null,
        written: new Set(),
        timer: setInterval(
          () => void this.#tick(call),
          this.#d.intervalMs ?? DECISION_INTERVAL_MS,
        ),
      }
      call.timer.unref?.()
      this.#calls.set(callId, call)
    } catch (err) {
      this.#log('could not open the session', err)
    }
  }

  #onUtterance(callId: string, entry: TranscriptEntry): void {
    const call = this.#calls.get(callId)
    if (!call) return
    const text = entry.text.trim()
    if (!text) return
    try {
      this.#d.utterances.add({
        id: entry.id,
        sessionId: callId,
        speaker: entry.speaker,
        label: entry.speaker === 'remote' ? (entry.label ?? null) : null,
        tStart: entry.t,
        tEnd: entry.tEnd ?? this.#now(),
        text,
        source:
          entry.speaker === 'agent'
            ? 'agent'
            : entry.speaker === 'remote'
              ? 'capture'
              : 'stt',
      })
      call.lines.push({
        speaker: entry.speaker,
        text,
        label: entry.label ?? null,
      })
    } catch (err) {
      this.#log('could not store an utterance', err)
    }
  }

  #onEnded(callId: string, t: number, reason: string): void {
    const call = this.#calls.get(callId)
    if (!call) return
    clearInterval(call.timer)
    this.#calls.delete(callId)
    void this.#track(this.#finish(call, t, reason))
  }

  async #finish(call: ActiveCall, t: number, reason: string): Promise<void> {
    try {
      await call.ticking
      const clean = reason === 'client'
      const { sessions, utterances } = this.#d
      if (call.lines.length === 0) {
        sessions.delete(call.id)
        return
      }
      sessions.end(call.id, t, clean ? 'ended' : 'interrupted')
      // A forced quit must finish fast: no model calls, only the plain summary.
      const online = reason !== 'shutdown'
      if (online) await this.#decide(call)
      const lines = utterances.list(call.id).map((u) => ({
        speaker: u.speaker,
        text: u.text,
        label: u.label,
      }))
      const draft = await summarize(
        online ? this.#d.llm : null,
        lines,
        call.source,
      )
      this.#d.summaries.save({ sessionId: call.id, ...draft })
      this.#d.sessions.setTitle(call.id, sessionTitle(lines, call.startedAt))
      const speakers: SpeakerId[] = (
        ['user', 'agent', 'remote'] as const
      ).filter((s) => lines.some((l) => l.speaker === s))
      await this.#addNote({
        sessionId: call.id,
        kind: 'external',
        body: externalNoteBody({
          draft,
          startedAt: call.startedAt,
          location: call.location,
          speakers,
          source: call.source,
        }),
        location: call.location,
        speakers,
      })
    } catch (err) {
      this.#log('could not close the session', err)
    }
  }

  #tick(call: ActiveCall): Promise<void> {
    if (call.ticking) return call.ticking
    const run = this.#decide(call).finally(() => {
      call.ticking = null
    })
    call.ticking = run
    return this.#track(run)
  }

  /** One decision over the transcript since the last one. Errors are logged, never thrown. */
  async #decide(call: ActiveCall): Promise<void> {
    const llm = this.#d.llm
    // Captured calls (ADR 0009) feed no private memory: other people's words never become internal notes.
    if (call.source !== CALL_SOURCE) return
    const fresh = call.lines.slice(call.cursor)
    if (!llm || !fresh.some((l) => l.speaker === 'user')) return
    call.cursor = call.lines.length
    let window = fresh
    while (
      window.length > 1 &&
      window.reduce((n, l) => n + l.text.length, 0) > MAX_WINDOW_CHARS
    )
      window = window.slice(1)
    try {
      const decision = await decide(llm, window)
      if (!decision || decision.action === 'none') return
      if ((decision.confidence ?? 1) < this.#prefs.threshold) return
      if (decision.action === 'internal_note') {
        const body = decision.note ?? ''
        if (call.written.has(key(body))) return
        call.written.add(key(body))
        await this.#addNote({
          sessionId: call.id,
          kind: 'internal',
          body,
          location: call.location,
          speakers: ['user'],
        })
      } else {
        const query = decision.query ?? ''
        const hits = await this.#d.search.search(query, RECALL_K, {
          excludeSession: call.id,
          minScore: RECALL_MIN_SCORE,
        })
        if (hits.length) this.#d.onRecall?.(call.id, query, hits)
      }
    } catch (err) {
      this.#log('decision tick failed', err)
    }
  }

  /** Writes a note with its embedding; a down embedder leaves the vector empty (search falls back to words). */
  async #addNote(n: {
    sessionId: string
    kind: 'internal' | 'external'
    body: string
    location: string
    speakers: SpeakerId[]
  }): Promise<void> {
    let embedding: Float32Array | null = null
    try {
      const [v] = await this.#d.embedder.embedDocuments([
        {
          heading: n.kind === 'internal' ? 'nota' : 'conversación',
          text: n.body,
        },
      ])
      embedding = v ?? null
    } catch {
      embedding = null
    }
    const note = this.#d.notes.add({
      ...n,
      createdAt: this.#now(),
      embedding,
    })
    this.#d.search.index(note)
  }
}
