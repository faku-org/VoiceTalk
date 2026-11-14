import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, CircleAlert, GitBranch } from 'lucide-react'
import {
  formatStarted,
  sessionLabel,
  sourceLabel,
} from '@/features/sessions/format'
import { ChatItemView } from './ChatItemView'
import { Composer } from './Composer'
import {
  cleanSelection,
  mergeLive,
  sessionHeaderFor,
  streamingItem,
  type ChatHighlight,
  type ChatItem,
  type ChatSession,
  type ComposerTarget,
  type LiveEntry,
} from './protocol'
import { SelectionToolbar, type SelectionAction } from './SelectionToolbar'
import { useChat, type ChatSource } from './use-chat'
import { focusRing, itemLabel } from './view'

const NEAR_BOTTOM_PX = 120

/** What the toolbar or menu is pointing at: a passage of a turn, or the whole turn. */
interface Selection {
  mode: 'toolbar' | 'menu'
  x: number
  y: number
  placement: 'above' | 'below'
  kind: 'message' | 'utterance'
  id: string
  quote: string | null
}

const holderOf = (node: Node | null): HTMLElement | null => {
  const el = node instanceof Element ? node : (node?.parentElement ?? null)
  return el?.closest<HTMLElement>('[data-target-id]') ?? null
}

const clamp = (n: number, min: number, max: number) =>
  Math.min(Math.max(n, min), Math.max(min, max))

