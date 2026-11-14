import type { TranscriptEntry } from './protocol'

// The transcript list, isolated from the call screen's layout: the chat/transcript rework swaps this file.
export function CallTranscript({
  entries,
  inCall,
}: {
  entries: TranscriptEntry[]
  inCall: boolean
}) {
  return (
    <div className="space-y-3" aria-live="polite" aria-label="Transcripción">
      {entries.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-hairline p-5 text-sm text-text-muted">
          {inCall
            ? 'Habla cuando quieras. La transcripción aparecerá aquí.'
            : 'Inicia una llamada para conversar por voz. El audio se procesa en este equipo; la voz del asistente se genera en la nube.'}
        </p>
      ) : (
        entries.map((entry) => (
          <p
            key={entry.id}
            className={`chat max-w-[85%] rounded-card border border-border px-4 py-2.5 ${
              entry.speaker === 'user'
                ? 'ml-auto bg-surface'
                : 'mr-auto bg-canvas'
            }`}
          >
            <span className="mb-0.5 block font-sans text-meta text-muted">
              {entry.speaker === 'user' ? 'Tú' : 'Asistente'}
            </span>
            {entry.text}
          </p>
        ))
      )}
    </div>
  )
}
