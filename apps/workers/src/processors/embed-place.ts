import { logger } from '@pathfinder/config'
import {
  db,
  generateAndStorePlaceEmbedding,
  updateJobRecord,
  withTenantIsolationBypass,
  writeJobRecord,
} from '@pathfinder/db'
import type { EmbedPlaceJobPayload } from '@pathfinder/jobs'

export async function processEmbedPlaceJob(
  payload: EmbedPlaceJobPayload,
  bullJobId?: string | null,
): Promise<void> {
  const startedAt = new Date()
  const jobRecordId = await writeJobRecord({
    queue: 'embed-place',
    jobName: 'embed-place-process',
    bullJobId: bullJobId ?? null,
    tenantId: payload.tenantId,
    status: 'RUNNING',
    payload: payload as unknown as Record<string, unknown>,
    startedAt,
  })

  try {
    const place = await withTenantIsolationBypass(async () =>
      db.place.findFirst({
        where: {
          id: payload.placeId,
          tenantId: payload.tenantId,
          isActive: true,
        },
        select: {
          id: true,
          name: true,
          type: true,
          itemType: true,
          shortDescription: true,
          longDescription: true,
          tags: true,
          areaName: true,
          hours: true,
        },
      }),
    )

    if (!place) {
      throw new Error(`Place ${payload.placeId} not found`)
    }

    await generateAndStorePlaceEmbedding(place)
    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })

    logger.info({
      action: 'workers.embed-place.completed',
      tenantId: payload.tenantId,
      placeId: payload.placeId,
    })
  } catch (error) {
    await updateJobRecord(jobRecordId, {
      status: 'FAILED',
      error: error instanceof Error ? error.message : 'Unknown embed place error',
    })

    logger.error({
      action: 'workers.embed-place.failed',
      tenantId: payload.tenantId,
      placeId: payload.placeId,
      error: error instanceof Error ? error.message : 'Unknown embed place error',
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    })

    throw error
  }
}
