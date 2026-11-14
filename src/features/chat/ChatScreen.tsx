import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CircleAlert,
  MessageSquareQuote,
  SendHorizontal,
  Square,
  X,
} from 'lucide-react'
import { Button, SectionTitle } from '@/app/ui'
import {
  formatStarted,
  sessionLabel,
  sourceLabel,
} from '@/features/sessions/format'
import { ChatItemView } from './ChatItemView'
import { focusRing, itemLabel } from './view'
import {
  cleanSelection,
  preview,
  sessionHeaderFor,
  streamingItem,
  type ChatHighlight,
  type ChatItem,
  type ChatSession,
  type ChatThread,
  type ComposerTarget,
  type TargetKind,
} from './protocol'
import { useChat } from './use-chat'

const NEAR_BOTTOM_PX = 120

function threadName(t: ChatThread): string {
  return t.forkedFromThread ? t.title : 'Conversación principal'
}

function SessionHeader({ session }: { session: ChatSession | undefined }) {
  if (!session) return null
  const platform = sourceLabel(session.source)
  return (
    <li
      role="separator"
      aria-label={`Llamada: ${sessionLabel(session.title, session.startedAt)}`}
      className="flex items-center gap-3 pt-4 text-meta text-muted"
    >
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      <span>
        {platform ? `${platform} · ` : ''}
        {sessionLabel(session.title, session.startedAt)} ·{' '}
        {formatStarted(session.startedAt)}
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </li>
  )
}

interface Popover {
  x: number
  y: number
  kind: TargetKind
  id: string
  quote: string
}

