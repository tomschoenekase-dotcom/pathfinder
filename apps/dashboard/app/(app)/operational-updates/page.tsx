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
    <div className="min-h-screen bg-tk-paper px-4 pb-16 pt-6 sm:px-8 sm:pt-10 lg:px-10 lg:pt-12">
      <div className="mx-auto max-w-[64rem]">
        <OperationalUpdatesList initialUpdates={serializedUpdates} />
      </div>
    </div>
  )
}
