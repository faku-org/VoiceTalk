import { AppShell } from '@/app/AppShell'
import { PrefsProvider } from '@/app/PrefsProvider'
import { usePrefs } from '@/app/prefsContext'
import { LoadingScreen } from '@/app/ServiceStatus'
import { OnboardingFlow } from '@/features/onboarding/OnboardingFlow'
import { isOnboardingComplete } from '@/features/onboarding/onboarding'

function Gate() {
  const { state, prefs, error } = usePrefs()
  if (state !== 'ready' || !prefs) {
    return <LoadingScreen error={state === 'error' ? error : null} />
  }
  return isOnboardingComplete(prefs.onboarding) ? (
    <AppShell />
  ) : (
    <OnboardingFlow />
  )
}

export default function App() {
  return (
    <PrefsProvider>
      <Gate />
    </PrefsProvider>
  )
}
