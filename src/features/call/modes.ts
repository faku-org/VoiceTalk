import { NotebookPen, Phone } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CallMode } from '@/app/prefsTypes'

export const MODES: ReadonlyArray<{
  id: CallMode
  label: string
  hint: string
  icon: LucideIcon
}> = [
  {
    id: 'call',
    label: 'Llamada',
    hint: 'Conversas con Ether y te responde con voz.',
    icon: Phone,
  },
  {
    id: 'journal',
    label: 'Diario',
    hint: 'Hablas y se guarda lo que dices. Nadie responde.',
    icon: NotebookPen,
  },
]

/** What the chosen mode does, for the line under the picker. */
export const modeHint = (mode: CallMode): string =>
  (MODES.find((m) => m.id === mode) ?? MODES[0]!).hint
