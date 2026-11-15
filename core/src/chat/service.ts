import type { Database } from 'bun:sqlite'
import {
  isAbortError,
  type ChatMessage,
  type ChatProvider,
} from '../llm/index.ts'
import type { NoteSearch } from '../notes/search.ts'
import type { SessionRepo } from '../notes/repo.ts'
import type { Session, UtteranceRow } from '../notes/types.ts'
import {
  buildContext,
  RESUME_PROMPT,
  speakerName,
  type RefTarget,
} from './context.ts'
import {
  OpStripper,
  parseOps,
  searchTerms,
  type ModelOp,
  type RejectedOp,
} from './ops.ts'
import type {
  CorrectionRepo,
  HighlightRepo,
  MessageRepo,
  ThreadRepo,
  TranscriptRepo,
} from './repo.ts'
import type {
  ChatAction,
  ChatMessageRow,
  ChatThread,
  Correction,
  Highlight,
  ReplyRef,
  TargetKind,
  TimelineItem,
  TimelineMessage,
  TimelineUtterance,
} from './types.ts'

/** Sessions whose transcripts appear in the main thread. */
export const ROOT_SESSIONS = 10
export const CHAT_MAX_TOKENS = 800
const MAX_TEXT = 8000
const MAX_QUOTE = 2000
const RESUME_HITS = 8
const RECALL_HITS = 3
const RECALL_MIN_SCORE = 0.45

export type ChatErrorCode = 'not_found' | 'invalid' | 'busy' | 'unavailable'

/** A refusal the caller can show: the message is already in neutral Spanish and never carries internals. */
export class ChatError extends Error {
  constructor(
    readonly code: ChatErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ChatError'
  }
}

export interface SessionInfo {
  id: string
  title: string | null
  startedAt: number
  endedAt: number | null
  source: string
}

export interface Timeline {
  thread: ChatThread
  items: TimelineItem[]
  sessions: SessionInfo[]
  highlights: Highlight[]
  busy: boolean
}

export interface SendInput {
  text: string
  replyTo?: { kind: TargetKind; id: string } | null
  quote?: string | null
}

export type ChatEvent =
  | { type: 'user'; message: TimelineMessage }
  | { type: 'delta'; text: string }
  | { type: 'action'; action: ChatAction }
  | { type: 'done'; message: TimelineMessage }
  | { type: 'error'; message: string }

/** A started turn: the user message is stored; `run` streams the answer. */
export interface Turn {
  user: TimelineMessage
  run(signal?: AbortSignal): AsyncGenerator<ChatEvent, void>
  /** Frees the thread when `run` will not be called. Running a turn frees it by itself. */
  release(): void
}

export interface ChatServiceDeps {
  db: Database
  threads: ThreadRepo
  messages: MessageRepo
  highlights: HighlightRepo
  corrections: CorrectionRepo
  transcripts: TranscriptRepo
  sessions: SessionRepo
  search: NoteSearch
  llm: ChatProvider | null
  now?: () => number
  id?: () => string
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

export class ChatService {
  private readonly busy = new Set<string>()
  private readonly now: () => number
  private readonly newId: () => string

  constructor(private readonly d: ChatServiceDeps) {
    this.now = d.now ?? Date.now
    this.newId = d.id ?? (() => crypto.randomUUID())
  }

  // ---- threads ----

  /** The single root thread, created on first use. */
  mainThread(): ChatThread {
    const root = this.d.threads.root()
    if (root) return root
    const at = this.now()
    const thread: ChatThread = {
      id: this.newId(),
      title: 'Conversación',
      createdAt: at,
      updatedAt: at,
      forkedFromThread: null,
      forkedFromMessage: null,
      sessionId: null,
      cutoffAt: null,
    }
    this.d.threads.create(thread)
    return thread
  }

