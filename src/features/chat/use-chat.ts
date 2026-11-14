import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchLiveThread,
  fetchMainThread,
  fetchSessionThread,
  fetchTimeline,
  forkThread,
  revertCorrection,
  sendMessage,
  SendError,
} from './api'
import {
  messageToItem,
  normalizeAction,
  upsertItem,
  type ChatAction,
  type ChatThread,
  type ChatTimeline,
  type ComposerTarget,
} from './protocol'

const POLL_MS = 4000
/** The call in progress is stored line by line; poll faster so a typed turn lands next to the spoken ones. */
const LIVE_POLL_MS = 1500

/** Where a timeline comes from: the main thread, the call in progress, or one stored conversation. */
export type ChatSource =
  | { kind: 'main' }
  | { kind: 'live' }
  | { kind: 'session'; id: string }

/** The answer being streamed: text so far and the operations the model has already run. */
export interface Draft {
  text: string
  actions: ChatAction[]
}

const message = (err: unknown) =>
  err instanceof Error ? err.message : 'No se pudo conectar con el núcleo.'

const sourceKey = (s: ChatSource) =>
  s.kind === 'session' ? `session:${s.id}` : s.kind

async function resolveRoot(source: ChatSource): Promise<ChatThread | null> {
  if (source.kind === 'live') return fetchLiveThread()
  if (source.kind === 'session') return fetchSessionThread(source.id)
  return fetchMainThread()
}

/**
 * One conversation timeline. A source has a root thread; forking a line opens a branch of it, which stays
 * selected for that source until `leaveFork`. Everything is keyed by source so switching never shows stale lines.
 */
export function useChat(source: ChatSource) {
  const key = sourceKey(source)
  const [root, setRoot] = useState<{ key: string; id: string | null } | null>(
    null,
  )
  const [forked, setForked] = useState<{ key: string; id: string } | null>(null)
  const [loaded, setLoaded] = useState<{
    threadId: string
    data: ChatTimeline
  } | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [target, setTarget] = useState<ComposerTarget | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const forkId = forked?.key === key ? forked.id : null
  const rootId = root?.key === key ? root.id : null
  const threadId = forkId ?? rootId
  const timeline = loaded?.threadId === threadId ? loaded.data : null
  const sending = draft !== null

  // Mirrors of state for callbacks and timers that must see the latest value.
  const sendingRef = useRef(false)
  const threadRef = useRef<string | null>(null)
  useEffect(() => {
    sendingRef.current = sending
    threadRef.current = threadId
  }, [sending, threadId])

  const reload = useCallback(async (id: string) => {
    const data = await fetchTimeline(id)
    // The thread may have changed while the request was in flight.
    if (threadRef.current === id) setLoaded({ threadId: id, data })
  }, [])

  // Resolve the root (the live call can change under us) and poll its timeline while no answer is streaming.
  const kind = source.kind
  const sessionId = source.kind === 'session' ? source.id : null
  useEffect(() => {
    let cancelled = false
    const src: ChatSource =
      kind === 'session' && sessionId
        ? { kind: 'session', id: sessionId }
        : { kind: kind === 'live' ? 'live' : 'main' }
    const tick = async () => {
      if (sendingRef.current) return
      try {
        let id = forkId
        if (!id) {
          const thread = await resolveRoot(src)
          if (cancelled) return
          setRoot({ key, id: thread?.id ?? null })
          id = thread?.id ?? null
        }
        if (!id) return
        const data = await fetchTimeline(id)
        if (cancelled || sendingRef.current) return
        setLoaded({ threadId: id, data })
        setError(null)
      } catch (err) {
        if (!cancelled) setError(message(err))
      }
    }
    void tick()
    const timer = window.setInterval(
      () => void tick(),
      kind === 'live' ? LIVE_POLL_MS : POLL_MS,
    )
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [key, kind, sessionId, forkId])

  const send = useCallback(
    async (text: string, override?: ComposerTarget | null) => {
      const id = threadRef.current
      const body = text.trim()
      if (!id || !body || sendingRef.current) return false
      const ctl = new AbortController()
      abortRef.current = ctl
      const sent = override === undefined ? target : override
      let refused = false
      // Closes the gap until the next render: a second Enter must not start another turn.
      sendingRef.current = true
      setError(null)
      setTarget(null)
      setDraft({ text: '', actions: [] })
      try {
        await sendMessage(
          {
            threadId: id,
            text: body,
            replyTo: sent ? { kind: sent.kind, id: sent.id } : null,
            quote: sent?.quote ?? null,
          },
          (ev) => {
            if (threadRef.current !== id) return
            switch (ev.type) {
              case 'user':
                setLoaded((l) =>
                  l && l.threadId === id
                    ? {
                        ...l,
                        data: {
                          ...l.data,
                          items: upsertItem(
                            l.data.items,
                            messageToItem(ev.message),
                          ),
                        },
                      }
                    : l,
                )
                break
              case 'delta':
                setDraft((d) => (d ? { ...d, text: d.text + ev.text } : d))
                break
              case 'action':
                setDraft((d) =>
                  d
                    ? {
                        ...d,
                        actions: [...d.actions, normalizeAction(ev.action)],
                      }
                    : d,
                )
                break
              case 'done':
                setLoaded((l) =>
                  l && l.threadId === id
                    ? {
                        ...l,
                        data: {
                          ...l.data,
                          items: upsertItem(
                            l.data.items,
                            messageToItem(ev.message),
                          ),
                        },
                      }
                    : l,
                )
                break
              case 'error':
                setError(ev.message)
                break
            }
          },
          ctl.signal,
        )
      } catch (err) {
        // A user stop aborts the fetch; that is not an error.
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setError(
            err instanceof Error
              ? err.message
              : 'No se pudo enviar el mensaje.',
          )
          if (err instanceof SendError) {
            // The core refused the message (busy, invalid): nothing was stored, so the caller gets it back.
            refused = true
            setTarget(sent)
          }
        }
      } finally {
        abortRef.current = null
        setDraft(null)
        try {
          await reload(id)
        } catch {
          // The poll recovers it.
        }
      }
      return !refused
    },
    [target, reload],
  )

  const stop = useCallback(() => abortRef.current?.abort(), [])

  const undoCorrection = useCallback(
    async (utteranceId: string) => {
      const id = threadRef.current
      if (!id) return
      try {
        await revertCorrection(utteranceId)
        await reload(id)
      } catch (err) {
        setError(message(err))
      }
    },
    [reload],
  )

  /** Branches the thread at a line (a message or a transcript line) and shows the branch. */
  const fork = useCallback(
    async (anchorId: string, title?: string) => {
      const id = threadRef.current
      if (!id || sendingRef.current) return
      try {
        const created = await forkThread(id, anchorId, title)
        setTarget(null)
        setForked({ key, id: created.id })
      } catch (err) {
        setError(message(err))
      }
    },
    [key],
  )

  /** Opens a branch the model created. */
  const openFork = useCallback(
    (id: string) => {
      if (sendingRef.current) return
      setTarget(null)
      setForked({ key, id })
    },
    [key],
  )

  const leaveFork = useCallback(() => {
    if (sendingRef.current) return
    setTarget(null)
    setForked(null)
  }, [])

  return {
    threadId,
    timeline,
    draft,
    sending,
    target,
    setTarget,
    error,
    send,
    stop,
    undoCorrection,
    fork,
    openFork,
    leaveFork,
    forked: forkId !== null,
  }
}

export type ChatHandle = ReturnType<typeof useChat>
