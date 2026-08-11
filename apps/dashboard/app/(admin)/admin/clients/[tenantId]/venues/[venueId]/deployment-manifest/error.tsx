'use client'

import { PacketRouteError } from '../../../../../../../../components/PacketRouteState'

export default function ErrorState({ reset }: { error: Error; reset: () => void }) {
  return (
    <PacketRouteError
      title="Manifest review unavailable"
      detail="The review surface could not be loaded. No manifest was submitted or persisted."
      reset={reset}
    />
  )
}
