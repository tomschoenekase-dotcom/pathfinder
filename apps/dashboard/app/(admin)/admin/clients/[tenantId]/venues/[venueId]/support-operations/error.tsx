'use client'

import { PacketRouteError } from '../../../../../../../../components/PacketRouteState'

export default function ErrorState({ reset }: { error: Error; reset: () => void }) {
  return (
    <PacketRouteError
      title="Support operations unavailable"
      detail="Support evidence could not be loaded. No message, status, or package-lineage operation was attempted."
      reset={reset}
    />
  )
}
