import { useState } from 'react'
import { Field, SectionTitle, inputClass } from '@/app/ui'
import { useLoadedPrefs } from '@/app/prefsContext'
import { SaveBar } from '../SaveBar'
import { useAreaSave } from '../useAreaSave'
import { collect, validateEndOfTurn, validateUnit } from '../validation'

function Slider({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string
  label: string
  hint: string
  value: number
  onChange: (next: number) => void
}) {
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <div className="flex items-center gap-3">
        <input
          id={id}
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-describedby={`${id}-hint`}
          className="h-10 min-w-0 flex-1 accent-(--accent)"
        />
        <output
          htmlFor={id}
          className="w-12 text-right font-mono text-body-lg tabular-nums"
        >
          {value.toFixed(2)}
        </output>
      </div>
    </Field>
  )
}

export function DecisionsArea() {
  const { prefs } = useLoadedPrefs()
  const t = prefs.thresholds
  const [respond, setRespond] = useState(t.respondConfidence)
  const [vad, setVad] = useState(t.vadSensitivity)
  const [endMs, setEndMs] = useState(String(t.endOfTurnMs))

  const endValue = endMs.trim() === '' ? Number.NaN : Number(endMs)
  const issues = collect([
    ['respond', validateUnit('La confianza para responder', respond)],
    ['vad', validateUnit('La sensibilidad de voz', vad)],
    ['end', validateEndOfTurn(endValue)],
  ])
  const { save, state, shownIssues, dirty } = useAreaSave(issues, () => ({
    thresholds: {
      respondConfidence: respond,
      vadSensitivity: vad,
      endOfTurnMs: endValue,
    },
  }))
  const endError = issues.find((i) => i.field === 'end')?.message ?? null

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
        title="Decisiones"
        description="Cuándo el asistente escucha, espera y responde."
      />

      <Slider
        id="respond"
        label="Confianza para responder"
        hint="Más alto: responde solo cuando está muy seguro de que le hablas."
        value={respond}
        onChange={(v) => {
          setRespond(v)
          dirty()
        }}
      />
      <Slider
        id="vad"
        label="Sensibilidad de voz"
        hint="Más alto: detecta voz más baja, pero también más ruido."
        value={vad}
        onChange={(v) => {
          setVad(v)
          dirty()
        }}
      />
      <Field
        label="Silencio para cerrar tu turno (ms)"
        htmlFor="end-ms"
        hint="Entre 200 y 3000. Más alto: espera más antes de responder."
        error={endError}
      >
        <input
          id="end-ms"
          className={`${inputClass} font-mono`}
          value={endMs}
          onChange={(e) => {
            setEndMs(e.target.value)
            dirty()
          }}
          inputMode="numeric"
          aria-invalid={endError ? true : undefined}
          aria-describedby={endError ? 'end-ms-error' : 'end-ms-hint'}
        />
      </Field>

      <SaveBar issues={shownIssues} state={state} onSave={() => void save()} />
    </form>
  )
}
