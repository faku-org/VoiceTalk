import { useState } from 'react'
import { Field, SectionTitle, Switch, inputClass } from '@/app/ui'
import { useLoadedPrefs } from '@/app/prefsContext'
import { SaveBar } from '../SaveBar'
import { useAreaSave } from '../useAreaSave'
import { collect, validateLocation } from '../validation'

export function LocationArea() {
  const { prefs } = useLoadedPrefs()
  const [manual, setManual] = useState(prefs.location.manual)
  const [ip, setIp] = useState(prefs.location.ipGeolocation)

  const issues = collect([['manual', validateLocation(manual)]])
  const { save, state, shownIssues, dirty } = useAreaSave(issues, () => ({
    location: { manual: manual.trim(), ipGeolocation: ip },
  }))
  const manualError = issues[0]?.message ?? null

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
        title="Ubicación"
        description="Sirve para preguntas como el clima o la hora local."
      />

      <Field
        label="Ubicación"
        htmlFor="location"
        hint="Por ejemplo: Montevideo, Uruguay."
        error={manualError}
      >
        <input
          id="location"
          className={inputClass}
          value={manual}
          onChange={(e) => {
            setManual(e.target.value)
            dirty()
          }}
          aria-invalid={manualError ? true : undefined}
          aria-describedby={manualError ? 'location-error' : 'location-hint'}
        />
      </Field>

      <div className="flex items-start justify-between gap-4">
        <div>
          <p id="ip-geo-label" className="text-body-lg font-medium">
            Estimar la ubicación por IP
          </p>
          <p className="mt-1 text-meta text-muted">
            Desactivado por defecto. Si lo activas, se consulta un servicio
            externo con tu dirección IP; la ubicación escrita arriba tiene
            prioridad.
          </p>
        </div>
        <Switch
          checked={ip}
          labelledBy="ip-geo-label"
          onChange={(next) => {
            setIp(next)
            dirty()
          }}
        />
      </div>

      <SaveBar issues={shownIssues} state={state} onSave={() => void save()} />
    </form>
  )
}
