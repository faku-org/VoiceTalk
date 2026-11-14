import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CircleDot, Headphones, History, Phone, Settings } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { CaptureScreen, useCapture } from '@/features/capture'
import type { CaptureApi } from '@/features/capture'
import { formatClock } from '@/features/capture/protocol'
import { PreferencesScreen } from '@/features/preferences/PreferencesScreen'
import { SessionsScreen } from '@/features/sessions/SessionsScreen'
import { fadeVariants, transition } from '@/lib/motion'
import { CallSlot } from './callSlot'

type View = 'call' | 'capture' | 'sessions' | 'preferences'

const NAV: ReadonlyArray<{ id: View; label: string; icon: LucideIcon }> = [
  { id: 'call', label: 'Llamada', icon: Phone },
  { id: 'capture', label: 'Capturar', icon: Headphones },
  { id: 'sessions', label: 'Sesiones', icon: History },
  { id: 'preferences', label: 'Preferencias', icon: Settings },
]

function ViewBody({ view, capture }: { view: View; capture: CaptureApi }) {
  switch (view) {
    case 'call':
      return <CallSlot />
    case 'capture':
      return <CaptureScreen capture={capture} />
    case 'sessions':
      return <SessionsScreen />
    case 'preferences':
      return <PreferencesScreen />
  }
}

/** Visible on every view while a call is being captured (privacy is visible, DESIGN.md). */
function RecordingBar({
  capture,
  onOpen,
}: {
  capture: CaptureApi
  onOpen: () => void
}) {
  const { active, levels } = capture
  if (!active) return null
  return (
    <div
      role="status"
      className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-danger bg-surface px-4 py-2 text-body-lg sm:px-8"
    >
      <CircleDot className="size-4 shrink-0 text-danger" aria-hidden="true" />
      <span className="font-medium text-danger">Grabando llamada</span>
      <span className="text-muted">{active.name}</span>
      <span className="tabular-nums text-muted">
        {formatClock(levels.seconds)}
      </span>
      <button
        type="button"
        onClick={onOpen}
        className="ml-auto h-8 rounded-control px-3 text-body-lg font-medium text-accent hover:bg-accent/10"
      >
        Ver captura
      </button>
    </div>
  )
}

export function AppShell() {
  const [view, setView] = useState<View>('call')
  const capture = useCapture()
  const reduced = useReducedMotion()
  const variants = fadeVariants(reduced)

  return (
    <div className="flex min-h-dvh">
      <nav
        aria-label="Secciones"
        className="sticky top-0 flex h-dvh w-14 shrink-0 flex-col gap-1 border-r border-border bg-surface p-2 md:w-56 md:p-3"
      >
        <p className="hidden px-3 pb-3 pt-1 text-h3 font-semibold tracking-tight md:block">
          VoiceTalk
        </p>
        {NAV.map(({ id, label, icon: Icon }) => {
          const active = view === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              aria-current={active ? 'page' : undefined}
              title={label}
              className={`flex h-10 items-center justify-center gap-3 rounded-control px-3 text-body-lg font-medium transition-colors duration-(--dur-fast) md:justify-start ${
                active
                  ? 'bg-accent/10 text-accent'
                  : 'text-muted hover:bg-surface-2 hover:text-text'
              }`}
            >
              <Icon className="size-5 shrink-0" aria-hidden="true" />
              <span className="hidden md:inline">{label}</span>
              {id === 'capture' && capture.active && (
                <>
                  <CircleDot
                    className="ml-auto hidden size-4 text-danger md:block"
                    aria-hidden="true"
                  />
                  <span className="sr-only">grabando</span>
                </>
              )}
            </button>
          )
        })}
      </nav>

      <div className="min-w-0 flex-1">
        <RecordingBar capture={capture} onOpen={() => setView('capture')} />
        <main className="px-4 py-8 sm:px-8">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={view}
              initial={variants.initial}
              animate={variants.animate}
              exit={variants.exit}
              transition={transition}
            >
              <ViewBody view={view} capture={capture} />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  )
}
