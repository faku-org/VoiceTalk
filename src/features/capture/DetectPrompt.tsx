import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Headphones } from 'lucide-react'
import { Button } from '@/app/ui'
import { fadeVariants, transition } from '@/lib/motion'
import { platformLabel } from './protocol'
import type { DetectApi } from './use-detect'

/**
 * Quiet floating prompt for a detected call (ADR 0016). It never starts anything by itself: `Anotar` goes through the
 * capture gate, and while the consent notice is pending it only explains where to confirm it.
 */
export function DetectPrompt({
  detect,
  onOpenPreferences,
}: {
  detect: DetectApi
  onOpenPreferences: () => void
}) {
  const { prompt, problem, starting } = detect
  const reduced = useReducedMotion()
  const variants = fadeVariants(reduced)
  const name = prompt ? platformLabel(prompt.platform) : ''
  const blocked = problem !== null

  return (
    <AnimatePresence>
      {prompt && (
        <motion.section
          key={prompt.pid}
          role="region"
          aria-label="Llamada detectada"
          aria-live="polite"
          initial={variants.initial}
          animate={variants.animate}
          exit={variants.exit}
          transition={transition}
          className="fixed bottom-4 right-4 z-30 w-[min(24rem,calc(100vw-2rem))] space-y-3 rounded-panel border border-border bg-surface p-4 shadow-float"
        >
          <p className="flex items-start gap-2 text-body-lg">
            <Headphones
              className="mt-0.5 size-4 shrink-0 text-accent"
              aria-hidden="true"
            />
            <span>
              Parece que estás en una llamada de{' '}
              <span className="font-medium">{name}</span>. ¿Querés que la anote?
            </span>
          </p>

          {problem && (
            <p role="alert" className="text-meta text-danger">
              {problem}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {blocked ? (
              <Button variant="primary" onClick={onOpenPreferences}>
                Abrir Preferencias
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={detect.accept}
                aria-busy={starting}
              >
                {starting ? 'Iniciando…' : 'Anotar'}
              </Button>
            )}
            <Button onClick={detect.dismiss}>Ahora no</Button>
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-meta">
            <button
              type="button"
              onClick={() => detect.remember('always')}
              className="rounded-control text-muted hover:text-text"
            >
              Siempre para {name}
            </button>
            <button
              type="button"
              onClick={() => detect.remember('never')}
              className="rounded-control text-muted hover:text-text"
            >
              Nunca para {name}
            </button>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  )
}