  /** The thread of one conversation, created on first use. */
  sessionThread(sessionId: string): ChatThread {
    const found = this.d.threads.forSession(sessionId)
    if (found) return found
    const session = this.d.sessions.get(sessionId)
    if (!session)
      throw new ChatError('not_found', 'Esa conversación ya no existe.')
    const at = this.now()
    const thread: ChatThread = {
      id: this.newId(),
      title: session.title?.trim() || 'Conversación',
      createdAt: at,
      updatedAt: at,
      forkedFromThread: null,
      forkedFromMessage: null,
      sessionId,
      cutoffAt: null,
    }
    this.d.threads.create(thread)
    return thread
  }

  /** The thread of the conversation in progress (the newest one still open), or null when none is. */
  liveThread(): ChatThread | null {
    const open = this.d.sessions
      .listActive()
      .sort((a, b) => b.startedAt - a.startedAt)[0]
    return open ? this.sessionThread(open.id) : null
  }

  listThreads(): ChatThread[] {
    this.mainThread()
    return this.d.threads.list()
  }

  isBusy(threadId: string): boolean {
    return this.busy.has(threadId)
  }

  private thread(id: string): ChatThread {
    const t = this.d.threads.get(id)
    if (!t) throw new ChatError('not_found', 'No existe esa conversación.')
    return t
  }

  // ---- timeline ----

  private utteranceItem(
    u: UtteranceRow,
    fix: Correction | undefined,
  ): TimelineUtterance {
    return {
      kind: 'utterance',
      id: u.id,
      sessionId: u.sessionId,
      at: u.tStart,
      speaker: u.speaker,
      label: u.label ?? null,
      speakerName: u.speakerName ?? null,
      text: fix ? fix.correctedText : u.text,
      originalText: fix ? u.text : null,
      corrected: !!fix,
    }
  }

  /** Transcript text as shown: the active correction wins over what was transcribed. */
  private effectiveUtterance(id: string): TimelineUtterance | null {
    const u = this.d.transcripts.get(id)
    if (!u) return null
    return this.utteranceItem(u, this.d.corrections.active(id) ?? undefined)
  }

  private replyRef(kind: TargetKind, id: string): ReplyRef | null {
    if (kind === 'message') {
      const m = this.d.messages.get(id)
      if (!m) return null
      return {
        kind,
        id,
        label: m.role === 'user' ? 'Usuario' : 'Asistente',
        text: m.text,
      }
    }
    const u = this.effectiveUtterance(id)
    return u ? { kind, id, label: speakerName(u), text: u.text } : null
  }

  private messageItem(m: ChatMessageRow): TimelineMessage {
    return {
      kind: 'message',
      id: m.id,
      threadId: m.threadId,
      at: m.createdAt,
      role: m.role,
      text: m.text,
      status: m.status,
      replyTo:
        m.replyToKind && m.replyToId
          ? this.replyRef(m.replyToKind, m.replyToId)
          : null,
      quote: m.quote,
      actions: m.actions,
    }
  }

  /** Chat messages and call transcripts of the thread, oldest first. */
  private items(thread: ChatThread, limit: number): TimelineItem[] {
    const messages = this.d.messages
      .list(thread.id)
      .map((m) => this.messageItem(m))
    const raw = thread.sessionId
      ? this.d.transcripts.forSession(thread.sessionId, thread.cutoffAt)
      : this.d.transcripts.recent({
          sessions: ROOT_SESSIONS,
          until: thread.cutoffAt,
        })
    const fixes = this.d.corrections.activeFor(raw.map((u) => u.id))
    const utterances = raw.map((u) => this.utteranceItem(u, fixes.get(u.id)))
    const all: TimelineItem[] = [...utterances, ...messages]
    // Stable sort: on a tie the transcript line goes first (the message answers it).
    all.sort((a, b) => a.at - b.at)
    return limit > 0 ? all.slice(-limit) : all
  }

