import { useCallback, useEffect, useState } from 'react'
import {
  CircleAlert,
  Headphones,
  History,
  MapPin,
  NotebookPen,
  RefreshCw,
} from 'lucide-react'
import { Button, SectionTitle } from '@/app/ui'
import { Conversation } from '@/features/chat'
import {
  fetchSession,
  fetchSessions,
  type SessionDetailData,
  type SessionSummaryRow,
} from './api'
import {
  JOURNAL_SOURCE,
  formatDuration,
  formatStarted,
  sessionLabel,
  sourceLabel,
  statusLabel,
} from './format'

type Load<T> =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; data: T }

const message = (err: unknown) =>
  err instanceof Error ? err.message : 'No se pudo conectar con el núcleo.'

function ErrorLine({ text }: { text: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 text-body text-danger">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {text}
    </p>
  )
}

function Empty({ children }: { children: string }) {
  return (
    <p className="rounded-panel border border-dashed border-border p-5 text-body text-muted">
      {children}
    </p>
  )
}

function Bullets({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div>
      <h4 className="text-body font-medium">{title}</h4>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-body text-muted">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

type Filter = 'all' | 'journal'

const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: 'all', label: 'Todas' },
  { id: 'journal', label: 'Diario' },
]

/** Todas / Diario. Stays on screen when the filtered list is empty, so the way back is always there. */
function FilterTabs({
  value,
  onChange,
}: {
  value: Filter
  onChange: (next: Filter) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Filtrar sesiones"
      className="inline-flex gap-1 rounded-control bg-surface-2 p-1"
    >
      {FILTERS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          onClick={() => onChange(id)}
          className={`h-8 rounded-control px-3 text-body-lg font-medium transition-colors duration-(--dur-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
            value === id
              ? 'bg-surface text-accent'
              : 'text-muted hover:text-text'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function SessionRow({
  row,
  selected,
  onSelect,
}: {
  row: SessionSummaryRow
  selected: boolean
  onSelect: () => void
}) {
  const duration = formatDuration(row.startedAt, row.endedAt)
  const platform = sourceLabel(row.source)
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={`w-full rounded-control border px-3 py-2.5 text-left transition-colors duration-(--dur-fast) ${
          selected
            ? 'border-accent bg-surface-2'
            : 'border-border bg-surface hover:bg-surface-2'
        }`}
      >
        <span className="block truncate text-body-lg font-medium">
          {sessionLabel(row.title, row.startedAt)}
        </span>
        <span className="mt-0.5 block text-meta text-muted">
          {platform ? `${platform} · ` : ''}
          {formatStarted(row.startedAt)}
          {duration ? ` · ${duration}` : ''} · {statusLabel(row.status)}
        </span>
      </button>
    </li>
  )
}

/** Where the session came from: a journal, or a call captured from a platform. */
function SourceBadge({ source, label }: { source: string; label: string }) {
  const journal = source === JOURNAL_SOURCE
  const Icon = journal ? NotebookPen : Headphones
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <Icon className="size-3.5" aria-hidden="true" />
      {journal ? label : `Capturada de ${label}`}
    </span>
  )
}

function SessionDetail({ session }: { session: SessionDetailData }) {
  const duration = formatDuration(session.startedAt, session.endedAt)
  const where = session.location.trim()
  const platform = sourceLabel(session.source)
  return (
    <article className="space-y-5">
      <header>
        <h3 className="text-h3 font-semibold tracking-tight">
          {sessionLabel(session.title, session.startedAt)}
        </h3>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 text-meta text-muted">
          <span>{formatStarted(session.startedAt)}</span>
          {duration && <span>{duration}</span>}
          <span>{statusLabel(session.status)}</span>
          {platform && <SourceBadge source={session.source} label={platform} />}
          {where && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-3.5" aria-hidden="true" />
              {where}
            </span>
          )}
        </p>
      </header>

      {session.summary ? (
        <section aria-label="Resumen" className="space-y-3">
          <p className="text-body-lg">{session.summary.summary}</p>
          <Bullets
            title="Quedó pendiente"
            items={session.summary.openQuestions}
          />
          <Bullets
            title="Salieron estos temas"
            items={session.summary.raised}
          />
        </section>
      ) : (
        <Empty>
          {session.status === 'active'
            ? 'La conversación sigue en curso. El resumen se escribe al terminar.'
            : 'Esta conversación no tiene resumen.'}
        </Empty>
      )}

      <section className="space-y-2">
        <h4 className="text-body font-medium">Transcripción</h4>
        <Conversation
          source={{ kind: 'session', id: session.id }}
          emptyText="No hay intervenciones guardadas. Escribile a Ether para hablar de esta conversación."
        />
      </section>
    </article>
  )
}

/** Loads the detail of the selected session. "Loading" is derived: results carry the id they belong to. */
function useSessionDetail(
  selected: string | null,
): Load<SessionDetailData | null> {
  const [loaded, setLoaded] = useState<{
    id: string
    result: Load<SessionDetailData | null>
  } | null>(null)

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    fetchSession(selected).then(
      (data) =>
        !cancelled &&
        setLoaded({ id: selected, result: { state: 'ready', data } }),
      (err) =>
        !cancelled &&
        setLoaded({
          id: selected,
          result: { state: 'error', message: message(err) },
        }),
    )
    return () => {
      cancelled = true
    }
  }, [selected])

  return loaded && loaded.id === selected ? loaded.result : { state: 'loading' }
}

/** Loads the list for a filter; `reload` shows the loading line again. */
function useSessionList(filter: Filter) {
  const [list, setList] = useState<Load<SessionSummaryRow[]>>({
    state: 'loading',
  })
  const load = useCallback(() => {
    fetchSessions(filter === 'journal' ? JOURNAL_SOURCE : undefined).then(
      (data) => setList({ state: 'ready', data }),
      (err) => setList({ state: 'error', message: message(err) }),
    )
  }, [filter])
  useEffect(load, [load])
  const reload = () => {
    setList({ state: 'loading' })
    load()
  }
  return { list, reload, showLoading: () => setList({ state: 'loading' }) }
}

/** Right-hand side: nothing picked, loading, error, gone, or the session. */
function DetailPane({
  selected,
  detail,
}: {
  selected: string | null
  detail: Load<SessionDetailData | null>
}) {
  if (!selected) {
    return (
      <p className="flex items-start gap-3 text-body-lg text-muted">
        <History className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        Elige una conversación para ver el detalle.
      </p>
    )
  }
  if (detail.state === 'loading') {
    return <p className="text-body text-muted">Cargando…</p>
  }
  if (detail.state === 'error') return <ErrorLine text={detail.message} />
  if (detail.data === null)
    return <Empty>Esta conversación ya no existe.</Empty>
  return <SessionDetail session={detail.data} />
}

const EMPTY_TEXT: Record<Filter, string> = {
  all: 'Todavía no hay conversaciones guardadas. Cuando termines una llamada aparecerá aquí.',
  journal:
    'Todavía no hay diarios guardados. Cuando termines uno aparecerá aquí.',
}

export function SessionsScreen() {
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const { list, reload, showLoading } = useSessionList(filter)
  const detail = useSessionDetail(selected)

  const changeFilter = (next: Filter) => {
    if (next === filter) return
    showLoading()
    setSelected(null)
    setFilter(next)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <SectionTitle
          title="Sesiones"
          description="El historial de conversaciones, con su resumen y su transcripción."
        />
        <Button variant="ghost" onClick={reload} aria-label="Actualizar">
          <RefreshCw className="size-4" aria-hidden="true" />
        </Button>
      </div>

      <FilterTabs value={filter} onChange={changeFilter} />

      {list.state === 'error' && <ErrorLine text={list.message} />}
      {list.state === 'loading' && (
        <p className="text-body text-muted" aria-live="polite">
          Cargando…
        </p>
      )}
      {list.state === 'ready' && list.data.length === 0 && (
        <Empty>{EMPTY_TEXT[filter]}</Empty>
      )}

      {list.state === 'ready' && list.data.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <ul aria-label="Conversaciones" className="space-y-2">
            {list.data.map((row) => (
              <SessionRow
                key={row.id}
                row={row}
                selected={row.id === selected}
                onSelect={() => setSelected(row.id)}
              />
            ))}
          </ul>
          <aside aria-label="Detalle" aria-live="polite">
            <DetailPane selected={selected} detail={detail} />
          </aside>
        </div>
      )}
    </div>
  )
}
