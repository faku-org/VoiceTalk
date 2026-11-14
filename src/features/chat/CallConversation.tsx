import { Conversation } from './Conversation'
import type { LiveEntry } from './protocol'

/**
 * The call view's timeline: the call in progress while connected (its lines show as they are said, and typed
 * turns join them), the main thread otherwise. An isolated child so the call layout can change around it.
 */
export function CallConversation({
  inCall,
  live,
}: {
  inCall: boolean
  live: ReadonlyArray<LiveEntry>
}) {
  return (
    <Conversation
      source={inCall ? { kind: 'live' } : { kind: 'main' }}
      live={inCall ? live : undefined}
      logClassName="max-h-[50dvh]"
      emptyText={
        inCall
          ? 'Hablá cuando quieras o escribile a Ether. La transcripción aparece acá.'
          : 'Iniciá una llamada para conversar por voz, o escribile a Ether. El audio se procesa en este equipo; la voz de Ether se genera en la nube.'
      }
    />
  )
}
