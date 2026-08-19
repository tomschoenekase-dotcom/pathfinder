'use client'

import { RemoteOnboardingError } from '../../../../../components/RemoteOnboardingRouteState'

export default function ErrorState({ reset }: { error: Error; reset: () => void }) {
  return <RemoteOnboardingError reset={reset} />
}
