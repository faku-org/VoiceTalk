import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { History, Phone, Settings } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { PreferencesScreen } from '@/features/preferences/PreferencesScreen'
import { SessionsScreen } from '@/features/sessions/SessionsScreen'
import { fadeVariants, transition } from '@/lib/motion'
import { CallSlot } from './callSlot'

type View = 'call' | 'sessions' | 'preferences'

const NAV: ReadonlyArray<{ id: View; label: string; icon: LucideIcon }> = [
  { id: 'call', label: 'Llamada', icon: Phone },
  { id: 'sessions', label: 'Sesiones', icon: History },
  { id: 'preferences', label: 'Preferencias', icon: Settings },
]

function ViewBody({ view }: { view: View }) {
  switch (view) {
    case 'call':
      return <CallSlot />
    case 'sessions':
      return <SessionsScreen />
    case 'preferences':
      return <PreferencesScreen />
  }
}

export function AppShell() {
  const [view, setView] = useState<View>('call')
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
            </button>
          )
        })}
      </nav>

      <main className="min-w-0 flex-1 px-4 py-8 sm:px-8">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={view}
            initial={variants.initial}
            animate={variants.animate}
            exit={variants.exit}
            transition={transition}
          >
            <ViewBody view={view} />
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  )
}
