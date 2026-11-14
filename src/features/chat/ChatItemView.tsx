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
  type ChatSession,
} from './protocol'
import { TranscriptTurn } from './TranscriptTurn'
import { focusRing, isTyped, itemLabel, itemSide, itemStamp } from './view'

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
            className="rounded-sm bg-highlight px-0.5 text-inherit"
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
  onUndo,
  onOpenFork,
  onJump,
}: {
  actions: ChatAction[]
  items: ChatItem[]
  onUndo: (utteranceId: string) => void
  onOpenFork: (id: string) => void
  onJump: (itemId: string) => void
}) {
  if (actions.length === 0) return null
  return (
    <ul className="mt-2 space-y-1.5">
      {actions.map((a, i) => (
        <li key={i} className="meta text-muted">
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
              <button
                type="button"
                onClick={() => onOpenFork(a.threadId!)}
                className={`font-medium text-accent underline ${focusRing}`}
              >
                Abrir bifurcación
              </button>
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
  sessions,
  threadSessionId,
  onUndo,
  onOpenFork,
  onJump,
}: {
  item: ChatItem
  items: ChatItem[]
  highlights: ChatHighlight[]
  sessions: ReadonlyMap<string, ChatSession>
  threadSessionId: string | null
  onUndo: (utteranceId: string) => void
  onOpenFork: (id: string) => void
  onJump: (itemId: string) => void
}) {
  const [showOriginal, setShowOriginal] = useState(false)
  const common = {
    id: item.id,
    side: itemSide(item),
    speaker: itemLabel(item),
    stamp: itemStamp(item, sessions, threadSessionId),
    typed: isTyped(item),
    pending: item.pending === true,
  }

  if (item.kind === 'utterance') {
    return (
      <TranscriptTurn {...common}>
        <p
          data-target-kind="utterance"
          data-target-id={item.id}
          className="whitespace-pre-wrap text-text"
        >
          <Marked text={item.text} highlights={highlights} />
        </p>
        {item.corrected && (
          <p className="meta mt-1 text-muted">
            <button
              type="button"
              aria-expanded={showOriginal}
              onClick={() => setShowOriginal((v) => !v)}
              className={`underline ${focusRing}`}
            >
              Corregido
            </button>
            {showOriginal && item.originalText && (
              <span> · Original: {item.originalText}</span>
            )}
          </p>
        )}
      </TranscriptTurn>
    )
  }

  return (
    <TranscriptTurn {...common}>
      {item.replyTo && (
        <p className="meta mb-2 flex items-start gap-1.5 text-muted">
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
        <blockquote className="meta mb-2 text-muted">
          «{preview(item.quote, 200)}»
        </blockquote>
      )}
      <p
        data-target-kind="message"
        data-target-id={item.id}
        className="whitespace-pre-wrap text-text"
      >
        {item.pending && item.text === '' ? (
          <span className="text-muted">Escribiendo…</span>
        ) : (
          <Marked text={item.text} highlights={highlights} />
        )}
      </p>
      {item.status === 'interrupted' && (
        <p className="meta mt-1 flex items-center gap-1.5 text-muted">
          <History className="size-3.5" aria-hidden="true" />
          Respuesta interrumpida.
        </p>
      )}
      {item.status === 'error' && (
        <p className="meta mt-1 flex items-center gap-1.5 text-danger">
          <CircleAlert className="size-3.5" aria-hidden="true" />
          No se pudo completar la respuesta.
        </p>
      )}
      <ActionChips
        actions={item.actions}
        items={items}
        onUndo={onUndo}
        onOpenFork={onOpenFork}
        onJump={onJump}
      />
    </TranscriptTurn>
  )
}
