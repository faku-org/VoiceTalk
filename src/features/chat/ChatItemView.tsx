import { useState } from 'react'
import {
  CircleAlert,
  CornerUpLeft,
  GitBranch,
  History,
  Pencil,
  Search,
  Undo2,
} from 'lucide-react'
import {
  preview,
  segmentText,
  type ChatAction,
  type ChatHighlight,
  type ChatItem,
  type ChatThread,
} from './protocol'
import { focusRing, itemLabel } from './view'

const smallButton = `inline-flex h-8 items-center gap-1.5 rounded-control px-2 text-meta font-medium text-muted transition-colors duration-(--dur-fast) hover:bg-surface-2 hover:text-text ${focusRing}`

/** Text with the model's highlights as marks; they are re-anchored by their quote when the text changed. */
function Marked({
  text,
  highlights,
}: {
  text: string
  highlights: ChatHighlight[]
}) {
  const notes = new Map(highlights.map((h) => [h.id, h.note]))
  return (
    <>
      {segmentText(text, highlights).map((s, i) =>
        s.highlightId ? (
          <mark
            key={i}
            data-highlight={s.highlightId}
            title={notes.get(s.highlightId) ?? 'Resaltado por el asistente'}
            className="rounded-sm bg-accent/20 px-0.5 text-inherit"
          >
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  )
}

function ActionChips({
  actions,
  items,
  threads,
  onUndo,
  onOpenThread,
  onJump,
}: {
  actions: ChatAction[]
  items: ChatItem[]
  threads: ChatThread[]
  onUndo: (utteranceId: string) => void
  onOpenThread: (id: string) => void
  onJump: (itemId: string) => void
}) {
  if (actions.length === 0) return null
  return (
    <ul className="mt-2 space-y-1.5">
      {actions.map((a, i) => (
        <li key={i} className="text-meta text-muted">
          {a.type === 'correction' && a.utteranceId && (
            <CorrectionChip
              action={a}
              items={items}
              onUndo={() => onUndo(a.utteranceId!)}
            />
          )}
          {a.type === 'highlight' && (
            <span className="inline-flex items-start gap-1.5">
              <Pencil className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>Resaltado: «{preview(a.quoted ?? '', 120)}»</span>
            </span>
          )}
          {a.type === 'fork' && a.threadId && (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
              <span>
                Nueva conversación
                {a.title ? ` «${a.title}»` : ''}.
              </span>
              {threads.some((t) => t.id === a.threadId) && (
                <button
                  type="button"
                  onClick={() => onOpenThread(a.threadId!)}
                  className={`font-medium text-accent underline ${focusRing}`}
                >
                  Abrir bifurcación
                </button>
              )}
            </span>
          )}
          {a.type === 'resume' && (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <Search className="size-3.5 shrink-0" aria-hidden="true" />
              <span>
                {(a.utteranceIds?.length ?? 0) > 0
                  ? `Retomando «${a.query ?? ''}»: ${a.utteranceIds!.length} ${
                      a.utteranceIds!.length === 1 ? 'fragmento' : 'fragmentos'
                    } de las transcripciones.`
                  : `No encontré «${a.query ?? ''}» en las transcripciones.`}
              </span>
              {(a.utteranceIds?.length ?? 0) > 0 && (
                <button
                  type="button"
                  onClick={() => onJump(a.utteranceIds![0]!)}
                  className={`font-medium text-accent underline ${focusRing}`}
                >
                  Ir al primero
                </button>
              )}
            </span>
          )}
          {a.type === 'rejected' && (
            <span className="inline-flex items-start gap-1.5">
              <CircleAlert
                className="mt-0.5 size-3.5 shrink-0"
                aria-hidden="true"
              />
              <span>No se pudo aplicar una operación: {a.reason}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

function CorrectionChip({
  action,
  items,
  onUndo,
}: {
  action: ChatAction
  items: ChatItem[]
  onUndo: () => void
}) {
  const utt = items.find(
    (i) => i.kind === 'utterance' && i.id === action.utteranceId,
  )
  // Undo is offered only while this correction is the one in effect.
  const active = utt?.corrected === true && utt.text === action.corrected
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Pencil className="size-3.5 shrink-0" aria-hidden="true" />
      <span>
        Corregido: «{preview(action.original ?? '', 80)}» a «
        {preview(action.corrected ?? '', 80)}»
      </span>
      {active ? (
        <button
          type="button"
          onClick={onUndo}
          className={`inline-flex items-center gap-1 font-medium text-accent underline ${focusRing}`}
        >
          <Undo2 className="size-3.5" aria-hidden="true" />
          Deshacer
        </button>
      ) : (
        <span>(sin efecto)</span>
      )}
    </span>
  )
}

export function ChatItemView({
  item,
  items,
  highlights,
  threads,
  onReply,
  onFork,
  onUndo,
  onOpenThread,
  onJump,
}: {
  item: ChatItem
  items: ChatItem[]
  highlights: ChatHighlight[]
  threads: ChatThread[]
  onReply: (item: ChatItem) => void
  onFork: (messageId: string) => void
  onUndo: (utteranceId: string) => void
  onOpenThread: (id: string) => void
  onJump: (itemId: string) => void
}) {
  const [showOriginal, setShowOriginal] = useState(false)
  const label = itemLabel(item)

  if (item.kind === 'utterance') {
    return (
      <li
        id={`chat-item-${item.id}`}
        tabIndex={-1}
        className="group rounded-control px-3 py-2 text-body focus-visible:outline-2 focus-visible:outline-accent"
      >
        <div className="flex items-baseline gap-2">
          <span className="text-meta font-medium text-muted">{label}</span>
          {item.corrected && (
            <button
              type="button"
              aria-expanded={showOriginal}
              onClick={() => setShowOriginal((v) => !v)}
              className={`text-meta text-muted underline ${focusRing}`}
            >
              Corregido
            </button>
          )}
          <button
            type="button"
            onClick={() => onReply(item)}
            className={`${smallButton} ml-auto opacity-0 group-hover:opacity-100 group-focus-within:opacity-100`}
          >
            <CornerUpLeft className="size-3.5" aria-hidden="true" />
            Responder
          </button>
        </div>
        <p
          data-target-kind="utterance"
          data-target-id={item.id}
          className="mt-0.5 whitespace-pre-wrap text-text"
        >
          <Marked text={item.text} highlights={highlights} />
        </p>
        {item.corrected && showOriginal && item.originalText && (
          <p className="mt-1 text-meta text-muted">
            Original: {item.originalText}
          </p>
        )}
      </li>
    )
  }

  const mine = item.role === 'user'
  return (
    <li
      id={`chat-item-${item.id}`}
      tabIndex={-1}
      className={`group flex flex-col ${mine ? 'items-end' : 'items-start'}`}
    >
      <div
        className={`max-w-[min(42rem,92%)] rounded-panel px-4 py-3 text-body-lg ${
          mine ? 'bg-accent/10 text-text' : 'bg-surface-2 text-text'
        }`}
      >
        <p className="mb-1 text-meta font-medium text-muted">{label}</p>
        {item.replyTo && (
          <p className="mb-2 flex items-start gap-1.5 text-meta text-muted">
            <CornerUpLeft
              className="mt-0.5 size-3.5 shrink-0"
              aria-hidden="true"
            />
            <span>
              {item.replyTo.label}: {preview(item.replyTo.text, 140)}
            </span>
          </p>
        )}
        {item.quote && (
          <blockquote className="mb-2 text-meta text-muted">
            «{preview(item.quote, 200)}»
          </blockquote>
        )}
        <p
          data-target-kind="message"
          data-target-id={item.id}
          className="whitespace-pre-wrap"
        >
          <Marked text={item.text} highlights={highlights} />
        </p>
        {item.status === 'interrupted' && (
          <p className="mt-1 flex items-center gap-1.5 text-meta text-muted">
            <History className="size-3.5" aria-hidden="true" />
            Respuesta interrumpida.
          </p>
        )}
        {item.status === 'error' && (
          <p className="mt-1 flex items-center gap-1.5 text-meta text-danger">
            <CircleAlert className="size-3.5" aria-hidden="true" />
            No se pudo completar la respuesta.
          </p>
        )}
        <ActionChips
          actions={item.actions}
          items={items}
          threads={threads}
          onUndo={onUndo}
          onOpenThread={onOpenThread}
          onJump={onJump}
        />
      </div>
      <div className="mt-1 flex gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          onClick={() => onReply(item)}
          className={smallButton}
        >
          <CornerUpLeft className="size-3.5" aria-hidden="true" />
          Responder
        </button>
        {item.status === 'done' && (
          <button
            type="button"
            onClick={() => onFork(item.id)}
            className={smallButton}
          >
            <GitBranch className="size-3.5" aria-hidden="true" />
            Bifurcar desde aquí
          </button>
        )}
      </div>
    </li>
  )
}
