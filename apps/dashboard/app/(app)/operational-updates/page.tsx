import { OperationalUpdatesList } from '../../../components/OperationalUpdatesList'
import { createDashboardCaller } from '../../../lib/server-caller'

export default async function OperationalUpdatesPage() {
  const caller = await createDashboardCaller('/operational-updates')
  const updates = await caller.operationalUpdate.list()
  type UpdateItem = (typeof updates)[number]
  const serializedUpdates = updates.map((update: UpdateItem) => ({
    ...update,
    expiresAt: update.expiresAt.toISOString(),
    createdAt: update.createdAt.toISOString(),
  }))

  return (
    <div className="bg-pf-surface px-6 py-10 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <OperationalUpdatesList initialUpdates={serializedUpdates} />
      </div>
    </div>
  )
}
