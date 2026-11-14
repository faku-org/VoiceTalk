import { formatOffset, speakerLabel } from '../sessions/format'
import type { ChatItem, ChatSession } from './protocol'

export const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

/** Who an item belongs to, in the words the UI shows: Tú, Ether, or the name a captured call gave. */
export function itemLabel(item: ChatItem): string {
  if (item.kind === 'message') return item.role === 'assistant' ? 'Ether' : 'Tú'
  if (item.speaker === 'agent') return 'Ether'
  return speakerLabel(item.speaker ?? 'remote', item.speakerName, item.label)
}

/** Own turns sit on the right. In a Discord session every speaker has a name, so only the own mic is on the right. */
export function itemSide(item: ChatItem): 'user' | 'other' {
  if (item.kind === 'message') return item.role === 'user' ? 'user' : 'other'
  return item.speaker === 'user' && !item.speakerName ? 'user' : 'other'
}

/** Text turns are the ones that were written; voice turns are transcript lines. */
export const isTyped = (item: ChatItem): boolean => item.kind === 'message'

const clock = (ms: number): string =>
  new Intl.DateTimeFormat('es', { timeStyle: 'short' }).format(new Date(ms))

/** The offset inside its call when the call is known, else the time of day. */
export function itemStamp(
  item: ChatItem,
  sessions: ReadonlyMap<string, ChatSession>,
  threadSessionId: string | null,
): string {
  const session = sessions.get(item.sessionId ?? threadSessionId ?? '')
  return session ? formatOffset(session.startedAt, item.at) : clock(item.at)
}
