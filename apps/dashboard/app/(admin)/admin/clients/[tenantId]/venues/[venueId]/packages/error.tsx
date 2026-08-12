'use client'

import { PacketRouteError } from '../../../../../../../../components/PacketRouteState'

export default function ErrorState({ reset }: { error: Error; reset: () => void }) {
  return (
    <PacketRouteError
      title="Venue-package review unavailable"
      detail="The exact package history could not be loaded. No package was created, approved, applied, or reverted."
      reset={reset}
    />
  )
}
