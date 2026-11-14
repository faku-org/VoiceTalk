import { CallScreen } from '@/features/call'
import { useSidecarStatus } from './useSidecarStatus'

/** Call tab: hands the core port to the call screen once the sidecar is healthy. */
export function CallSlot() {
  const { status } = useSidecarStatus()
  const corePort = status?.core.state === 'healthy' ? status.core.port : null
  return <CallScreen corePort={corePort} />
}
