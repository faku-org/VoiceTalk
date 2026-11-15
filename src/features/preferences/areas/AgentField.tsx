import { useEffect, useState } from 'react'
import { CircleCheck, CircleX, LoaderCircle } from 'lucide-react'
import { Field, Switch, inputClass } from '@/app/ui'
import { gql } from '@/app/coreClient'
import type { AgentProvider, AgentStatus } from '@/app/prefsTypes'

const STATUS_QUERY = `{ agentStatus { enabled hasKey online reason } }`

/** Both take image input and tools. Prices are USD per million tokens (input / output), from OpenRouter. */
const OPENROUTER_MODELS = [
  {
    id: 'meta/muse-ember',
    name: 'Muse Ember',
    hint: 'Predeterminado. USD 0,10 de entrada y 0,50 de salida por millón de tokens.',
  },
  {
    id: 'deepseek/deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    hint: 'Más barato. USD 0,051 de entrada y 0,203 de salida por millón de tokens.',
  },
] as const
const DEFAULT_OPENROUTER_MODEL = OPENROUTER_MODELS[0].id
const CUSTOM = '__custom__'

export const OPENROUTER_PRIVACY =
  'Las capturas de pantalla y tus pedidos al agente se envían a OpenRouter (sin retención de datos).'

export interface AgentDraft {
  enabled: boolean
  provider: AgentProvider
  url: string
  profile: string
  model: string
}

/** Live status of the saved settings. `null` while loading, `'error'` when core did not answer. */
function useAgentStatus(refreshKey: unknown): AgentStatus | null | 'error' {
  const [status, setStatus] = useState<AgentStatus | null | 'error'>(null)
  useEffect(() => {
    let live = true
    // The previous answer stays until the new one arrives: no flash of "comprobando" after each save.
    gql<{ agentStatus: AgentStatus }>(STATUS_QUERY)
      .then((data) => live && setStatus(data.agentStatus))
      .catch(() => live && setStatus('error'))
    return () => {
      live = false
    }
  }, [refreshKey])
  return status
}

function StatusLine({ status }: { status: AgentStatus | null | 'error' }) {
  if (status === null) {
    return (
      <p role="status" className="flex items-center gap-2 text-meta text-muted">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        Comprobando el agente
      </p>
    )
  }
  if (status === 'error') {
    return (
      <p role="status" className="flex items-center gap-2 text-meta text-muted">
        <CircleX className="size-4" aria-hidden="true" />
        No se pudo consultar el estado.
      </p>
    )
  }
  const Icon = status.online ? CircleCheck : CircleX
  return (
    <p
      role="status"
      className={`flex items-center gap-2 text-meta ${status.online ? 'text-success' : 'text-muted'}`}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {status.online ? 'Agente conectado' : (status.reason ?? 'Sin conexión')}
    </p>
  )
}

