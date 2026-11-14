import { Keyboard } from 'lucide-react'
import { focusRing } from './view'

/**
 * One turn of the shared timeline, spoken or typed. Yours sit right on `surface`, Ether's sit left on `bg`.
 * The turn still being said or written has a dashed border. The body is what the selection toolbar targets.
 */
export function TranscriptTurn({
  id,
  side,
  speaker,
  stamp,
  typed = false,
  pending = false,
  children,
}: {
  id: string
  side: 'user' | 'other'
  speaker: string
  stamp?: string
  typed?: boolean
  pending?: boolean
  children: React.ReactNode
}) {
  const mine = side === 'user'
  return (
    <li
      id={`chat-item-${id}`}
      aria-busy={pending || undefined}
      className={`flex ${mine ? 'justify-end' : 'justify-start'}`}
    >
      <article
        tabIndex={0}
        aria-label={`${speaker}${typed ? ', escrito' : ''}`}
        className={`chat max-w-[85%] min-w-0 rounded-card border px-3.5 py-2 ${
          pending ? 'border-dashed' : 'border-solid'
        } border-border ${mine ? 'bg-surface' : 'bg-bg'} ${focusRing}`}
      >
        <p className="meta mb-0.5 flex items-center gap-x-2 text-muted">
          <span className="font-medium">{speaker}</span>
          {stamp && <span className="tabular-nums">{stamp}</span>}
          {typed && (
            <span className="inline-flex items-center gap-1">
              <Keyboard className="size-3.5" aria-hidden="true" />
              escrito
            </span>
          )}
        </p>
        {children}
      </article>
    </li>
  )
}
