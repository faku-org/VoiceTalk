import { useState } from 'react'
import { Cpu, CircleCheck, CircleX, Zap, type LucideIcon } from 'lucide-react'
import { Field, SectionTitle, inputClass } from '@/app/ui'
import { useLoadedPrefs } from '@/app/prefsContext'
import type { Brain, SttModel, TtsProvider, TtsVoices } from '@/app/prefsTypes'
import { SaveBar } from '../SaveBar'
import { useAreaSave } from '../useAreaSave'
import { collect, validateLlmUrl, validateVoiceId } from '../validation'
import { VoiceField } from './VoiceField'

const BRAINS: ReadonlyArray<{ id: Brain; label: string; hint: string }> = [
  {
    id: 'local',
    label: 'Local',
    hint: 'El modelo corre en este equipo. No sale nada a internet.',
  },
  {
    id: 'claude',
    label: 'Claude',
    hint: 'Usa Claude en la nube. Requiere una clave configurada.',
  },
]

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
  const [brain, setBrain] = useState<Brain>(prefs.brain)
  const [stt, setStt] = useState<SttModel>(prefs.stt)
  const [llmUrl, setLlmUrl] = useState(prefs.llmUrl)
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>(
    prefs.tts.provider,
  )
  const [voices, setVoices] = useState<TtsVoices>(prefs.tts.voices)

  const issues = collect([
    ['llmUrl', brain === 'local' ? validateLlmUrl(llmUrl) : null],
    ['voiceId', validateVoiceId(voices[ttsProvider])],
  ])
  const { save, state, shownIssues, dirty } = useAreaSave(issues, () => ({
    brain,
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
  const urlError = issues.find((i) => i.field === 'llmUrl')?.message ?? null
  const voiceError = issues.find((i) => i.field === 'voiceId')?.message ?? null

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
        description="Cerebro que responde, reconocimiento de lo que dices y voz con la que habla."
      />

      <fieldset className="space-y-2">
        <legend className="text-body-lg font-medium">Cerebro</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {BRAINS.map((option) => {
            const active = brain === option.id
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
                    name="brain"
                    value={option.id}
                    checked={active}
                    onChange={() => {
                      setBrain(option.id)
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

      <fieldset className="space-y-2">
        <legend className="text-body-lg font-medium">
          Reconocimiento de voz
        </legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {STT_MODELS.map((option) => {
            const active = stt === option.id
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

      {brain === 'local' && (
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

      <div className="space-y-2">
        <h3 className="text-body-lg font-medium">Claves</h3>
        <ul className="space-y-1">
          <KeyLine
            label="Cartesia (voz)"
            present={keyStatus?.cartesia ?? false}
          />
          <KeyLine label="xAI (voz)" present={keyStatus?.xai ?? false} />
          <KeyLine
            label="Anthropic (Claude)"
            present={keyStatus?.anthropic ?? false}
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
