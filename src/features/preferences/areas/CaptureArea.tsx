import { useState } from 'react'
import { Scale } from 'lucide-react'
import { SectionTitle, Switch } from '@/app/ui'
import { useLoadedPrefs } from '@/app/prefsContext'
import { SaveBar } from '../SaveBar'
import { useAreaSave } from '../useAreaSave'
import { collect, validateCaptureConsent } from '../validation'

export function CaptureArea() {
  const { prefs } = useLoadedPrefs()
  const [enabled, setEnabled] = useState(prefs.capture.enabled)
  const [ack, setAck] = useState(prefs.capture.consentAck)

  // Turning capture on without reading the notice is the one thing the form refuses.
  const issues = collect([['consent', validateCaptureConsent(enabled, ack)]])
  const { save, state, shownIssues, dirty } = useAreaSave(issues, () => ({
    capture: { enabled, consentAck: ack },
  }))

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
        title="Captura de llamadas"
        description="Permite escuchar llamadas de otras aplicaciones (Discord, Teams, Zoom, Slack, WhatsApp, el navegador) para guardarlas como sesiones."
      />

      <section
        aria-label="Aviso de consentimiento"
        className="space-y-2 rounded-panel border border-border p-4"
      >
        <h3 className="flex items-center gap-2 text-body-lg font-medium">
          <Scale className="size-4" aria-hidden="true" />
          Aviso
        </h3>
        <p className="text-body text-muted">
          Grabar o transcribir a otras personas puede requerir su
          consentimiento, según las leyes de tu país y las reglas de la
          plataforma. Avisa a quienes participen antes de capturar.
        </p>
        <p className="text-body text-muted">
          VoiceTalk solo escucha: no habla en la llamada. El audio se transcribe
          en este equipo y no se guarda; solo se conserva el texto. Mientras
          captura, la ventana muestra «Grabando llamada».
        </p>
      </section>

      <div className="flex items-start justify-between gap-4">
        <div>
          <p id="capture-ack-label" className="text-body-lg font-medium">
            Leí el aviso y me hago responsable
          </p>
          <p className="mt-1 text-meta text-muted">
            Se guarda en este equipo. Sin esto la captura no arranca.
          </p>
        </div>
        <Switch
          checked={ack}
          labelledBy="capture-ack-label"
          onChange={(next) => {
            setAck(next)
            dirty()
          }}
        />
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <p id="capture-enabled-label" className="text-body-lg font-medium">
            Activar la captura de llamadas
          </p>
          <p className="mt-1 text-meta text-muted">
            Desactivado por defecto. El administrador del equipo también puede
            apagarla con VT_CAPTURE=off.
          </p>
        </div>
        <Switch
          checked={enabled}
          labelledBy="capture-enabled-label"
          onChange={(next) => {
            setEnabled(next)
            dirty()
          }}
        />
      </div>

      <SaveBar issues={shownIssues} state={state} onSave={() => void save()} />
    </form>
  )
}
