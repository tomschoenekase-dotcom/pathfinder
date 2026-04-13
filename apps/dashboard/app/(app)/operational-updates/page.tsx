import { appRouter, createTRPCContext } from '@pathfinder/api'

import { OperationalUpdatesList } from '../../../components/OperationalUpdatesList'

async function createCaller() {
  const ctx = await createTRPCContext({
    req: new Request('https://dashboard.pathfinder.local/operational-updates'),
  })

  return appRouter.createCaller(ctx)
}

export default async function OperationalUpdatesPage() {
  const caller = await createCaller()
  const updates = await caller.operationalUpdate.list()
  type UpdateItem = (typeof updates)[number]
  const serializedUpdates = updates.map((update: UpdateItem) => ({
    ...update,
    expiresAt: update.expiresAt.toISOString(),
    createdAt: update.createdAt.toISOString(),
  }))

  return (
    <div className="px-6 py-10 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <OperationalUpdatesList initialUpdates={serializedUpdates} />
      </div>
    </div>
  )
}
