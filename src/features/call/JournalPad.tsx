import { useEffect, useRef, useState } from 'react'
import { SendHorizontal } from 'lucide-react'
import type { TranscriptEntry } from './protocol'

const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

/**
 * The journal's timeline: what was said, in order, and a box to type a line. A typed line is saved as one more
 * turn of yours and nobody answers it, so this does not go through the chat service (which replies).
 */
export function JournalPad({
  entries,
  active,
  onSend,
}: {
  entries: ReadonlyArray<TranscriptEntry>
  /** The session is open: lines can be typed. */
  active: boolean
  /** Returns false when the line could not be sent (the socket is closed). */
  onSend: (text: string) => boolean
}) {
  const [draft, setDraft] = useState('')
  const end = useRef<HTMLLIElement>(null)
  const empty = draft.trim() === ''

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'nearest' })
  }, [entries.length])

  const submit = () => {
    if (empty || !active) return
    if (onSend(draft.trim())) setDraft('')
  }

  return (
    <div className="space-y-3">
      <ol
        aria-label="Transcripción del diario"
        aria-live="polite"
        className="max-h-[50dvh] space-y-2 overflow-y-auto"
      >
        {entries.length === 0 && (
          <li className="text-body text-muted">
            {active
              ? 'Habla cuando quieras. Lo que digas aparece aquí; nadie responde.'
              : 'Aquí aparece lo que dices durante el diario.'}
          </li>
        )}
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="rounded-card bg-surface-2 px-3.5 py-2 text-body-lg"
          >
            {entry.text}
          </li>
        ))}
        <li ref={end} aria-hidden="true" />
      </ol>

      {active && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          className="flex items-end gap-2"
        >
          <div className="min-w-0 flex-1">
            <label htmlFor="journal-input" className="sr-only">
              Escribe una línea para tu diario
            </label>
            <textarea
              id="journal-input"
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter saves, Shift+Enter breaks the line. Composition (IME) keeps its own Enter.
                if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault()
                  submit()
                }
              }}
              placeholder="Escribe una línea"
              className={`field-sizing-content max-h-40 min-h-10 w-full resize-none rounded-card border border-border bg-surface px-3.5 py-2 text-text placeholder:text-muted ${focusRing}`}
            />
          </div>
          <button
            type="submit"
            disabled={empty}
            aria-label="Guardar la línea"
            className={`grid size-10 shrink-0 place-items-center rounded-full bg-surface-3 text-text transition-opacity duration-(--dur-fast) disabled:opacity-50 ${focusRing}`}
          >
            <SendHorizontal className="size-4" aria-hidden="true" />
          </button>
        </form>
      )}
    </div>
  )
}
