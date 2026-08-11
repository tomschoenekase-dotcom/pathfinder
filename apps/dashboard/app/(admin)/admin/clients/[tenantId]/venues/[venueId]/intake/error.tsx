'use client'

import { PacketRouteError } from '../../../../../../../../components/PacketRouteState'

export default function ErrorState({ reset }: { error: Error; reset: () => void }) {
  return (
    <PacketRouteError
      title="Intake workspace unavailable"
      detail="The exact client and venue scope could not be loaded. No proposal was created or linked."
      reset={reset}
    />
  )
}
