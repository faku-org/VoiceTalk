import { useCallback, useEffect, useState } from 'react'
import { CircleAlert, History, MapPin, RefreshCw } from 'lucide-react'
import { Button, SectionTitle } from '@/app/ui'
import {
  fetchSession,
  fetchSessions,
  type SessionDetailData,
  type SessionSummaryRow,
} from './api'
import {
  formatDuration,
  formatOffset,
  formatStarted,
  sessionLabel,
  speakerLabel,
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
          {formatStarted(row.startedAt)}
          {duration ? ` · ${duration}` : ''} · {statusLabel(row.status)}
        </span>
      </button>
    </li>
  )
}

function SessionDetail({ session }: { session: SessionDetailData }) {
  const duration = formatDuration(session.startedAt, session.endedAt)
  const where = session.location.trim()
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

      <section aria-label="Transcripción" className="space-y-2">
        <h4 className="text-body font-medium">Transcripción</h4>
        {session.utterances.length === 0 ? (
          <Empty>No hay intervenciones guardadas.</Empty>
        ) : (
          <ul className="space-y-2">
            {session.utterances.map((u) => (
              <li
                key={u.id}
                className={`max-w-[85%] rounded-panel border border-border px-3.5 py-2 text-body ${
                  u.speaker === 'user'
                    ? 'ml-auto bg-surface'
                    : 'mr-auto bg-surface-2'
                }`}
              >
                <span className="mb-0.5 flex justify-between gap-4 text-meta text-muted">
                  <span>{speakerLabel(u.speaker)}</span>
                  <span className="tabular-nums">
                    {formatOffset(session.startedAt, u.tStart)}
                  </span>
                </span>
                {u.text}
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  )
}

export function SessionsScreen() {
  const [list, setList] = useState<Load<SessionSummaryRow[]>>({
    state: 'loading',
  })
  const [selected, setSelected] = useState<string | null>(null)
  // Detail results carry the id they belong to: "loading" is derived (no setState inside the effect).
  const [loaded, setLoaded] = useState<{
    id: string
    result: Load<SessionDetailData | null>
  } | null>(null)

  const load = useCallback(() => {
    fetchSessions().then(
      (data) => setList({ state: 'ready', data }),
      (err) => setList({ state: 'error', message: message(err) }),
    )
  }, [])

  const reload = () => {
    setList({ state: 'loading' })
    load()
  }

  useEffect(load, [load])

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

  const detail: Load<SessionDetailData | null> =
    loaded && loaded.id === selected ? loaded.result : { state: 'loading' }

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

      {list.state === 'error' && <ErrorLine text={list.message} />}
      {list.state === 'loading' && (
        <p className="text-body text-muted" aria-live="polite">
          Cargando…
        </p>
      )}
      {list.state === 'ready' && list.data.length === 0 && (
        <Empty>
          Todavía no hay conversaciones guardadas. Cuando termines una llamada
          aparecerá aquí.
        </Empty>
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
            {!selected && (
              <p className="flex items-start gap-3 text-body-lg text-muted">
                <History
                  className="mt-0.5 size-5 shrink-0"
                  aria-hidden="true"
                />
                Elige una conversación para ver el detalle.
              </p>
            )}
            {selected && detail.state === 'loading' && (
              <p className="text-body text-muted">Cargando…</p>
            )}
            {selected && detail.state === 'error' && (
              <ErrorLine text={detail.message} />
            )}
            {selected && detail.state === 'ready' && detail.data === null && (
              <Empty>Esta conversación ya no existe.</Empty>
            )}
            {selected && detail.state === 'ready' && detail.data && (
              <SessionDetail session={detail.data} />
            )}
          </aside>
        </div>
      )}
    </div>
  )
}
