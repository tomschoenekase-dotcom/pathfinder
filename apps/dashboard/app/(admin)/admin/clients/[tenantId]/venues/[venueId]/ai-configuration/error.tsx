'use client'

import { PacketRouteError } from '../../../../../../../../components/PacketRouteState'

export default function ErrorState({ reset }: { error: Error; reset: () => void }) {
  return (
    <PacketRouteError
      title="AI configuration unavailable"
      detail="The scoped configuration could not be loaded. No setting was changed."
      reset={reset}
    />
  )
}
