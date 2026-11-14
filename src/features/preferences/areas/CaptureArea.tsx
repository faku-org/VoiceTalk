import { useState } from 'react'
import { Mic, Scale } from 'lucide-react'
import { Field, SectionTitle, Switch, inputClass } from '@/app/ui'
import type { DetectRule, DetectRuleEntry } from '@/app/prefsTypes'
import { PLATFORMS, ruleFor, withRule } from '@/features/capture/protocol'
import { useLoadedPrefs } from '@/app/prefsContext'
import { SaveBar } from '../SaveBar'
import { useAreaSave } from '../useAreaSave'
import { collect, validateCaptureConsent } from '../validation'

export function CaptureArea() {
  const { prefs } = useLoadedPrefs()
  const [enabled, setEnabled] = useState(prefs.capture.enabled)
  const [ack, setAck] = useState(prefs.capture.consentAck)
  const [detect, setDetect] = useState(prefs.capture.detect.enabled)
  const [rules, setRules] = useState<DetectRuleEntry[]>(
    prefs.capture.detect.rules,
  )
  const [nativeMic, setNativeMic] = useState(prefs.capture.nativeMic)

  // Turning capture on without reading the notice is the one thing the form refuses.
  const issues = collect([['consent', validateCaptureConsent(enabled, ack)]])
  const { save, state, shownIssues, dirty } = useAreaSave(issues, () => ({
    capture: {
      enabled,
      consentAck: ack,
      detect: { enabled: detect, rules },
      nativeMic,
    },
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

      <div className="flex items-start justify-between gap-4">
        <div>
          <p id="capture-detect-label" className="text-body-lg font-medium">
            Preguntar al detectar una llamada
          </p>
          <p className="mt-1 text-meta text-muted">
            Cuando abrís una llamada en otra aplicación, VoiceTalk pregunta si
            querés que la anote. Nunca graba sin tu confirmación.
          </p>
        </div>
        <Switch
          checked={detect}
          labelledBy="capture-detect-label"
          onChange={(next) => {
            setDetect(next)
            dirty()
          }}
        />
      </div>

      {detect && (
        <fieldset className="space-y-3 rounded-panel border border-border p-4">
          <legend className="px-1 text-body-lg font-medium">
            Qué hacer en cada plataforma
          </legend>
          {PLATFORMS.filter((p) => p.key !== 'other').map((p) => (
            <Field
              key={p.key}
              label={p.label}
              htmlFor={`capture-rule-${p.key}`}
            >
              <select
                id={`capture-rule-${p.key}`}
                className={inputClass}
                value={ruleFor(rules, p.key)}
                onChange={(e) => {
                  setRules(withRule(rules, p.key, e.target.value as DetectRule))
                  dirty()
                }}
              >
                <option value="ask">Preguntar</option>
                <option value="always">Anotar siempre</option>
                <option value="never">No preguntar nunca</option>
              </select>
            </Field>
          ))}
        </fieldset>
      )}

      <div className="flex items-start justify-between gap-4">
        <div>
          <p
            id="capture-native-mic-label"
            className="flex items-center gap-2 text-body-lg font-medium"
          >
            <Mic className="size-4" aria-hidden="true" />
            Micrófono con cancelación de eco
          </p>
          <p className="mt-1 text-meta text-muted">
            En las llamadas con VoiceTalk, usa el micrófono nativo y resta el
            audio que suena en tus altavoces, además de reducir el ruido de
            fondo. Si no se puede abrir, la llamada usa el micrófono del
            navegador como antes.
          </p>
        </div>
        <Switch
          checked={nativeMic}
          labelledBy="capture-native-mic-label"
          onChange={(next) => {
            setNativeMic(next)
            dirty()
          }}
        />
      </div>

      <SaveBar issues={shownIssues} state={state} onSave={() => void save()} />
    </form>
  )
}
