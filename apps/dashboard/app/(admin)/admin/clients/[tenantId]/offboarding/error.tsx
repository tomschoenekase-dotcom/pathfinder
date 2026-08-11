'use client'

import { PacketRouteError } from '../../../../../../components/PacketRouteState'

export default function ErrorState({ reset }: { error: Error; reset: () => void }) {
  return (
    <PacketRouteError
      title="Offboarding plans unavailable"
      detail="Planning records and export metadata could not be loaded. No revocation, deletion, completion, or export operation was attempted."
      reset={reset}
    />
  )
}
