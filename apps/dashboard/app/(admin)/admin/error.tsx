'use client'

import { PacketRouteError } from '../../../components/PacketRouteState'

export default function ErrorState({ reset }: { error: Error; reset: () => void }) {
  return (
    <PacketRouteError
      title="Torchiko OS is temporarily unavailable"
      detail="The attention queues could not be loaded. No client, job, incident, or agent state was changed."
      reset={reset}
    />
  )
}
