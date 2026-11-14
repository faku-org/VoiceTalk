import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  CircleDot,
  History,
  MessagesSquare,
  Phone,
  Settings,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { DiscordScreen, useDiscordStatus } from '@/features/discord'
import type { DiscordStatusHandle } from '@/features/discord'
import { PreferencesScreen } from '@/features/preferences/PreferencesScreen'
import { SessionsScreen } from '@/features/sessions/SessionsScreen'
import { fadeVariants, transition } from '@/lib/motion'
import { CallSlot } from './callSlot'
import { usePrefs } from './prefsContext'

type View = 'call' | 'discord' | 'sessions' | 'preferences'

const NAV: ReadonlyArray<{ id: View; label: string; icon: LucideIcon }> = [
  { id: 'call', label: 'Llamada', icon: Phone },
  { id: 'discord', label: 'Discord', icon: MessagesSquare },
  { id: 'sessions', label: 'Sesiones', icon: History },
  { id: 'preferences', label: 'Preferencias', icon: Settings },
]

function ViewBody({
  view,
  discord,
}: {
  view: View
  discord: DiscordStatusHandle
}) {
  switch (view) {
    case 'call':
      return <CallSlot />
    case 'discord':
      return <DiscordScreen handle={discord} />
    case 'sessions':
      return <SessionsScreen />
    case 'preferences':
      return <PreferencesScreen />
  }
}

export function AppShell() {
  const [view, setView] = useState<View>('call')
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

      <main className="min-w-0 flex-1 px-4 py-8 sm:px-8">
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
            <ViewBody view={view} discord={discord} />
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  )
}
