import { useState } from 'react'
import {
  Bot,
  Cloud,
  Cpu,
  CircleCheck,
  CircleX,
  HardDrive,
  Plug,
  Rocket,
  Server,
  Sparkles,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { Field, SectionTitle, inputClass } from '@/app/ui'
import { useLoadedPrefs } from '@/app/prefsContext'
import {
  EFFORTS,
  PROVIDERS,
  STYLES,
  SYSTEM_PROMPT_MAX,
  providerInfo,
} from '@/app/brainPresets'
import type {
  BrainEffort,
  BrainProvider,
  BrainStyle,
  SttModel,
  TtsProvider,
  TtsVoices,
} from '@/app/prefsTypes'
import { SaveBar } from '../SaveBar'
import { useAreaSave } from '../useAreaSave'
import {
  collect,
  validateBrainEndpoint,
  validateAgentProfile,
  validateBrainModel,
  validateLlmUrl,
  validateSystemPrompt,
  validateVoiceId,
} from '../validation'
import { AgentField, type AgentDraft } from './AgentField'
import { VoiceField } from './VoiceField'

const PROVIDER_ICONS: Record<BrainProvider, LucideIcon> = {
  local: HardDrive,
  ollama: Server,
  claude: Sparkles,
  openai: Bot,
  xai: Rocket,
  custom: Plug,
}

const choiceClass = (active: boolean) =>
  `flex cursor-pointer flex-col gap-1 rounded-card border p-4 transition-colors duration-(--dur-fast) ${
    active
      ? 'border-accent bg-accent/10'
      : 'border-border bg-surface hover:bg-surface-2'
  }`

const STT_MODELS: ReadonlyArray<{
  id: SttModel
  label: string
  runsOn: string
  Icon: LucideIcon
  hint: string
}> = [
  {
    id: 'phonon',
    label: 'Phonon-2.5',
    runsOn: 'CPU · 156 MB · recomendado',
    Icon: Cpu,
    hint: 'Detecta el idioma y responde rápido.',
  },
  {
    id: 'canary',
    label: 'Canary 180M',
    runsOn: 'CPU',
    Icon: Cpu,
    hint: 'Fuerza español. Acierta más en palabras cortas.',
  },
  {
    id: 'fluid',
    label: 'Fluid Speech Pro',
    runsOn: 'GPU',
    Icon: Zap,
    hint: 'El modelo anterior.',
  },
]

function KeyLine({ label, present }: { label: string; present: boolean }) {
  const Icon = present ? CircleCheck : CircleX
  return (
    <li className="flex items-center gap-2 text-body-lg">
      <Icon
        className={`size-4 ${present ? 'text-success' : 'text-muted'}`}
        aria-hidden="true"
      />
      <span>{label}:</span>
      <span className={present ? 'text-success' : 'text-muted'}>
        {present ? 'configurada' : 'no configurada'}
      </span>
    </li>
  )
}

export function AssistantArea() {
  const { prefs, keyStatus } = useLoadedPrefs()
  const [provider, setProvider] = useState<BrainProvider>(prefs.brain.provider)
  const [model, setModel] = useState(prefs.brain.model)
  const [baseUrl, setBaseUrl] = useState(prefs.brain.baseUrl)
  const [effort, setEffort] = useState<BrainEffort>(prefs.brain.effort)
  const [style, setStyle] = useState<BrainStyle>(prefs.brain.style)
  const [systemPrompt, setSystemPrompt] = useState(prefs.brain.systemPrompt)
  const [stt, setStt] = useState<SttModel>(prefs.stt)
  const [llmUrl, setLlmUrl] = useState(prefs.llmUrl)
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>(
    prefs.tts.provider,
  )
  const [voices, setVoices] = useState<TtsVoices>(prefs.tts.voices)
  const [agent, setAgent] = useState<AgentDraft>(prefs.agent)

  const info = providerInfo(provider)
  const issues = collect([
    ['llmUrl', provider === 'local' ? validateLlmUrl(llmUrl) : null],
    [
      'baseUrl',
      info.endpoint === 'none'
        ? null
        : validateBrainEndpoint(baseUrl, info.endpoint === 'required'),
    ],
    ['model', validateBrainModel(model)],
    ['systemPrompt', validateSystemPrompt(systemPrompt, SYSTEM_PROMPT_MAX)],
    ['voiceId', validateVoiceId(voices[ttsProvider])],
    ['agentUrl', validateLlmUrl(agent.url)],
    ['agentProfile', validateAgentProfile(agent.profile)],
    ['agentModel', validateBrainModel(agent.model)],
  ])
  const { save, state, shownIssues, dirty } = useAreaSave(issues, () => ({
    brain: {
      provider,
      model: model.trim(),
      // A stale endpoint would override the preset's own address in core.
      baseUrl: info.endpoint === 'none' ? '' : baseUrl.trim(),
      effort,
      style,
      systemPrompt,
    },
    agent: {
      enabled: agent.enabled,
      url: agent.url.trim(),
      profile: agent.profile.trim(),
      model: agent.model.trim(),
    },
    stt,
    llmUrl: llmUrl.trim(),
    tts: {
      provider: ttsProvider,
      voices: {
        cartesia: voices.cartesia.trim(),
        xai: voices.xai.trim(),
      },
    },
  }))
  const errorOf = (field: string) =>
    issues.find((i) => i.field === field)?.message ?? null
  const urlError = errorOf('llmUrl')
  const baseUrlError = errorOf('baseUrl')
  const modelError = errorOf('model')
  const promptError = errorOf('systemPrompt')
  const voiceError = errorOf('voiceId')
  const keyReady = (field: NonNullable<typeof info.keyField>) =>
    keyStatus?.[field] ?? false

  return (
    <form
      className="max-w-xl space-y-6"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
      noValidate
    >
      <SectionTitle
        title="Asistente"
        description="Cerebro que responde, reconocimiento de lo que dices, voz con la que habla y agente que actúa en tu PC."
      />

      <fieldset className="space-y-2">
        <legend className="text-body-lg font-medium">Cerebro</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {PROVIDERS.map((option) => {
            const active = provider === option.id
            const Icon = PROVIDER_ICONS[option.id]
            const hasKey = option.keyField ? keyReady(option.keyField) : null
            return (
              <label key={option.id} className={choiceClass(active)}>
                <span className="flex items-center gap-2 text-body-lg font-medium">
                  <input
                    type="radio"
                    name="brain-provider"
                    value={option.id}
                    checked={active}
                    onChange={() => {
                      setProvider(option.id)
                      // Model ids differ per provider: back to its default.
                      setModel('')
                      dirty()
                    }}
                    className="accent-(--accent)"
                  />
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  {option.label}
                </span>
                <span className="text-meta text-muted">{option.hint}</span>
                {option.keyField && (
                  <span
                    className={`flex items-center gap-1.5 text-meta ${
                      hasKey ? 'text-success' : 'text-muted'
                    }`}
                  >
                    {hasKey ? (
                      <CircleCheck className="size-3.5" aria-hidden="true" />
                    ) : (
                      <CircleX className="size-3.5" aria-hidden="true" />
                    )}
                    {hasKey
                      ? 'Clave configurada'
                      : option.keyRequired
                        ? 'Falta la clave'
                        : 'Sin clave (opcional)'}
                  </span>
                )}
                {option.id === 'local' && (
                  <span className="flex items-center gap-1.5 text-meta text-muted">
                    <Cloud
                      className="size-3.5 shrink-0 opacity-40"
                      aria-hidden="true"
                    />
                    Sin conexión a internet
                  </span>
                )}
              </label>
            )
          })}
        </div>
        {info.keyRequired && !keyReady(info.keyField!) && (
          <p className="text-meta text-muted">
            Sin la clave {info.keyEnv} en el entorno del núcleo, las llamadas
            usan el modelo local.
          </p>
        )}
      </fieldset>

      {info.endpoint !== 'none' && (
        <Field
          label="Dirección del servidor"
          htmlFor="brain-base-url"
          hint={
            info.defaultEndpoint
              ? `Si la dejas vacía se usa ${info.defaultEndpoint}.`
              : 'Servidor compatible con la API de OpenAI, por ejemplo http://127.0.0.1:1234.'
          }
          error={baseUrlError}
        >
          <input
            id="brain-base-url"
            className={inputClass}
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value)
              dirty()
            }}
            placeholder={info.defaultEndpoint ?? 'https://'}
            aria-invalid={baseUrlError ? true : undefined}
            aria-describedby={
              baseUrlError ? 'brain-base-url-error' : 'brain-base-url-hint'
            }
            inputMode="url"
            spellCheck={false}
          />
        </Field>
      )}

      <Field
        label="Modelo"
        htmlFor="brain-model"
        hint={
          info.defaultModel
            ? `Si lo dejas vacío se usa ${info.defaultModel}.`
            : provider === 'local'
              ? 'Opcional. El servidor local usa el modelo que tiene cargado.'
              : 'Nombre del modelo tal como lo publica el servidor.'
        }
        error={modelError}
      >
        <input
          id="brain-model"
          className={`${inputClass} font-mono`}
          value={model}
          onChange={(e) => {
            setModel(e.target.value)
            dirty()
          }}
          placeholder={info.defaultModel ?? ''}
          aria-invalid={modelError ? true : undefined}
          aria-describedby={
            modelError ? 'brain-model-error' : 'brain-model-hint'
          }
          spellCheck={false}
        />
      </Field>

      <fieldset className="space-y-2">
        <legend className="text-body-lg font-medium">
          Esfuerzo de pensamiento
        </legend>
        <div
          role="radiogroup"
          aria-label="Esfuerzo de pensamiento"
          className="grid grid-cols-2 gap-1 rounded-control border border-border bg-surface p-1 sm:grid-cols-4"
        >
          {EFFORTS.map((option) => {
            const active = effort === option.id
            return (
              <label
                key={option.id}
                className={`flex h-9 cursor-pointer items-center justify-center rounded-control text-body-lg transition-colors duration-(--dur-fast) has-focus-visible:outline-2 has-focus-visible:outline-accent ${
                  active
                    ? 'bg-accent/15 font-medium text-text'
                    : 'text-muted hover:bg-surface-2'
                }`}
              >
                <input
                  type="radio"
                  name="brain-effort"
                  value={option.id}
                  checked={active}
                  onChange={() => {
                    setEffort(option.id)
                    dirty()
                  }}
                  className="sr-only"
                />
                {option.label}
              </label>
            )
          })}
        </div>
        <p className="text-meta text-muted">
          Más esfuerzo mejora el razonamiento, pero la respuesta tarda más. En
          una llamada conviene Sin pensar. Si el modelo no admite razonamiento,
          el ajuste no tiene efecto.
        </p>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-body-lg font-medium">Estilo</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {STYLES.map((option) => {
            const active = style === option.id
            return (
              <label key={option.id} className={choiceClass(active)}>
                <span className="flex items-center gap-2 text-body-lg font-medium">
                  <input
                    type="radio"
                    name="brain-style"
                    value={option.id}
                    checked={active}
                    onChange={() => {
                      setStyle(option.id)
                      dirty()
                    }}
                    className="accent-(--accent)"
                  />
                  {option.label}
                </span>
                <span className="text-meta text-muted">{option.hint}</span>
              </label>
            )
          })}
        </div>
      </fieldset>

      <Field
        label="Instrucciones propias"
        htmlFor="brain-system-prompt"
        hint="Se suman al estilo en cada respuesta. Por ejemplo: cómo quieres que te trate."
        error={promptError}
      >
        <textarea
          id="brain-system-prompt"
          className={`${inputClass} h-32 resize-y py-2`}
          value={systemPrompt}
          onChange={(e) => {
            setSystemPrompt(e.target.value)
            dirty()
          }}
          maxLength={SYSTEM_PROMPT_MAX + 200}
          aria-invalid={promptError ? true : undefined}
          aria-describedby={
            promptError
              ? 'brain-system-prompt-error'
              : 'brain-system-prompt-hint'
          }
        />
        <p className="text-right text-meta text-muted">
          {systemPrompt.length} / {SYSTEM_PROMPT_MAX}
        </p>
      </Field>

      <fieldset className="space-y-2">
        <legend className="text-body-lg font-medium">
          Reconocimiento de voz
        </legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {STT_MODELS.map((option) => {
            const active = stt === option.id
            return (
              <label key={option.id} className={choiceClass(active)}>
                <span className="flex items-center gap-2 text-body-lg font-medium">
                  <input
                    type="radio"
                    name="stt"
                    value={option.id}
                    checked={active}
                    onChange={() => {
                      setStt(option.id)
                      dirty()
                    }}
                    className="accent-(--accent)"
                  />
                  {option.label}
                </span>
                <span className="flex items-center gap-1.5 text-meta text-muted">
                  <option.Icon
                    className="size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  {option.runsOn}
                </span>
                <span className="text-meta text-muted">{option.hint}</span>
              </label>
            )
          })}
        </div>
        <p className="text-meta text-muted">
          El cambio se aplica en unos segundos: el modelo se carga en segundo
          plano y la llamada en curso no se corta.
        </p>
      </fieldset>

      {provider === 'local' && (
        <Field
          label="Dirección del modelo local"
          htmlFor="llm-url"
          hint="Servidor compatible con la API de OpenAI, por ejemplo llama.cpp."
          error={urlError}
        >
          <input
            id="llm-url"
            className={inputClass}
            value={llmUrl}
            onChange={(e) => {
              setLlmUrl(e.target.value)
              dirty()
            }}
            aria-invalid={urlError ? true : undefined}
            aria-describedby={urlError ? 'llm-url-error' : 'llm-url-hint'}
            inputMode="url"
            spellCheck={false}
          />
        </Field>
      )}

      <VoiceField
        provider={ttsProvider}
        voices={voices}
        error={voiceError}
        keyStatus={keyStatus}
        onProvider={(next) => {
          setTtsProvider(next)
          dirty()
        }}
        onVoice={(id, voiceId) => {
          setVoices((prev) => ({ ...prev, [id]: voiceId }))
          dirty()
        }}
      />

      <AgentField
        draft={agent}
        savedKey={prefs.agent}
        errors={{
          url: errorOf('agentUrl'),
          profile: errorOf('agentProfile'),
          model: errorOf('agentModel'),
        }}
        onChange={(next) => {
          setAgent((prev) => ({ ...prev, ...next }))
          dirty()
        }}
      />

      <div className="space-y-2">
        <h3 className="text-body-lg font-medium">Claves</h3>
        <ul className="space-y-1">
          <KeyLine
            label="Cartesia (voz)"
            present={keyStatus?.cartesia ?? false}
          />
          <KeyLine
            label="Anthropic (Claude)"
            present={keyStatus?.anthropic ?? false}
          />
          <KeyLine label="OpenAI" present={keyStatus?.openai ?? false} />
          <KeyLine label="xAI (Grok y voz)" present={keyStatus?.xai ?? false} />
          <KeyLine
            label="Servidor personalizado"
            present={keyStatus?.custom ?? false}
          />
        </ul>
        <p className="text-meta text-muted">
          Las claves se leen del entorno del núcleo; nunca se guardan en las
          preferencias ni llegan a esta ventana.
        </p>
      </div>

      <SaveBar issues={shownIssues} state={state} onSave={() => void save()} />
    </form>
  )
}
