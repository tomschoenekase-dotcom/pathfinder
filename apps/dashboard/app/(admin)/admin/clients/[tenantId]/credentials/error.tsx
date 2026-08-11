'use client'

import { PacketRouteError } from '../../../../../../components/PacketRouteState'

export default function ErrorState({ reset }: { error: Error; reset: () => void }) {
  return (
    <PacketRouteError
      title="Credential metadata unavailable"
      detail="Read-only metadata could not be loaded. No credential or lifecycle operation was attempted."
      reset={reset}
    />
  )
}
