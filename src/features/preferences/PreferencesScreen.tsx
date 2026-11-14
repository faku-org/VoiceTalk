import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { fadeVariants, transition } from '@/lib/motion'
import { AppearanceArea } from './areas/AppearanceArea'
import { AssistantArea } from './areas/AssistantArea'
import { DecisionsArea } from './areas/DecisionsArea'
import { FoldersArea } from './areas/FoldersArea'
import { LocationArea } from './areas/LocationArea'
import { ServicesArea } from './areas/ServicesArea'
import { UpdatesArea } from './areas/UpdatesArea'

type Area =
  | 'assistant'
  | 'decisions'
  | 'folders'
  | 'location'
  | 'appearance'
  | 'updates'
  | 'services'

const AREAS: ReadonlyArray<{ id: Area; label: string }> = [
  { id: 'assistant', label: 'Asistente' },
  { id: 'decisions', label: 'Decisiones' },
  { id: 'folders', label: 'Carpetas' },
  { id: 'location', label: 'Ubicación' },
  { id: 'appearance', label: 'Apariencia' },
  { id: 'updates', label: 'Actualizaciones' },
  { id: 'services', label: 'Servicios' },
]

function AreaBody({ area }: { area: Area }) {
  switch (area) {
    case 'assistant':
      return <AssistantArea />
    case 'decisions':
      return <DecisionsArea />
    case 'folders':
      return <FoldersArea />
    case 'location':
      return <LocationArea />
    case 'appearance':
      return <AppearanceArea />
    case 'updates':
      return <UpdatesArea />
    case 'services':
      return <ServicesArea />
  }
}

export function PreferencesScreen() {
  const [area, setArea] = useState<Area>('assistant')
  const reduced = useReducedMotion()
  const variants = fadeVariants(reduced)

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-h1 font-semibold tracking-tight">Preferencias</h1>
      </header>

      <nav
        aria-label="Áreas de preferencias"
        className="sticky top-0 z-10 -mx-1 flex flex-wrap gap-2 bg-bg px-1 py-2"
      >
        {AREAS.map(({ id, label }) => {
          const active = area === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => setArea(id)}
              aria-current={active ? 'page' : undefined}
              className={`h-9 rounded-full px-4 text-body-lg font-medium transition-colors duration-(--dur-fast) ${
                active
                  ? 'bg-accent/10 text-accent'
                  : 'text-muted hover:bg-surface-2 hover:text-text'
              }`}
            >
              {label}
            </button>
          )
        })}
      </nav>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={area}
          initial={variants.initial}
          animate={variants.animate}
          exit={variants.exit}
          transition={transition}
        >
          <AreaBody area={area} />
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
