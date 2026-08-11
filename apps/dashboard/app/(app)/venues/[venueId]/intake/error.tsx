'use client'

import { PacketRouteError } from '../../../../../components/PacketRouteState'

export default function ErrorState({ reset }: { error: Error; reset: () => void }) {
  return (
    <PacketRouteError
      title="Guided intake unavailable"
      detail="Existing proposals could not be loaded. No proposal was created or linked."
      reset={reset}
    />
  )
}
