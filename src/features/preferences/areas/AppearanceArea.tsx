import { useState } from 'react'
import { SectionTitle } from '@/app/ui'
import { useLoadedPrefs } from '@/app/prefsContext'
import type { ThemePreference } from '@/lib/theme'
import { ThemePicker } from '../ThemePicker'

/** The theme applies immediately and is saved on change; no separate button. */
export function AppearanceArea() {
  const { prefs, update } = useLoadedPrefs()
  const [error, setError] = useState<string | null>(null)

  const choose = async (theme: ThemePreference) => {
    setError(null)
    const failure = await update({ theme })
    if (failure) setError(failure)
  }

  return (
    <div className="max-w-xl space-y-6">
      <SectionTitle
        title="Apariencia"
        description="Claro, oscuro, o el mismo que use el sistema."
      />
      <ThemePicker value={prefs.theme} onChange={(t) => void choose(t)} />
      <p aria-live="polite" className="text-body-lg text-danger">
        {error}
      </p>
    </div>
  )
}
