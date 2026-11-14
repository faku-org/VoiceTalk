import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  CircleDot,
  Headphones,
  History,
  MessagesSquare,
  Phone,
  Settings,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { CaptureScreen, useCapture } from '@/features/capture'
import type { CaptureApi } from '@/features/capture'
import { formatClock } from '@/features/capture/protocol'
import { DiscordScreen, useDiscordStatus } from '@/features/discord'
import type { DiscordStatusHandle } from '@/features/discord'
import { PreferencesScreen } from '@/features/preferences/PreferencesScreen'
import { SessionsScreen } from '@/features/sessions/SessionsScreen'
import { fadeVariants, transition } from '@/lib/motion'
import { CallSlot } from './callSlot'
import { usePrefs } from './prefsContext'

type View = 'call' | 'capture' | 'discord' | 'sessions' | 'preferences'

const NAV: ReadonlyArray<{ id: View; label: string; icon: LucideIcon }> = [
  { id: 'call', label: 'Llamada', icon: Phone },
  { id: 'capture', label: 'Capturar', icon: Headphones },
  { id: 'discord', label: 'Discord', icon: MessagesSquare },
  { id: 'sessions', label: 'Sesiones', icon: History },
  { id: 'preferences', label: 'Preferencias', icon: Settings },
]

function ViewBody({
  view,
  capture,
  discord,
}: {
  view: View
  capture: CaptureApi
  discord: DiscordStatusHandle
}) {
  switch (view) {
    case 'call':
      return <CallSlot />
    case 'capture':
      return <CaptureScreen capture={capture} />
    case 'discord':
      return <DiscordScreen handle={discord} />
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
  const { keyStatus } = usePrefs()
  // Without a bot token the feature is hidden entirely.
  const discordOn = keyStatus?.discord === true
  const discord = useDiscordStatus(discordOn)
  const recording = discord.status?.session ?? null
  const nav = NAV.filter(({ id }) => id !== 'discord' || discordOn)
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
        {nav.map(({ id, label, icon: Icon }) => {
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
              {id === 'discord' && recording && (
                <CircleDot
                  className="size-3 shrink-0 text-danger md:ml-auto"
                  aria-label="Transcribiendo"
                />
              )}
            </button>
          )
        })}
      </nav>

      <div className="min-w-0 flex-1">
        <RecordingBar capture={capture} onOpen={() => setView('capture')} />
        <main className="px-4 py-8 sm:px-8">
          {recording && (
            <div
              role="status"
              className="mb-6 flex items-center gap-2 rounded-control border border-danger/40 bg-danger/10 px-3 py-2 text-body text-danger"
            >
              <CircleDot className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                Transcribiendo {recording.channelName} en Discord (
                {recording.guildName}).
              </span>
              {view !== 'discord' && (
                <button
                  type="button"
                  onClick={() => setView('discord')}
                  className="shrink-0 font-medium underline"
                >
                  Ver
                </button>
              )}
            </div>
          )}
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={view}
              initial={variants.initial}
              animate={variants.animate}
              exit={variants.exit}
              transition={transition}
            >
              <ViewBody view={view} capture={capture} discord={discord} />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  )
}
