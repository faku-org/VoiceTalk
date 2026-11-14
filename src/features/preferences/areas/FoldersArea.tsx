import { useState } from 'react'
import { SectionTitle } from '@/app/ui'
import { useLoadedPrefs } from '@/app/prefsContext'
import { FolderList } from '../FolderList'
import { SaveBar } from '../SaveBar'
import { useAreaSave } from '../useAreaSave'

export function FoldersArea() {
  const { prefs } = useLoadedPrefs()
  const [folders, setFolders] = useState(prefs.folders)
  const { save, state, dirty } = useAreaSave([], () => ({ folders }))

  return (
    <form
      className="max-w-xl space-y-6"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <SectionTitle
        title="Carpetas"
        description="Solo las carpetas de esta lista están al alcance del asistente."
      />
      <FolderList
        folders={folders}
        onChange={(next) => {
          setFolders(next)
          dirty()
        }}
      />
      <SaveBar issues={[]} state={state} onSave={() => void save()} />
    </form>
  )
}