export function AgentField({
  draft,
  onChange,
  errors,
  /** Changes when the saved prefs change, so the status is asked again. */
  savedKey,
}: {
  draft: AgentDraft
  onChange: (next: Partial<AgentDraft>) => void
  errors: { url: string | null; profile: string | null; model: string | null }
  savedKey: unknown
}) {
  const status = useAgentStatus(savedKey)
  const [customChosen, setCustomChosen] = useState(false)
  const openrouter = draft.provider === 'openrouter'
  const preset = OPENROUTER_MODELS.find((m) => m.id === draft.model)
  const custom = openrouter && (customChosen || !preset)

  // Presets only mean something on OpenRouter: leaving it clears them, coming back restores the default.
  const changeProvider = (provider: AgentProvider) => {
    if (provider === draft.provider) return
    setCustomChosen(false)
    if (provider === 'local') {
      onChange({ provider, model: preset ? '' : draft.model })
    } else {
      onChange({ provider, model: draft.model || DEFAULT_OPENROUTER_MODEL })
    }
  }

  return (
    <fieldset className="space-y-4">
      <legend className="text-body-lg font-medium">Agente</legend>
      <p className="text-meta text-muted">
        Ether usa Hermes en esta PC para abrir apps, leer archivos y ejecutar
        comandos. Siempre te pide permiso antes de escribir, borrar, ejecutar o
        hacer clic.
      </p>

      <div className="flex items-start justify-between gap-4">
        <div>
          <p id="agent-enabled-label" className="text-body-lg font-medium">
            Activar el agente
          </p>
          <p className="mt-1 text-meta text-muted">
            Desactivado por defecto. Sin esto Ether solo conversa.
          </p>
        </div>
        <Switch
          checked={draft.enabled}
          labelledBy="agent-enabled-label"
          onChange={(enabled) => onChange({ enabled })}
        />
      </div>

      <Field
        label="Dirección de Hermes"
        htmlFor="agent-url"
        hint="API local del perfil, por ejemplo http://127.0.0.1:8650."
        error={errors.url}
      >
        <input
          id="agent-url"
          className={inputClass}
          value={draft.url}
          onChange={(e) => onChange({ url: e.target.value })}
          aria-invalid={errors.url ? true : undefined}
          aria-describedby={errors.url ? 'agent-url-error' : 'agent-url-hint'}
          inputMode="url"
          spellCheck={false}
        />
      </Field>

      <Field
        label="Perfil de Hermes"
        htmlFor="agent-profile"
        hint="Se crea con bun run agent:profile. El perfil default es personal y no se usa."
        error={errors.profile}
      >
        <input
          id="agent-profile"
          className={`${inputClass} font-mono`}
          value={draft.profile}
          onChange={(e) => onChange({ profile: e.target.value })}
          aria-invalid={errors.profile ? true : undefined}
          aria-describedby={
            errors.profile ? 'agent-profile-error' : 'agent-profile-hint'
          }
          spellCheck={false}
        />
      </Field>

      <Field
        label="Dónde corre el modelo"
        htmlFor="agent-provider"
        hint={
          openrouter
            ? 'OpenRouter. Necesita OPENROUTER_API_KEY y se configura con bun run agent:profile.'
            : 'Un servidor local en esta PC. Nada sale de ella; se configura con bun run agent:profile --provider local.'
        }
      >
        <select
          id="agent-provider"
          className={inputClass}
          value={draft.provider}
          onChange={(e) => changeProvider(e.target.value as AgentProvider)}
          aria-describedby="agent-provider-hint"
        >
          <option value="openrouter">OpenRouter</option>
          <option value="local">Local</option>
        </select>
      </Field>

      <p className={`text-meta ${openrouter ? 'text-review' : 'text-muted'}`}>
        {openrouter
          ? OPENROUTER_PRIVACY
          : 'El agente usa el modelo local: nada de lo que hace sale de esta PC.'}
      </p>

      {openrouter && (
        <Field
          label="Modelo de OpenRouter"
          htmlFor="agent-model-select"
          hint={
            custom
              ? 'Necesita imagen y herramientas. Identificador de OpenRouter, por ejemplo proveedor/modelo.'
              : (preset?.hint ?? '')
          }
        >
          <select
            id="agent-model-select"
            className={inputClass}
            value={custom ? CUSTOM : draft.model}
            onChange={(e) => {
              if (e.target.value === CUSTOM) {
                setCustomChosen(true)
                return
              }
              setCustomChosen(false)
              onChange({ model: e.target.value })
            }}
            aria-describedby="agent-model-select-hint"
          >
            {OPENROUTER_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
            <option value={CUSTOM}>Otro modelo…</option>
          </select>
        </Field>
      )}

      {(!openrouter || custom) && (
        <Field
          label={openrouter ? 'Identificador del modelo' : 'Modelo del agente'}
          htmlFor="agent-model"
          hint={
            openrouter
              ? 'Debe aceptar imagen y herramientas, o el agente no podrá usar la pantalla.'
              : 'Aparte del cerebro de la voz. Para usar la pantalla necesita un modelo con visión; vacío usa el del perfil.'
          }
          error={errors.model}
        >
          <input
            id="agent-model"
            className={`${inputClass} font-mono`}
            value={draft.model}
            onChange={(e) => onChange({ model: e.target.value })}
            aria-invalid={errors.model ? true : undefined}
            aria-describedby={
              errors.model ? 'agent-model-error' : 'agent-model-hint'
            }
            spellCheck={false}
          />
        </Field>
      )}

      <StatusLine status={status} />
    </fieldset>
  )
}
