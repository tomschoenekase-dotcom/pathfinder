import { OperationalUpdatesList } from '../../../components/OperationalUpdatesList'
import { createDashboardCaller } from '../../../lib/server-caller'

export default async function OperationalUpdatesPage() {
  const caller = await createDashboardCaller('/operational-updates')
  const updates = await caller.operationalUpdate.list()
  type UpdateItem = (typeof updates)[number]
  const serializedUpdates = updates.map((update: UpdateItem) => ({
    ...update,
    startsAt: update.startsAt.toISOString(),
    expiresAt: update.expiresAt.toISOString(),
    publishedAt: update.publishedAt?.toISOString() ?? null,
    createdAt: update.createdAt.toISOString(),
    updatedAt: update.updatedAt.toISOString(),
  }))

  return (
    <div className="bg-pf-surface px-6 py-10 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <OperationalUpdatesList initialUpdates={serializedUpdates} />
      </div>
    </div>
  )
}
