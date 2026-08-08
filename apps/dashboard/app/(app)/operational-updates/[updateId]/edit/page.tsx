import { redirect } from 'next/navigation'

import { OperationalUpdateForm } from '../../../../../components/OperationalUpdateForm'
import { createDashboardCaller } from '../../../../../lib/server-caller'

export default async function EditOperationalUpdatePage({
  params,
}: {
  params: Promise<{ updateId: string }>
}) {
  const { updateId } = await params
  const caller = await createDashboardCaller(`/operational-updates/${updateId}/edit`)
  const [update, venues] = await Promise.all([
    caller.operationalUpdate.getById({ id: updateId }),
    caller.venue.list(),
  ])

  if (update.status !== 'DRAFT') {
    redirect('/operational-updates')
  }

  return (
    <div className="bg-pf-surface px-6 py-10 lg:px-10">
      <div className="mx-auto max-w-4xl">
        <OperationalUpdateForm
          venues={venues.map((venue) => ({ id: venue.id, name: venue.name }))}
          initialUpdate={{
            id: update.id,
            venueId: update.venueId,
            placeId: update.placeId,
            updateType: update.updateType,
            priority: update.priority,
            title: update.title,
            body: update.body,
            redirectTo: update.redirectTo,
            startsAt: update.startsAt.toISOString(),
            expiresAt: update.expiresAt.toISOString(),
            updatedAt: update.updatedAt.toISOString(),
          }}
        />
      </div>
    </div>
  )
}