  timeline(threadId: string, limit = 300): Timeline {
    const thread = this.thread(threadId)
    const items = this.items(thread, limit)
    const ids = [
      ...new Set(
        items.flatMap((i) => (i.kind === 'utterance' ? [i.sessionId] : [])),
      ),
    ]
    const sessions: SessionInfo[] = []
    for (const id of ids) {
      const s: Session | null = this.d.sessions.get(id)
      if (s)
        sessions.push({
          id: s.id,
          title: s.title,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          source: s.source,
        })
    }
    sessions.sort((a, b) => a.startedAt - b.startedAt)
    return {
      thread,
      items,
      sessions,
      highlights: this.d.highlights.list(threadId),
      busy: this.busy.has(threadId),
    }
  }

  // ---- send ----

  /** Validates, stores the user message and returns the turn. Throws ChatError when it cannot start. */
  begin(threadId: string, input: SendInput): Turn {
    const thread = this.thread(threadId)
    const text = input.text.trim()
    if (!text) throw new ChatError('invalid', 'Escribe un mensaje.')
    if (text.length > MAX_TEXT)
      throw new ChatError('invalid', 'El mensaje es demasiado largo.')
    const quote = input.quote?.trim() || null
    if (quote && quote.length > MAX_QUOTE)
      throw new ChatError('invalid', 'El fragmento es demasiado largo.')
    if (!this.d.llm)
      throw new ChatError('unavailable', 'El asistente no está disponible.')
    if (this.busy.has(threadId))
      throw new ChatError('busy', 'Espera a que termine la respuesta.')

    let replyTo: ReplyRef | null = null
    if (input.replyTo) {
      replyTo = this.replyRef(input.replyTo.kind, input.replyTo.id)
      if (!replyTo)
        throw new ChatError(
          'not_found',
          'El mensaje al que respondes ya no existe.',
        )
    }

    this.busy.add(threadId)
    try {
      const history = this.items(thread, 0).filter(
        (i) => i.kind === 'utterance' || i.text.trim() !== '',
      )
      const user: ChatMessageRow = {
        id: this.newId(),
        threadId,
        role: 'user',
        text,
        createdAt: this.now(),
        status: 'complete',
        replyToKind: replyTo?.kind ?? null,
        replyToId: replyTo?.id ?? null,
        quote,
        actions: [],
        copiedFrom: null,
      }
      this.d.messages.add(user)
      this.d.threads.touch(threadId, user.createdAt)
      const item = this.messageItem(user)
      return {
        user: item,
        run: (signal) => this.run(thread, history, item, signal),
        // For a caller that will not run the turn: the thread must not stay locked.
        release: () => this.busy.delete(threadId),
      }
    } catch (err) {
      this.busy.delete(threadId)
      throw err
    }
  }

  private async recall(text: string): Promise<string[]> {
    try {
      const hits = await this.d.search.search(text, RECALL_HITS, {
        minScore: RECALL_MIN_SCORE,
      })
      return hits.map((h) => h.text)
    } catch {
      return []
    }
  }

  private async *streamPass(
    messages: ChatMessage[],
    signal: AbortSignal | undefined,
  ): AsyncGenerator<ChatEvent, { raw: string; failed: boolean }> {
    const llm = this.d.llm
    const strip = new OpStripper()
    if (!llm) return { raw: '', failed: true }
    try {
      for await (const delta of llm.stream(messages, {
        signal,
        maxTokens: CHAT_MAX_TOKENS,
      })) {
        const out = strip.push(delta)
        if (out) yield { type: 'delta', text: out }
      }
      const rest = strip.flush()
      if (rest) yield { type: 'delta', text: rest }
      return { raw: strip.raw, failed: false }
    } catch (err) {
      if (isAbortError(err) || signal?.aborted)
        return { raw: strip.raw, failed: false }
      return { raw: strip.raw, failed: true }
    }
  }

