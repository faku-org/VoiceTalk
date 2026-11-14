import { speakerLabel } from '@/features/sessions/format'
import type { ChatItem } from './protocol'

export const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

/** Who an item belongs to, in the words the UI shows. */
export function itemLabel(item: ChatItem): string {
  if (item.kind === 'message')
    return item.role === 'assistant' ? 'VoiceTalk' : 'Tú'
  return speakerLabel(item.speaker ?? 'remote', item.speakerName, item.label)
}
