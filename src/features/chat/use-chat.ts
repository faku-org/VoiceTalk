import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchMainThread,
  fetchThreads,
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

/** The answer being streamed: text so far and the operations the model has already run. */
export interface Draft {
  text: string
  actions: ChatAction[]
}

const message = (err: unknown) =>
  err instanceof Error ? err.message : 'No se pudo conectar con el núcleo.'

export function useChat() {
  const [threads, setThreads] = useState<ChatThread[]>([])
  const [threadId, setThreadId] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<ChatTimeline | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [target, setTarget] = useState<ComposerTarget | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const sending = draft !== null
  // Mirrors of state for callbacks and timers that must see the latest value.
  const sendingRef = useRef(false)
  const threadRef = useRef<string | null>(null)
  useEffect(() => {
    sendingRef.current = sending
    threadRef.current = threadId
  }, [sending, threadId])

  const reload = useCallback(async (id: string) => {
    const next = await fetchTimeline(id)
    // The thread may have changed while the request was in flight.
    if (threadRef.current === id) setTimeline(next)
  }, [])

  // First load: the main thread and the thread list.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [main, all] = await Promise.all([
          fetchMainThread(),
          fetchThreads(),
        ])
        if (cancelled) return
        setThreads(all)
        setThreadId(main.id)
      } catch (err) {
        if (!cancelled) setError(message(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Timeline of the active thread, polled while no answer is streaming (new call lines show up by themselves).
  useEffect(() => {
    if (!threadId) return
    let cancelled = false
    const tick = async () => {
      if (sendingRef.current) return
      try {
        const next = await fetchTimeline(threadId)
        if (cancelled || sendingRef.current) return
        setTimeline(next)
        setError(null)
      } catch (err) {
        if (!cancelled) setError(message(err))
      }
    }
    void tick()
    const id = window.setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [threadId])

  const refreshThreads = useCallback(async () => {
    try {
      setThreads(await fetchThreads())
    } catch {
      // The list refreshes on the next action.
    }
  }, [])

  const send = useCallback(
    async (text: string) => {
      const id = threadRef.current
      const body = text.trim()
      if (!id || !body || sendingRef.current) return false
      const ctl = new AbortController()
      abortRef.current = ctl
      const sent = target
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
                setTimeline((t) =>
                  t
                    ? {
                        ...t,
                        items: upsertItem(t.items, messageToItem(ev.message)),
                      }
                    : t,
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
                setTimeline((t) =>
                  t
                    ? {
                        ...t,
                        items: upsertItem(t.items, messageToItem(ev.message)),
                      }
                    : t,
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
          await refreshThreads()
        } catch {
          // The poll recovers it.
        }
      }
      return !refused
    },
    [target, reload, refreshThreads],
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

  const fork = useCallback(
    async (messageId: string, title?: string) => {
      const id = threadRef.current
      if (!id) return
      try {
        const created = await forkThread(id, messageId, title)
        await refreshThreads()
        setTarget(null)
        setTimeline(null)
        setThreadId(created.id)
      } catch (err) {
        setError(message(err))
      }
    },
    [refreshThreads],
  )

  const openThread = useCallback(
    async (id: string) => {
      if (sendingRef.current) return
      setTarget(null)
      setTimeline(null)
      setThreadId(id)
      await refreshThreads()
    },
    [refreshThreads],
  )

  return {
    threads,
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
    openThread,
  }
}

export type ChatHandle = ReturnType<typeof useChat>