  private async *run(
    thread: ChatThread,
    history: TimelineItem[],
    user: TimelineMessage,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<ChatEvent, void> {
    const reply: ChatMessageRow = {
      id: this.newId(),
      threadId: thread.id,
      role: 'assistant',
      text: '',
      createdAt: this.now(),
      // Until it finishes, a crash leaves it interrupted rather than looking complete.
      status: 'interrupted',
      replyToKind: null,
      replyToId: null,
      quote: null,
      actions: [],
      copiedFrom: null,
    }
    const actions: ChatAction[] = []
    let text = ''
    let status: ChatMessageRow['status'] = 'complete'
    try {
      yield { type: 'user', message: user }
      this.d.messages.add(reply)
      const { messages, refs } = buildContext({
        items: history,
        newMessage: {
          text: user.text,
          replyTo: user.replyTo,
          quote: user.quote,
        },
        recall: await this.recall(user.text),
      })

      const first = yield* this.streamPass(messages, signal)
      const parsed = parseOps(first.raw)
      text = parsed.text
      if (first.failed && !text) {
        status = 'error'
        yield {
          type: 'error',
          message: 'No se pudo obtener una respuesta. Inténtalo de nuevo.',
        }
      } else if (signal?.aborted) {
        status = 'interrupted'
      } else {
        if (first.failed) status = 'error'
        const done = yield* this.applyOps(
          thread,
          parsed.ops,
          parsed.rejected,
          refs,
          actions,
          true,
        )
        if (done.resume) {
          const hits = done.resume
          if (hits.length === 0) {
            const note = 'No encontré ese tema en las transcripciones.'
            text = text ? `${text}\n\n${note}` : note
            yield { type: 'delta', text: `${text ? '\n\n' : ''}${note}` }
          } else {
            const followUp: ChatMessage[] = [
              ...messages,
              { role: 'assistant', content: text || 'Busco el tema.' },
              {
                role: 'user',
                content: `${RESUME_PROMPT}\n\n${hits.map((h) => `- ${h}`).join('\n')}`,
              },
            ]
            if (text) yield { type: 'delta', text: '\n\n' }
            const second = yield* this.streamPass(followUp, signal)
            const again = parseOps(second.raw)
            text = text ? `${text}\n\n${again.text}` : again.text
            if (!signal?.aborted) {
              yield* this.applyOps(
                thread,
                again.ops,
                again.rejected,
                refs,
                actions,
                false,
              )
            }
            if (second.failed && !again.text) status = 'error'
            if (signal?.aborted) status = 'interrupted'
          }
        }
      }
    } catch {
      status = 'error'
      yield {
        type: 'error',
        message: 'No se pudo obtener una respuesta. Inténtalo de nuevo.',
      }
    } finally {
      this.d.messages.finish(reply.id, { text, status, actions })
      this.d.threads.touch(thread.id, this.now())
      this.busy.delete(thread.id)
    }
    const stored = this.d.messages.get(reply.id)
    if (stored) yield { type: 'done', message: this.messageItem(stored) }
  }

  /**
   * Applies the model's operations. Yields one `action` event per result (including refusals, so nothing fails
   * silently). Returns the resume hits to read back, when a `resume` op was allowed and found something.
   */
  private *applyOps(
    thread: ChatThread,
    ops: ModelOp[],
    rejected: RejectedOp[],
    refs: Map<string, RefTarget>,
    actions: ChatAction[],
    allowResume: boolean,
  ): Generator<ChatEvent, { resume: string[] | null }> {
    const emit = (a: ChatAction): ChatEvent => {
      actions.push(a)
      return { type: 'action', action: a }
    }
    for (const r of rejected)
      yield emit({ type: 'rejected', op: r.op, reason: r.reason })
    let resume: string[] | null = null
    for (const op of ops) {
      try {
        if (op.op === 'resume') {
          if (!allowResume) continue
          const found = this.resumeSearch(thread, op.query)
          resume = found.map((f) => `${speakerName(f)}: ${oneLine(f.text)}`)
          yield emit({
            type: 'resume',
            query: op.query,
            utteranceIds: found.map((f) => f.id),
          })
          continue
        }
        if (op.op === 'act')
          throw new ChatError(
            'invalid',
            'El agente solo actúa durante una llamada.',
          )
        const target = refs.get(op.ref)
        if (!target)
          throw new ChatError('not_found', 'No encontré ese elemento.')
        if (op.op === 'correct') {
          if (target.kind !== 'utterance')
            throw new ChatError(
              'invalid',
              'Solo se pueden corregir frases de una transcripción.',
            )
          const c = this.correctUtterance(
            target.id,
            op.text,
            op.reason,
            thread.id,
          )
          yield emit({
            type: 'correction',
            utteranceId: target.id,
            original: c.originalText,
            corrected: c.correctedText,
            reason: c.reason,
          })
        } else if (op.op === 'highlight') {
          const h = this.highlight(
            thread.id,
            target.kind,
            target.id,
            op.quote,
            op.note,
          )
          yield emit({
            type: 'highlight',
            highlightId: h.id,
            targetKind: h.targetKind,
            targetId: h.targetId,
            quoted: h.quoted,
          })
        } else if (op.op === 'fork') {
          if (target.kind !== 'message')
            throw new ChatError(
              'invalid',
              'Solo se puede bifurcar desde un mensaje del chat.',
            )
          const f = this.fork(thread.id, target.id, op.title)
          yield emit({ type: 'fork', threadId: f.id, title: f.title })
        }
      } catch (err) {
        const reason =
          err instanceof ChatError
            ? err.message
            : 'No se pudo aplicar la operación.'
        yield emit({ type: 'rejected', op: op.op, reason })
      }
    }
    return { resume }
  }

  // ---- operations (also reachable from GraphQL) ----

  /** Transcript lines mentioning the query terms, with the correction applied. */
  resumeSearch(thread: ChatThread, query: string): TimelineUtterance[] {
    const rows = this.d.transcripts.find(
      searchTerms(query),
      RESUME_HITS,
      thread.cutoffAt,
    )
    const fixes = this.d.corrections.activeFor(rows.map((r) => r.id))
    return rows.map((r) => this.utteranceItem(r, fixes.get(r.id))).reverse()
  }

  /** The correction is an overlay: `utterances.text` is never rewritten, the original stays in the correction row. */
  correctUtterance(
    utteranceId: string,
    text: string,
    reason: string | null,
    threadId: string | null,
  ): Correction {
    const u = this.d.transcripts.get(utteranceId)
    if (!u) throw new ChatError('not_found', 'No existe esa frase.')
    const corrected = text.trim()
    if (!corrected)
      throw new ChatError('invalid', 'El texto corregido está vacío.')
    if (corrected.length > MAX_TEXT)
      throw new ChatError('invalid', 'El texto corregido es demasiado largo.')
    const current = this.d.corrections.active(utteranceId)
    if ((current ? current.correctedText : u.text) === corrected)
      throw new ChatError('invalid', 'El texto ya es ese.')
    const c: Correction = {
      id: this.newId(),
      utteranceId,
      // Always the transcribed text, never an earlier correction.
      originalText: u.text,
      correctedText: corrected,
      reason: reason?.trim() || null,
      threadId,
      createdAt: this.now(),
      revertedAt: null,
    }
    this.d.corrections.add(c)
    return c
  }

  /** Undo the active correction: the previous one (or the original) is shown again. */
  revertCorrection(utteranceId: string): boolean {
    return this.d.corrections.revert(utteranceId, this.now())
  }

  /** Highlights a passage. The range is found from the quote, so the model never has to count characters. */
  highlight(
    threadId: string,
    targetKind: TargetKind,
    targetId: string,
    quote: string,
    note: string | null,
  ): Highlight {
    this.thread(threadId)
    const text =
      targetKind === 'message'
        ? this.d.messages.get(targetId)?.text
        : this.effectiveUtterance(targetId)?.text
    if (text === undefined)
      throw new ChatError('not_found', 'No existe ese texto.')
    const q = quote.trim()
    if (!q) throw new ChatError('invalid', 'Falta el fragmento.')
    let start = text.indexOf(q)
    if (start < 0) start = text.toLowerCase().indexOf(q.toLowerCase())
    if (start < 0)
      throw new ChatError('invalid', 'No encontré ese fragmento en el texto.')
    const h: Highlight = {
      id: this.newId(),
      threadId,
      targetKind,
      targetId,
      start,
      end: start + q.length,
      quoted: text.slice(start, start + q.length),
      note: note?.trim() || null,
      createdAt: this.now(),
    }
    this.d.highlights.add(h)
    return h
  }

  /**
   * New thread with the history up to `messageId` (inclusive). Messages and their highlights are copied with new ids;
   * transcripts are not copied: the fork's `cutoffAt` limits which ones the thread shows.
   */
  fork(threadId: string, messageId: string, title?: string | null): ChatThread {
    const source = this.thread(threadId)
    const all = this.d.messages.list(threadId)
    const at = all.findIndex((m) => m.id === messageId)
    const missing = () =>
      new ChatError('not_found', 'Ese mensaje no está en la conversación.')
    let upTo: ChatMessageRow[]
    let anchorAt: number
    let anchorText: string
    if (at >= 0) {
      upTo = all.slice(0, at + 1)
      const last = upTo[upTo.length - 1]
      if (!last) throw missing()
      anchorAt = last.createdAt
      anchorText = last.text
    } else {
      // A line of the call transcript is a fork point too: the fork keeps what was said up to it.
      const line = this.effectiveUtterance(messageId)
      const inThread =
        line &&
        (!source.sessionId || line.sessionId === source.sessionId) &&
        line.at <= (source.cutoffAt ?? Number.MAX_SAFE_INTEGER)
      if (!line || !inThread) throw missing()
      anchorAt = line.at
      anchorText = line.text
      upTo = all.filter((m) => m.createdAt <= anchorAt)
    }
    const label = oneLine(anchorText).slice(0, 40)
    const now = this.now()
    const thread: ChatThread = {
      id: this.newId(),
      title: title?.trim() || `Bifurcación: ${label || 'sin texto'}`,
      createdAt: now,
      updatedAt: now,
      forkedFromThread: source.id,
      forkedFromMessage: messageId,
      sessionId: source.sessionId,
      cutoffAt: anchorAt,
    }
    const tx = this.d.db.transaction(() => {
      this.d.threads.create(thread)
      const idMap = new Map<string, string>()
      for (const m of upTo) idMap.set(m.id, this.newId())
      const sourceHighlights = this.d.highlights.list(source.id)
      const hlMap = new Map<string, string>()
      for (const h of sourceHighlights) hlMap.set(h.id, this.newId())
      for (const m of upTo) {
        const replyId =
          m.replyToKind === 'message' && m.replyToId
            ? (idMap.get(m.replyToId) ?? null)
            : m.replyToId
        this.d.messages.add({
          ...m,
          id: idMap.get(m.id) as string,
          threadId: thread.id,
          replyToKind: replyId ? m.replyToKind : null,
          replyToId: replyId,
          copiedFrom: m.id,
          actions: m.actions.flatMap((a): ChatAction[] => {
            if (a.type !== 'highlight') return [a]
            const mapped = hlMap.get(a.highlightId)
            return mapped
              ? [
                  {
                    ...a,
                    highlightId: mapped,
                    targetId:
                      a.targetKind === 'message'
                        ? (idMap.get(a.targetId) ?? a.targetId)
                        : a.targetId,
                  },
                ]
              : []
          }),
        })
      }
      for (const h of sourceHighlights) {
        const newTarget =
          h.targetKind === 'message' ? idMap.get(h.targetId) : h.targetId
        // Highlights on messages after the fork point stay behind.
        if (!newTarget) continue
        if (h.targetKind === 'utterance') {
          const u = this.d.transcripts.get(h.targetId)
          if (!u || u.tStart > anchorAt) continue
        }
        this.d.highlights.add({
          ...h,
          id: hlMap.get(h.id) as string,
          threadId: thread.id,
          targetId: newTarget,
        })
      }
    })
    tx()
    return thread
  }
}
