'use client'

import { PacketRouteError } from '../../../components/PacketRouteState'

export default function WeeklyReportsError({ reset }: { reset: () => void }) {
  return (
    <div className="min-h-screen bg-pf-surface px-6 py-10 lg:px-10">
      <div className="mx-auto max-w-3xl">
        <PacketRouteError
          title="Weekly reports could not be loaded"
          detail="No report was changed. Try again, or contact support if this continues."
          reset={reset}
        />
      </div>
    </div>
  )
}
