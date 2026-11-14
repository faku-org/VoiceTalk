import { useState } from 'react'
import { FolderPlus, X } from 'lucide-react'
import { Button, inputClass } from '@/app/ui'
import { inTauri } from '@/app/coreClient'
import { addFolders, removeFolder } from '@/features/onboarding/onboarding'
import { pickFolders } from './folderPicker'

/** Editable list of allowlisted folders, shared by onboarding and Preferences. */
export function FolderList({
  folders,
  onChange,
}: {
  folders: string[]
  onChange: (next: string[]) => void
}) {
  const [manual, setManual] = useState('')
  const [pickError, setPickError] = useState<string | null>(null)

  const browse = async () => {
    setPickError(null)
    try {
      const picked = await pickFolders()
      if (picked.length > 0) onChange(addFolders(folders, picked))
    } catch (err) {
      setPickError(`No se pudo abrir el selector de carpetas (${String(err)}).`)
    }
  }

  const addManual = () => {
    const next = addFolders(folders, [manual])
    if (next.length !== folders.length) onChange(next)
    setManual('')
  }

  return (
    <div className="space-y-4">
      {folders.length === 0 ? (
        <p className="text-body-lg text-muted">
          Todavía no hay carpetas. Sin ellas, el asistente no lee tus archivos.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {folders.map((path) => (
            <li key={path} className="flex items-center gap-3 py-2">
              <span
                className="min-w-0 flex-1 truncate font-mono text-body"
                title={path}
              >
                {path}
              </span>
              <Button
                variant="ghost"
                className="h-8 px-2"
                aria-label={`Quitar ${path}`}
                onClick={() => onChange(removeFolder(folders, path))}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {inTauri() ? (
        <Button onClick={() => void browse()}>
          <FolderPlus className="size-4" aria-hidden="true" />
          Agregar carpetas
        </Button>
      ) : null}
      {pickError && (
        <p role="alert" className="text-body text-danger">
          {pickError}
        </p>
      )}

      <div className="flex gap-2">
        <input
          className={inputClass}
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addManual()
            }
          }}
          placeholder="O escribe una ruta, por ejemplo D:/Notas"
          aria-label="Ruta de carpeta"
        />
        <Button onClick={addManual}>Agregar</Button>
      </div>
    </div>
  )
}
