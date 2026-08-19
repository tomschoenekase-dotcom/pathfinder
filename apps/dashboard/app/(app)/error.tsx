'use client'

import React from 'react'

import { PacketRouteError } from '../../components/PacketRouteState'

export default function ClientPortalError({ reset }: { reset: () => void }) {
  return (
    <div className="min-h-screen bg-pf-surface px-6 py-10 lg:px-10">
      <div className="mx-auto max-w-3xl">
        <PacketRouteError
          title="Your portal could not be loaded"
          detail="Nothing was changed. Try loading it again, or contact Torchiko Support if this continues."
          reset={reset}
        />
      </div>
    </div>
  )
}
