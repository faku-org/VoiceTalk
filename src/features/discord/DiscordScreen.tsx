import { useEffect, useState } from 'react'
import {
  CircleDot,
  ExternalLink,
  LoaderCircle,
  TriangleAlert,
} from 'lucide-react'
import { Button, SectionTitle, Switch, inputClass } from '@/app/ui'
import {
  fetchDiscordGuilds,
  joinDiscord,
  leaveDiscord,
  setDiscordTalk,
  type DiscordGuild,
  type DiscordStatus,
} from './api'
import type { DiscordStatusHandle } from './useDiscordStatus'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 text-body text-danger">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {text}
    </p>
  )
}

function Picker({
  status,
  refresh,
}: {
  status: DiscordStatus
  refresh: () => Promise<void>
}) {
  const [guilds, setGuilds] = useState<DiscordGuild[] | null>(null)
  const [guildId, setGuildId] = useState('')
  const [channelId, setChannelId] = useState('')
  const [talk, setTalk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchDiscordGuilds()
      .then((g) => {
        if (cancelled) return
        setGuilds(g)
        setGuildId((prev) => prev || g[0]?.id || '')
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const channels = guilds?.find((g) => g.id === guildId)?.voiceChannels ?? []
  const channel = channels.some((c) => c.id === channelId)
    ? channelId
    : (channels[0]?.id ?? '')

  const join = async () => {
    setBusy(true)
    setError(null)
    try {
      await joinDiscord(guildId, channel, talk && status.canTalk)
      await refresh()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  if (guilds && guilds.length === 0)
    return (
      <p className="text-body-lg text-muted">
        El bot no está en ningún servidor. Invítalo con el enlace de arriba y
        vuelve acá.
      </p>
    )

  return (
    <div className="flex max-w-md flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-body font-medium">
        Servidor
        <select
          className={inputClass}
          value={guildId}
          onChange={(e) => setGuildId(e.target.value)}
          disabled={!guilds}
        >
          {(guilds ?? []).map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1.5 text-body font-medium">
        Canal de voz
        <select
          className={inputClass}
          value={channel}
          onChange={(e) => setChannelId(e.target.value)}
          disabled={channels.length === 0}
        >
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center justify-between gap-4">
        <div>
          <p id="discord-talk-new" className="text-body-lg font-medium">
            Responder por voz
          </p>
          <p className="text-body text-muted">
            {status.canTalk
              ? `Solo cuando lo nombran (${status.names.join(', ') || 'su nombre'}).`
              : 'Falta la clave de la voz elegida.'}
          </p>
        </div>
        <Switch
          checked={talk && status.canTalk}
          onChange={(next) => status.canTalk && setTalk(next)}
          labelledBy="discord-talk-new"
        />
      </div>
      <p className="text-body text-muted">
        Al entrar, el bot avisa en el chat del canal que está transcribiendo.
      </p>
      {error && <ErrorLine text={error} />}
      <Button
        variant="primary"
        onClick={() => void join()}
        disabled={busy || !channel}
        aria-busy={busy}
        className="self-start"
      >
        {busy && (
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        )}
        Entrar al canal
      </Button>
    </div>
  )
}

function Active({
  status,
  refresh,
}: {
  status: DiscordStatus
  refresh: () => Promise<void>
}) {
  const session = status.session
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!session) return null

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      await refresh()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex max-w-md flex-col gap-4">
      <p className="flex items-center gap-2 text-body-lg font-medium text-danger">
        <CircleDot className="size-4" aria-hidden="true" />
        Transcribiendo {session.channelName} · {session.guildName}
      </p>
      <div>
        <p className="text-body font-medium">Quién habló</p>
        <p className="text-body-lg text-muted">
          {session.speakers.length > 0
            ? session.speakers.join(', ')
            : 'Todavía nadie.'}
        </p>
      </div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <p id="discord-talk-live" className="text-body-lg font-medium">
            Responder por voz
          </p>
          <p className="text-body text-muted">
            {status.canTalk
              ? 'Se corta apenas alguien empieza a hablar.'
              : 'Falta la clave de la voz elegida.'}
          </p>
        </div>
        <Switch
          checked={session.talk}
          onChange={(next) => void run(() => setDiscordTalk(next))}
          labelledBy="discord-talk-live"
        />
      </div>
      {error && <ErrorLine text={error} />}
      <Button
        onClick={() => void run(leaveDiscord)}
        disabled={busy}
        aria-busy={busy}
        className="self-start"
      >
        Salir y cerrar la sesión
      </Button>
    </div>
  )
}

export function DiscordScreen({ handle }: { handle: DiscordStatusHandle }) {
  const { status, error, refresh } = handle

  return (
    <div className="flex flex-col gap-6">
      <SectionTitle
        title="Discord"
        description="VoiceTalk entra a un canal de voz como bot, transcribe a cada persona con su nombre y guarda la sesión."
      />
      {error && !status && <ErrorLine text={error} />}
      {!status && !error && (
        <p className="flex items-center gap-2 text-body text-muted">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          Consultando el bot…
        </p>
      )}
      {status && (
        <>
          {status.inviteUrl && (
            <a
              href={status.inviteUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 self-start text-body-lg font-medium text-accent hover:underline"
            >
              Invitar al bot a un servidor
              <ExternalLink className="size-4" aria-hidden="true" />
            </a>
          )}
          {status.state === 'connecting' && (
            <p className="flex items-center gap-2 text-body text-muted">
              <LoaderCircle
                className="size-4 animate-spin"
                aria-hidden="true"
              />
              Conectando con Discord…
            </p>
          )}
          {status.state === 'error' && (
            <ErrorLine
              text={`No se pudo iniciar el bot${status.error ? `: ${status.error}` : '.'}`}
            />
          )}
          {status.state === 'ready' &&
            (status.session ? (
              <Active status={status} refresh={refresh} />
            ) : (
              <Picker status={status} refresh={refresh} />
            ))}
        </>
      )}
    </div>
  )
}
