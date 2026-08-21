import { db } from '@pathfinder/db'

export async function listAttentionWorkers(now: Date) {
  const workers = await db.agentWorker.findMany({
    orderBy: [{ lastHeartbeatAt: 'desc' }, { id: 'desc' }],
    take: 25,
    select: {
      id: true,
      workerKey: true,
      runtimeType: true,
      status: true,
      capabilities: true,
      protocolVersion: true,
      softwareVersion: true,
      modelProvider: true,
      modelName: true,
      lastHeartbeatAt: true,
      leaseExpiresAt: true,
      tenantId: true,
    },
  })
  return workers.map((worker) => ({
    ...worker,
    effectiveStatus:
      worker.status === 'ONLINE' && worker.leaseExpiresAt <= now ? 'OFFLINE' : worker.status,
  }))
}
