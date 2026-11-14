import { SendHorizontal, Square, MessageSquareQuote, X } from 'lucide-react'
import { preview, type ComposerTarget } from './protocol'
import { focusRing } from './view'

/** The box under a timeline: what you write here goes to Ether, in the thread of this call or conversation. */
export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  sending,
  disabled,
  target,
  onClearTarget,
  inputRef,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onStop: () => void
  sending: boolean
  disabled: boolean
  target: ComposerTarget | null
  onClearTarget: () => void
  inputRef: React.Ref<HTMLTextAreaElement>
}) {
  const empty = value.trim() === ''
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (!sending) onSubmit()
      }}
      className="space-y-2"
    >
      {target && (
        <div className="body flex items-start gap-2 rounded-control bg-surface-2 px-3 py-2">
          <MessageSquareQuote
            className="mt-0.5 size-4 shrink-0 text-muted"
            aria-hidden="true"
          />
          <p className="min-w-0 flex-1 text-muted">
            <span className="font-medium text-text">
              {target.intent === 'correct'
                ? 'Corrigiendo'
                : target.quote
                  ? 'Sobre un fragmento de'
                  : 'Respondiendo a'}{' '}
              {target.label}:
            </span>{' '}
            {preview(target.quote ?? target.text, 160)}
          </p>
          <button
            type="button"
            aria-label="Quitar el contexto"
            onClick={onClearTarget}
            className={`grid size-6 shrink-0 place-items-center rounded-control text-muted hover:bg-surface-3 hover:text-text ${focusRing}`}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor="chat-input" className="sr-only">
            Mensaje para Ether
          </label>
          <textarea
            id="chat-input"
            ref={inputRef}
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter breaks the line. Composition (IME) keeps its own Enter.
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault()
                if (!sending && !disabled && !empty) onSubmit()
              }
            }}
            placeholder="Escribile a Ether"
            className={`chat field-sizing-content max-h-40 min-h-10 w-full resize-none rounded-card border border-border bg-surface px-3.5 py-2 text-text placeholder:text-muted ${focusRing}`}
          />
        </div>
        {sending ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Detener la respuesta"
            className={`grid size-10 shrink-0 place-items-center rounded-full bg-accent text-on-accent ${focusRing}`}
          >
            <Square className="size-4" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={disabled || empty}
            aria-label="Enviar"
            className={`grid size-10 shrink-0 place-items-center rounded-full bg-accent text-on-accent transition-opacity duration-(--dur-fast) disabled:opacity-50 ${focusRing}`}
          >
            <SendHorizontal className="size-4" aria-hidden="true" />
          </button>
        )}
      </div>
    </form>
  )
}
