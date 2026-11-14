import { useState } from 'react'
import { CircleCheck, Mic, MicOff, ShieldCheck, UserRound } from 'lucide-react'
import { Button, SectionTitle } from '@/app/ui'
import { useLoadedPrefs } from '@/app/prefsContext'
import { FolderList } from '@/features/preferences/FolderList'
import { ModelsPanel } from '@/features/preferences/ModelsPanel'
import { ThemePicker } from '@/features/preferences/ThemePicker'
import { useMicLevel } from './useMicLevel'

export function WelcomeStep() {
  return (
    <div className="space-y-5">
      <SectionTitle
        title="Bienvenido a VoiceTalk"
        description="Conversa con tu asistente por voz, con el reconocimiento de voz y las decisiones corriendo en este equipo."
      />
      <ul className="space-y-3 text-body-lg">
        <li className="flex items-start gap-3">
          <ShieldCheck
            className="mt-0.5 size-5 shrink-0 text-accent"
            aria-hidden="true"
          />
          Tu voz se transcribe en este equipo; el audio que grabas no sale de
          él.
        </li>
        <li className="flex items-start gap-3">
          <Mic
            className="mt-0.5 size-5 shrink-0 text-accent"
            aria-hidden="true"
          />
          Los próximos pasos configuran el micrófono, las carpetas que puede
          leer y los modelos.
        </li>
      </ul>
      <p className="text-body text-muted">
        Todo se puede cambiar después en Preferencias.
      </p>
    </div>
  )
}

export function MicrophoneStep() {
  const { state, level, passed, start } = useMicLevel()
  const listening = state.kind === 'listening'
  return (
    <div className="space-y-5">
      <SectionTitle
        title="Micrófono"
        description="Concede el permiso y habla un momento: la barra debe moverse."
      />

      <div
        role="meter"
        aria-label="Nivel del micrófono"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(level * 100)}
        className="h-3 overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className="h-full bg-accent"
          style={{ width: `${Math.round(level * 100)}%` }}
        />
      </div>

      <div aria-live="polite" className="min-h-6 text-body-lg">
        {state.kind === 'requesting' && (
          <p className="text-muted">Esperando el permiso…</p>
        )}
        {listening && !passed && (
          <p className="text-muted">Escuchando. Di algo en voz normal.</p>
        )}
        {listening && passed && (
          <p className="flex items-center gap-2 text-success">
            <CircleCheck className="size-4" aria-hidden="true" />
            El micrófono funciona.
          </p>
        )}
        {state.kind === 'denied' && (
          <p className="flex items-start gap-2 text-danger">
            <MicOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            El permiso fue rechazado. Habilítalo en la configuración de
            privacidad de Windows (Micrófono) y vuelve a probar.
          </p>
        )}
        {state.kind === 'error' && (
          <p className="text-danger">{state.message}</p>
        )}
      </div>

      <Button onClick={() => void start()}>
        <Mic className="size-4" aria-hidden="true" />
        {state.kind === 'idle' ? 'Probar micrófono' : 'Probar de nuevo'}
      </Button>
    </div>
  )
}

export function FoldersStep() {
  const { prefs, update } = useLoadedPrefs()
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="space-y-5">
      <SectionTitle
        title="Carpetas permitidas"
        description="El asistente solo puede leer las carpetas que elijas aquí. Puedes omitir este paso."
      />
      <FolderList
        folders={prefs.folders}
        onChange={(folders) => {
          setError(null)
          void update({ folders }).then(setError)
        }}
      />
      <p aria-live="polite" className="text-body-lg text-danger">
        {error}
      </p>
    </div>
  )
}

export function ModelsStep() {
  return (
    <div className="space-y-5">
      <SectionTitle
        title="Modelos"
        description="Estos modelos corren en tu equipo. Aquí ves si ya están disponibles."
      />
      <ModelsPanel />
    </div>
  )
}

export function VoiceStep() {
  return (
    <div className="space-y-5">
      <SectionTitle
        title="Tu voz"
        description="Registrar tu voz permitirá distinguirte de otras personas en la sala."
      />
      <p className="flex items-start gap-3 text-body-lg text-muted">
        <UserRound className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        Esta función estará disponible en una próxima versión. Por ahora no
        necesitas hacer nada.
      </p>
    </div>
  )
}

export function ThemeStep() {
  const { prefs, update } = useLoadedPrefs()
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="space-y-5">
      <SectionTitle
        title="Tema"
        description="Elige cómo se ve la aplicación. El cambio se aplica al instante."
      />
      <ThemePicker
        value={prefs.theme}
        onChange={(theme) => {
          setError(null)
          void update({ theme }).then(setError)
        }}
      />
      <p aria-live="polite" className="text-body-lg text-danger">
        {error}
      </p>
    </div>
  )
}
