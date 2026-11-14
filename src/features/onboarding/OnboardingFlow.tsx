import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ArrowLeft, ArrowRight, Check } from 'lucide-react'
import { Button } from '@/app/ui'
import { useLoadedPrefs } from '@/app/prefsContext'
import { fadeVariants, transition } from '@/lib/motion'
import {
  completionRecord,
  isLastStep,
  nextStepIndex,
  ONBOARDING_STEPS,
  onboardingProgress,
  previousStepIndex,
  type OnboardingStepId,
} from './onboarding'
import {
  FoldersStep,
  MicrophoneStep,
  ModelsStep,
  ThemeStep,
  VoiceStep,
  WelcomeStep,
} from './steps'

const LABELS: Record<OnboardingStepId, string> = {
  welcome: 'Bienvenida',
  microphone: 'Micrófono',
  folders: 'Carpetas',
  models: 'Modelos',
  voice: 'Tu voz',
  theme: 'Tema',
}

function StepBody({ id }: { id: OnboardingStepId }) {
  switch (id) {
    case 'welcome':
      return <WelcomeStep />
    case 'microphone':
      return <MicrophoneStep />
    case 'folders':
      return <FoldersStep />
    case 'models':
      return <ModelsStep />
    case 'voice':
      return <VoiceStep />
    case 'theme':
      return <ThemeStep />
  }
}

/** First-run flow. Completion is persisted in the core preferences file. */
export function OnboardingFlow() {
  const { update } = useLoadedPrefs()
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const reduced = useReducedMotion()
  const variants = fadeVariants(reduced)

  const total = ONBOARDING_STEPS.length
  const id = ONBOARDING_STEPS[index]
  const last = isLastStep(index, total)
  const progress = onboardingProgress(index, total)

  const finish = async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    const message = await update({ onboarding: completionRecord() })
    setSaving(false)
    if (message) setError(message)
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col px-4 py-8 sm:px-8">
      <header className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-meta text-muted">
            Paso {index + 1} de {total} · {LABELS[id]}
          </p>
          <Button
            variant="ghost"
            className="h-8 px-2 text-meta"
            onClick={() => void finish()}
          >
            Omitir configuración
          </Button>
        </div>
        <div
          role="progressbar"
          aria-label="Progreso de la configuración"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          className="h-1.5 overflow-hidden rounded-full bg-surface-3"
        >
          <div
            className="h-full bg-accent transition-[width] duration-(--dur-panel) ease-standard motion-reduce:transition-none"
            style={{ width: `${progress}%` }}
          />
        </div>
      </header>

      <div className="flex-1 py-8">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={id}
            initial={variants.initial}
            animate={variants.animate}
            exit={variants.exit}
            transition={transition}
          >
            <StepBody id={id} />
          </motion.div>
        </AnimatePresence>
      </div>

      <footer className="space-y-3">
        <p aria-live="polite" className="text-body-lg text-danger">
          {error}
        </p>
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="ghost"
            onClick={() => setIndex(previousStepIndex(index, total))}
            aria-hidden={index === 0}
            tabIndex={index === 0 ? -1 : 0}
            className={index === 0 ? 'invisible' : undefined}
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Atrás
          </Button>
          {last ? (
            <Button
              variant="primary"
              onClick={() => void finish()}
              aria-busy={saving}
            >
              <Check className="size-4" aria-hidden="true" />
              Terminar
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => setIndex(nextStepIndex(index, total))}
            >
              Siguiente
              <ArrowRight className="size-4" aria-hidden="true" />
            </Button>
          )}
        </div>
      </footer>
    </main>
  )
}
