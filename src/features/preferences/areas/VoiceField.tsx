import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Play, Square } from 'lucide-react'
import { Button, Field, inputClass } from '@/app/ui'
import { gql } from '@/app/coreClient'
import { PcmPlayer } from '@/audio/player'
import type {
  KeyStatus,
  TtsProvider,
  TtsProviderInfo,
  TtsVoices,
} from '@/app/prefsTypes'

const PROVIDERS_QUERY = `{ ttsProviders { id name keyEnv configured defaultVoice voices { id name hint } } }`
const PREVIEW_MUTATION = `mutation ($provider: TtsProvider!, $voiceId: String) {
  previewVoice(provider: $provider, voiceId: $voiceId) { sampleRate pcm }
}`
const CUSTOM = '__custom__'
const KEY_LABELS: Record<TtsProvider, keyof KeyStatus> = {
  cartesia: 'cartesia',
  xai: 'xai',
}

type PreviewState = 'idle' | 'loading' | 'playing'

function decodeBase64(value: string): ArrayBuffer {
  const bin = atob(value)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

export function VoiceField({
  provider,
  voices,
  error,
  keyStatus,
  onProvider,
  onVoice,
}: {
  provider: TtsProvider
  voices: TtsVoices
  error: string | null
  keyStatus: KeyStatus | null
  onProvider: (next: TtsProvider) => void
  onVoice: (provider: TtsProvider, voiceId: string) => void
}) {
  const [catalog, setCatalog] = useState<TtsProviderInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [customFor, setCustomFor] = useState<Record<string, boolean>>({})
  const [preview, setPreview] = useState<PreviewState>('idle')
  const [previewError, setPreviewError] = useState<string | null>(null)
  const player = useRef<PcmPlayer | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Ignores the answer of a preview that was stopped or replaced while it was loading.
  const run = useRef(0)

  useEffect(() => {
    let live = true
    gql<{ ttsProviders: TtsProviderInfo[] }>(PROVIDERS_QUERY)
      .then((data) => live && setCatalog(data.ttsProviders))
      .catch(() => live && setLoadError('No se pudo cargar la lista de voces.'))
    return () => {
      live = false
    }
  }, [])

  useEffect(
    () => () => {
      run.current++
      if (timer.current) clearTimeout(timer.current)
      void player.current?.close()
      player.current = null
    },
    [],
  )

  const info = catalog?.find((p) => p.id === provider) ?? null
  const voice = voices[provider]
  const known = info?.voices.some((v) => v.id === voice) ?? false
  const custom = customFor[provider] || (info !== null && !known)
  const configured = (id: TtsProvider): boolean =>
    keyStatus ? keyStatus[KEY_LABELS[id]] : false

  function stop(): void {
    run.current++
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    player.current?.flush()
    setPreview('idle')
  }

  async function play(): Promise<void> {
    const id = ++run.current
    setPreviewError(null)
    setPreview('loading')
    try {
      const data = await gql<{
        previewVoice: { sampleRate: number; pcm: string }
      }>(PREVIEW_MUTATION, { provider, voiceId: voice.trim() || null })
      if (id !== run.current) return
      player.current ??= new PcmPlayer()
      await player.current.prepare()
      if (id !== run.current) return
      player.current.push(decodeBase64(data.previewVoice.pcm))
      setPreview('playing')
      timer.current = setTimeout(
        () => {
          if (id === run.current) setPreview('idle')
        },
        player.current.queuedSeconds * 1000 + 150,
      )
    } catch (err) {
      if (id !== run.current) return
      setPreview('idle')
      setPreviewError(
        err instanceof Error && err.message
          ? err.message
          : 'No se pudo reproducir la muestra.',
      )
    }
  }

  return (
    <fieldset className="space-y-3">
      <legend className="text-body-lg font-medium">Voz</legend>

      <div className="grid gap-2 sm:grid-cols-2">
        {(catalog ?? []).map((option) => {
          const active = provider === option.id
          const ok = configured(option.id)
          return (
            <label
              key={option.id}
              className={`flex cursor-pointer flex-col gap-1 rounded-card border p-4 transition-colors duration-(--dur-fast) ${
                active
                  ? 'border-accent bg-accent/10'
                  : 'border-border bg-surface hover:bg-surface-2'
              }`}
            >
              <span className="flex items-center gap-2 text-body-lg font-medium">
                <input
                  type="radio"
                  name="tts-provider"
                  value={option.id}
                  checked={active}
                  onChange={() => {
                    stop()
                    onProvider(option.id)
                  }}
                  className="accent-(--accent)"
                />
                {option.name}
              </span>
              <span
                className={`text-meta ${ok ? 'text-success' : 'text-muted'}`}
              >
                {ok ? 'Clave configurada' : `Falta ${option.keyEnv}`}
              </span>
            </label>
          )
        })}
      </div>
      {!catalog && !loadError && (
        <p className="text-meta text-muted">Cargando voces…</p>
      )}
      {loadError && <p className="text-meta text-danger">{loadError}</p>}

      {info && (
        <Field
          label="Voz de este proveedor"
          htmlFor="voice-select"
          hint={
            custom
              ? `Identificador de la voz en ${info.name}.`
              : (info.voices.find((v) => v.id === voice)?.hint ?? '')
          }
          error={custom ? error : null}
        >
          <div className="flex flex-wrap items-center gap-2">
            <select
              id="voice-select"
              className={`${inputClass} min-w-0 flex-1`}
              value={custom ? CUSTOM : voice}
              onChange={(e) => {
                stop()
                if (e.target.value === CUSTOM) {
                  setCustomFor((prev) => ({ ...prev, [provider]: true }))
                  return
                }
                setCustomFor((prev) => ({ ...prev, [provider]: false }))
                onVoice(provider, e.target.value)
              }}
            >
              {info.voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
              <option value={CUSTOM}>Otra voz…</option>
            </select>
            {preview === 'playing' ? (
              <Button onClick={stop} aria-label="Detener la muestra">
                <Square className="size-4" aria-hidden="true" />
                Detener
              </Button>
            ) : (
              <Button
                onClick={() => void play()}
                disabled={preview === 'loading' || !configured(provider)}
                aria-busy={preview === 'loading' ? true : undefined}
                aria-label={`Escuchar una muestra de la voz de ${info.name}`}
              >
                {preview === 'loading' ? (
                  <LoaderCircle
                    className="size-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <Play className="size-4" aria-hidden="true" />
                )}
                Escuchar
              </Button>
            )}
          </div>
          {custom && (
            <input
              id="voice-id"
              className={`${inputClass} mt-2 font-mono`}
              value={voice}
              onChange={(e) => onVoice(provider, e.target.value)}
              aria-label="Identificador de la voz"
              aria-invalid={error ? true : undefined}
              spellCheck={false}
            />
          )}
        </Field>
      )}

      {previewError && (
        <p role="alert" className="text-meta text-danger">
          {previewError}
        </p>
      )}
      <p className="text-meta text-muted">
        La muestra usa la voz elegida aunque todavía no hayas guardado.
      </p>
    </fieldset>
  )
}