function SessionHeader({ session }: { session: ChatSession | undefined }) {
  if (!session) return null
  const platform = sourceLabel(session.source)
  return (
    <li
      role="separator"
      aria-label={`Llamada: ${sessionLabel(session.title, session.startedAt)}`}
      className="meta flex items-center gap-3 pt-4 text-muted"
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

/**
 * The one timeline: spoken and typed turns of a source, a composer under it, and the selection actions.
 * Used by the call view (live) and by each session detail.
 */
export function Conversation({
  source,
  live,
  emptyText,
  logClassName = 'max-h-[60dvh]',
}: {
  source: ChatSource
  /** Lines of the call in progress that are not stored yet. */
  live?: ReadonlyArray<LiveEntry>
  emptyText: string
  logClassName?: string
}) {
  const chat = useChat(source)
  const { timeline, draft, target, forked } = chat
  const [text, setText] = useState('')
  const [sel, setSel] = useState<Selection | null>(null)
  const logRef = useRef<HTMLUListElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stickRef = useRef(true)

  const threadSessionId = timeline?.thread.sessionId ?? null
  const items = useMemo(
    () =>
      source.kind === 'live' && !forked
        ? mergeLive(timeline?.items ?? [], live ?? [], threadSessionId)
        : (timeline?.items ?? []),
    [source.kind, forked, timeline?.items, live, threadSessionId],
  )
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
  }, [items.length, draft?.text, chat.threadId])

  const onScroll = () => {
    const el = logRef.current
    if (!el) return
    stickRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
  }

  // The floating toolbar follows the selected passage inside a turn.
  useEffect(() => {
    const onChange = () => {
      const s = document.getSelection()
      const root = logRef.current
      if (!s || s.isCollapsed || s.rangeCount === 0 || !root) {
        setSel((prev) => (prev?.mode === 'menu' ? prev : null))
        return
      }
      const range = s.getRangeAt(0)
      const holder = holderOf(range.commonAncestorContainer)
      const quote = cleanSelection(s.toString())
      if (!holder || !root.contains(holder) || !quote) {
        setSel((prev) => (prev?.mode === 'menu' ? prev : null))
        return
      }
      const rect = range.getBoundingClientRect()
      const below = rect.top < 56
      setSel((prev) =>
        prev?.mode === 'menu'
          ? prev
          : {
              mode: 'toolbar',
              x: clamp(
                rect.left + rect.width / 2,
                150,
                window.innerWidth - 150,
              ),
              y: below ? rect.bottom + 8 : rect.top - 8,
              placement: below ? 'below' : 'above',
              kind:
                holder.dataset.targetKind === 'utterance'
                  ? 'utterance'
                  : 'message',
              id: holder.dataset.targetId ?? '',
              quote,
            },
      )
    }
    document.addEventListener('selectionchange', onChange)
    return () => document.removeEventListener('selectionchange', onChange)
  }, [])

  const openMenu = (holder: HTMLElement, x: number, y: number) => {
    const s = document.getSelection()
    const inside =
      s && !s.isCollapsed && s.rangeCount > 0
        ? holderOf(s.getRangeAt(0).commonAncestorContainer)
        : null
    setSel({
      mode: 'menu',
      x: clamp(x, 8, window.innerWidth - 200),
      y: clamp(y, 8, window.innerHeight - 220),
      placement: 'below',
      kind: holder.dataset.targetKind === 'utterance' ? 'utterance' : 'message',
      id: holder.dataset.targetId ?? '',
      quote: inside === holder && s ? cleanSelection(s.toString()) : null,
    })
  }

  // Right click on a turn: the same actions as a menu, on the selection or on the whole turn.
  const onContextMenu = (e: React.MouseEvent) => {
    const holder = holderOf(e.target as Node)
    if (!holder) return
    e.preventDefault()
    openMenu(holder, e.clientX, e.clientY)
  }

  // Shift+F10 or the menu key does the same from the keyboard, from the focused turn.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) return
    const turn = (e.target as HTMLElement).closest<HTMLElement>(
      'li[id^="chat-item-"]',
    )
    const holder =
      turn?.querySelector<HTMLElement>('[data-target-id]') ??
      holderOf(document.getSelection()?.anchorNode ?? null)
    if (!holder) return
    e.preventDefault()
    const rect = holder.getBoundingClientRect()
    openMenu(holder, rect.left + 16, rect.top + 24)
  }

  const focusComposer = useCallback(() => {
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  const closeSel = useCallback(() => setSel(null), [])

  const onAction = (action: SelectionAction) => {
    if (!sel) return
    const item = items.find((i) => i.id === sel.id && i.kind === sel.kind)
    setSel(null)
    if (!item) return
    const next: ComposerTarget = {
      kind: item.kind,
      id: item.id,
      label: itemLabel(item),
      text: item.text,
      quote: sel.quote,
    }
    if (action === 'fork') {
      void chat.fork(item.id)
    } else if (action === 'follow') {
      stickRef.current = true
      void chat.send('Continuá este tema.', next)
    } else if (action === 'highlight') {
      stickRef.current = true
      void chat.send('Resaltá este pasaje.', next)
    } else if (action === 'correct') {
      chat.setTarget({ ...next, intent: 'correct' })
      setText((t) => t || 'Corregir por: ')
      focusComposer()
    } else {
      chat.setTarget({ ...next, intent: 'reply' })
      focusComposer()
    }
  }

  const jumpTo = useCallback((itemId: string) => {
    const el = document.getElementById(`chat-item-${itemId}`)
    if (!el) return
    stickRef.current = false
    el.scrollIntoView({ block: 'center' })
    el.querySelector<HTMLElement>('article')?.focus({ preventScroll: true })
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

  const draftItem: ChatItem | null = draft
    ? {
        ...streamingItem('draft', Number.MAX_SAFE_INTEGER, draft.text),
        actions: draft.actions,
        pending: true,
      }
    : null

  const showHeaders = !timeline?.thread.sessionId
  const empty = items.length === 0 && !draftItem

  return (
    <section
      aria-label="Conversación con Ether"
      onKeyDown={onKeyDown}
      className="space-y-3"
    >
      {forked && (
        <div className="body flex flex-wrap items-center gap-2 text-muted">
          <GitBranch className="size-4 shrink-0" aria-hidden="true" />
          <span>Bifurcación «{timeline?.thread.title ?? '…'}»</span>
          <button
            type="button"
            onClick={chat.leaveFork}
            className={`inline-flex items-center gap-1 font-medium text-accent underline ${focusRing}`}
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            Volver
          </button>
        </div>
      )}

      {empty ? (
        <p className="body rounded-panel border border-dashed border-border p-5 text-muted">
          {emptyText}
        </p>
      ) : (
        <ul
          ref={logRef}
          onScroll={onScroll}
          onContextMenu={onContextMenu}
          role="log"
          aria-label="Transcripción"
          aria-live="polite"
          aria-relevant="additions"
          className={`space-y-3 overflow-y-auto ${logClassName}`}
        >
          {items.map((item, i) => {
            const header = showHeaders ? sessionHeaderFor(items, i) : null
            return (
              <ItemRow
                key={`${item.kind}:${item.id}`}
                header={header ? sessions.get(header) : undefined}
              >
                <ChatItemView
                  item={item}
                  items={items}
                  highlights={
                    highlightsByTarget.get(`${item.kind}:${item.id}`) ?? []
                  }
                  sessions={sessions}
                  threadSessionId={threadSessionId}
                  onUndo={(id) => void chat.undoCorrection(id)}
                  onOpenFork={chat.openFork}
                  onJump={jumpTo}
                />
              </ItemRow>
            )
          })}
          {draftItem && (
            <ChatItemView
              item={draftItem}
              items={items}
              highlights={[]}
              sessions={sessions}
              threadSessionId={threadSessionId}
              onUndo={() => undefined}
              onOpenFork={() => undefined}
              onJump={jumpTo}
            />
          )}
        </ul>
      )}

      {sel && (
        <SelectionToolbar
          mode={sel.mode}
          x={sel.x}
          y={sel.y}
          placement={sel.placement}
          onAction={onAction}
          onClose={closeSel}
        />
      )}

      {chat.error && (
        <p role="alert" className="body flex items-start gap-2 text-danger">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {chat.error}
        </p>
      )}

      <Composer
        value={text}
        onChange={setText}
        onSubmit={() => void submit()}
        onStop={chat.stop}
        sending={chat.sending}
        disabled={!chat.threadId}
        target={target}
        onClearTarget={() => chat.setTarget(null)}
        inputRef={inputRef}
      />
    </section>
  )
}

function ItemRow({
  header,
  children,
}: {
  header: ChatSession | undefined
  children: React.ReactNode
}) {
  return (
    <>
      {header && <SessionHeader session={header} />}
      {children}
    </>
  )
}
