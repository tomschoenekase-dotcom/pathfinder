'use client'

import { PacketRouteError } from '../../../../components/PacketRouteState'

export default function WeeklyReportDetailError({ reset }: { reset: () => void }) {
  return (
    <div className="min-h-screen bg-pf-surface px-6 py-10 lg:px-10">
      <div className="mx-auto max-w-3xl">
        <PacketRouteError
          title="This weekly report could not be loaded"
          detail="No report was changed. Try again, or return to the weekly report list."
          reset={reset}
        />
      </div>
    </div>
  )
}
