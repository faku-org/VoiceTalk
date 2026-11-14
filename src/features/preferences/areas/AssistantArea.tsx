import { useState } from 'react'
import { CircleCheck, CircleX } from 'lucide-react'
import { Field, SectionTitle, inputClass } from '@/app/ui'
import { useLoadedPrefs } from '@/app/prefsContext'
import type { Brain } from '@/app/prefsTypes'
import { SaveBar } from '../SaveBar'
import { useAreaSave } from '../useAreaSave'
import { collect, validateLlmUrl, validateVoiceId } from '../validation'

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
  const [llmUrl, setLlmUrl] = useState(prefs.llmUrl)
  const [voiceId, setVoiceId] = useState(prefs.voiceId)

  const issues = collect([
    ['llmUrl', brain === 'local' ? validateLlmUrl(llmUrl) : null],
    ['voiceId', validateVoiceId(voiceId)],
  ])
  const { save, state, shownIssues, dirty } = useAreaSave(issues, () => ({
    brain,
    llmUrl: llmUrl.trim(),
    voiceId: voiceId.trim(),
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
        description="Qué modelo decide y responde, y con qué voz habla."
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

      <Field
        label="Voz"
        htmlFor="voice-id"
        hint="Identificador de la voz en Cartesia. Por defecto, Sofía."
        error={voiceError}
      >
        <input
          id="voice-id"
          className={`${inputClass} font-mono`}
          value={voiceId}
          onChange={(e) => {
            setVoiceId(e.target.value)
            dirty()
          }}
          aria-invalid={voiceError ? true : undefined}
          aria-describedby={voiceError ? 'voice-id-error' : 'voice-id-hint'}
          spellCheck={false}
        />
      </Field>

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
