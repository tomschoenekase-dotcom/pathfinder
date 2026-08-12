'use client'

import { PacketRouteError } from '../../../../components/PacketRouteState'

export default function ErrorState({ reset }: { error: Error; reset: () => void }) {
  return (
    <PacketRouteError
      title="Operations evidence is temporarily unavailable"
      detail="Recent work and failure evidence could not be loaded. No retry, cancellation, or production action was attempted."
      reset={reset}
    />
  )
}