export function ChatScreen() {
  const chat = useChat()
  const { timeline, draft, target, threads, threadId } = chat
  const [text, setText] = useState('')
  const [pop, setPop] = useState<Popover | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stickRef = useRef(true)

  const items = timeline?.items ?? []
  const sessions = useMemo(
    () => new Map((timeline?.sessions ?? []).map((s) => [s.id, s])),
    [timeline?.sessions],
  )
  const highlightsByTarget = useMemo(() => {
    const map = new Map<string, ChatHighlight[]>()
    for (const h of timeline?.highlights ?? []) {
      const key = `${h.targetKind}:${h.targetId}`
      map.set(key, [...(map.get(key) ?? []), h])
    }
    return map
  }, [timeline?.highlights])

  // Keep the newest line in view, unless the reader scrolled up to read.
  useEffect(() => {
    const el = logRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [items.length, draft?.text, threadId])

  const onScroll = () => {
    const el = logRef.current
    if (!el) return
    stickRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
  }

  // Follow-up from a selection: a floating "Preguntar sobre esto" next to the selected passage.
  useEffect(() => {
    const onChange = () => {
      const sel = document.getSelection()
      const root = logRef.current
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !root) {
        setPop(null)
        return
      }
      const range = sel.getRangeAt(0)
      const node = range.commonAncestorContainer
      const el = node instanceof Element ? node : node.parentElement
      const holder = el?.closest<HTMLElement>('[data-target-id]')
      const quote = cleanSelection(sel.toString())
      if (!holder || !root.contains(holder) || !quote) {
        setPop(null)
        return
      }
      const rect = range.getBoundingClientRect()
      setPop({
        x: rect.left + rect.width / 2,
        y: rect.top,
        kind:
          holder.dataset.targetKind === 'utterance' ? 'utterance' : 'message',
        id: holder.dataset.targetId ?? '',
        quote,
      })
    }
    document.addEventListener('selectionchange', onChange)
    return () => document.removeEventListener('selectionchange', onChange)
  }, [])

  const focusComposer = useCallback(() => {
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  const replyTo = useCallback(
    (item: ChatItem, quote: string | null = null) => {
      const next: ComposerTarget = {
        kind: item.kind,
        id: item.id,
        label: itemLabel(item),
        text: item.text,
        quote,
      }
      chat.setTarget(next)
      focusComposer()
    },
    [chat, focusComposer],
  )

  const askAboutSelection = () => {
    if (!pop) return
    const item = items.find((i) => i.id === pop.id && i.kind === pop.kind)
    if (!item) return
    replyTo(item, pop.quote)
    document.getSelection()?.removeAllRanges()
    setPop(null)
  }

  const jumpTo = useCallback((itemId: string) => {
    const el = document.getElementById(`chat-item-${itemId}`)
    if (!el) return
    stickRef.current = false
    el.scrollIntoView({ block: 'center' })
    el.focus({ preventScroll: true })
  }, [])

  const submit = async () => {
    const body = text
    if (!body.trim() || chat.sending) return
    setText('')
    stickRef.current = true
    const sent = await chat.send(body)
    // A refused message goes back to the box, not lost.
    if (!sent) setText(body)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  const draftItem = draft
    ? {
        ...streamingItem('draft', Number.MAX_SAFE_INTEGER, draft.text),
        actions: draft.actions,
      }
    : null

  return (
    <section
      aria-labelledby="chat-title"
      className="flex h-[calc(100dvh-10rem)] min-h-[26rem] flex-col gap-4"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div id="chat-title">
          <SectionTitle
            title="Chat"
            description="Escribe con el mismo asistente de tus llamadas. Las transcripciones aparecen en el hilo."
          />
        </div>
        {threads.length > 1 && (
          <div className="space-y-1">
            <label htmlFor="chat-thread" className="block text-meta text-muted">
              Conversación
            </label>
            <select
              id="chat-thread"
              value={threadId ?? ''}
              onChange={(e) => void chat.openThread(e.target.value)}
              className={`h-10 max-w-64 rounded-control border border-border bg-surface px-3 text-body-lg text-text ${focusRing}`}
            >
              {threads.map((t) => (
                <option key={t.id} value={t.id}>
                  {threadName(t)}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div
        ref={logRef}
        onScroll={onScroll}
        role="log"
        aria-label="Conversación"
        aria-live="polite"
        aria-relevant="additions"
        className="min-h-0 flex-1 overflow-y-auto rounded-panel border border-border p-3"
      >
        {timeline && items.length === 0 && !draftItem ? (
          <p className="rounded-panel border border-dashed border-border p-5 text-body text-muted">
            Aún no hay nada aquí. Escribe un mensaje abajo o inicia una llamada:
            su transcripción aparecerá en este hilo.
          </p>
        ) : (
          <ul className="space-y-3">
            {items.map((item, i) => {
              const header = sessionHeaderFor(items, i)
              return (
                <ItemRow
                  key={`${item.kind}:${item.id}`}
                  header={header ? sessions.get(header) : undefined}
                  hasHeader={header !== null}
                >
                  <ChatItemView
                    item={item}
                    items={items}
                    highlights={
                      highlightsByTarget.get(`${item.kind}:${item.id}`) ?? []
                    }
                    threads={threads}
                    onReply={(it) => replyTo(it)}
                    onFork={(id) => void chat.fork(id)}
                    onUndo={(id) => void chat.undoCorrection(id)}
                    onOpenThread={(id) => void chat.openThread(id)}
                    onJump={jumpTo}
                  />
                </ItemRow>
              )
            })}
            {draftItem && (
              <li className="flex flex-col items-start" aria-busy="true">
                <div className="max-w-[min(42rem,92%)] rounded-panel bg-surface-2 px-4 py-3 text-body-lg">
                  <p className="mb-1 text-meta font-medium text-muted">
                    VoiceTalk
                  </p>
                  <p className="whitespace-pre-wrap">
                    {draft?.text || (
                      <span className="text-muted">Escribiendo…</span>
                    )}
                  </p>
                  {draftItem.actions.length > 0 && (
                    <p className="mt-2 text-meta text-muted">
                      Aplicando {draftItem.actions.length}{' '}
                      {draftItem.actions.length === 1
                        ? 'operación'
                        : 'operaciones'}
                      …
                    </p>
                  )}
                </div>
              </li>
            )}
          </ul>
        )}
      </div>

      {pop && (
        <button
          type="button"
          // Keep the text selected while the button is pressed.
          onMouseDown={(e) => e.preventDefault()}
          onClick={askAboutSelection}
          style={{
            left: pop.x,
            top: Math.max(8, pop.y - 44),
            transform: 'translateX(-50%)',
          }}
          className={`fixed z-30 inline-flex h-9 items-center gap-2 rounded-control border border-border bg-surface px-3 text-body font-medium text-text shadow-sm hover:bg-surface-2 ${focusRing}`}
        >
          <MessageSquareQuote className="size-4" aria-hidden="true" />
          Preguntar sobre esto
        </button>
      )}

      <div aria-live="polite" className="min-h-0">
        {chat.error && (
          <p
            role="alert"
            className="flex items-start gap-2 text-body text-danger"
          >
            <CircleAlert
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            {chat.error}
          </p>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        className="space-y-2"
      >
        {target && (
          <div className="flex items-start gap-2 rounded-control bg-surface-2 px-3 py-2 text-body">
            <MessageSquareQuote
              className="mt-0.5 size-4 shrink-0 text-muted"
              aria-hidden="true"
            />
            <p className="min-w-0 flex-1 text-muted">
              <span className="font-medium text-text">
                {target.quote ? 'Sobre un fragmento de' : 'Respondiendo a'}{' '}
                {target.label}:
              </span>{' '}
              {preview(target.quote ?? target.text, 160)}
            </p>
            <button
              type="button"
              aria-label="Quitar el contexto"
              onClick={() => chat.setTarget(null)}
              className={`grid size-6 shrink-0 place-items-center rounded-control text-muted hover:bg-surface-3 hover:text-text ${focusRing}`}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor="chat-input" className="sr-only">
              Mensaje
            </label>
            <textarea
              id="chat-input"
              ref={inputRef}
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Escribe un mensaje. Enter envía, Mayús+Enter agrega una línea."
              className={`w-full resize-none rounded-control border border-border bg-surface px-3 py-2 text-body-lg text-text placeholder:text-muted ${focusRing}`}
            />
          </div>
          {chat.sending ? (
            <Button onClick={chat.stop} aria-label="Detener la respuesta">
              <Square className="size-4" aria-hidden="true" />
              Detener
            </Button>
          ) : (
            <Button type="submit" variant="primary">
              <SendHorizontal className="size-4" aria-hidden="true" />
              Enviar
            </Button>
          )}
        </div>
      </form>
    </section>
  )
}

function ItemRow({
  header,
  hasHeader,
  children,
}: {
  header: ChatSession | undefined
  hasHeader: boolean
  children: React.ReactNode
}) {
  return (
    <>
      {hasHeader && <SessionHeader session={header} />}
      {children}
    </>
  )
}
