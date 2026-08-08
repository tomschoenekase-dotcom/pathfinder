import { TRPCError } from '@trpc/server'

import { logger } from '@pathfinder/config'
import { db, withTenantIsolationBypass, writeAuditLog } from '@pathfinder/db'
import { enqueueMediaIngestion } from '@pathfinder/jobs'

export async function queueVerifiedMediaUpload(input: {
  tenantId: string
  projectId: string
  venueId: string
  uploadAttemptId: string
  verifiedBytes: number
  actorId: string
}) {
  let transitionedCount: number | null = null
  let transitionError: unknown
  try {
    const transitioned = await withTenantIsolationBypass(() =>
      db.mediaIngestionProject.updateMany({
        where: {
          id: input.projectId,
          tenantId: input.tenantId,
          status: 'UPLOADING',
          stage: 'finalizing',
          uploadAttemptId: input.uploadAttemptId,
        },
        data: {
          status: 'QUEUED',
          stage: 'inventory',
          progress: 1,
          sourceBytes: BigInt(input.verifiedBytes),
          uploadStartedAt: null,
          storageUploadId: null,
          sourceContentType: null,
        },
      }),
    )
    transitionedCount = transitioned.count
  } catch (error) {
    transitionError = error
  }
  if (transitionedCount !== 1) {
    let readback: { status: string; stage: string; sourceBytes: bigint | null } | null
    try {
      readback = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findFirst({
          where: {
            id: input.projectId,
            tenantId: input.tenantId,
            uploadAttemptId: input.uploadAttemptId,
          },
          select: { status: true, stage: true, sourceBytes: true },
        }),
      )
    } catch (readbackError) {
      logger.warn({
        action: 'media-ingestion.upload-queue-transition.uncertain',
        projectId: input.projectId,
        uploadAttemptId: input.uploadAttemptId,
        error: 'Upload queue transition could not be confirmed.',
        errorType: readbackError instanceof Error ? readbackError.name : 'UnknownError',
      })
      if (transitionError !== undefined) throw transitionError
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'The upload state changed before completion could be recorded.',
      })
    }
    const exactQueued =
      readback?.status === 'QUEUED' &&
      readback.stage === 'inventory' &&
      readback.sourceBytes === BigInt(input.verifiedBytes)
    const alreadyProcessing =
      readback !== null && ['INVENTORYING', 'ANALYZING', 'SYNTHESIZING'].includes(readback.status)
    if (alreadyProcessing) return { ok: true }
    if (!exactQueued) {
      if (transitionError !== undefined) {
        logger.warn({
          action: 'media-ingestion.upload-queue-transition.uncertain',
          projectId: input.projectId,
          uploadAttemptId: input.uploadAttemptId,
          error: 'Upload queue transition could not be confirmed.',
          errorType: transitionError instanceof Error ? transitionError.name : 'UnknownError',
        })
        throw transitionError
      }
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'The upload state changed before completion could be recorded.',
      })
    }
  }
  try {
    await enqueueMediaIngestion({
      tenantId: input.tenantId,
      venueId: input.venueId,
      projectId: input.projectId,
      uploadAttemptId: input.uploadAttemptId,
    })
  } catch (error) {
    try {
      await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.updateMany({
          where: {
            id: input.projectId,
            tenantId: input.tenantId,
            status: 'QUEUED',
            stage: 'inventory',
            uploadAttemptId: input.uploadAttemptId,
          },
          data: { error: 'Media ingestion enqueue could not be confirmed.' },
        }),
      )
    } catch (statusError) {
      logger.warn({
        action: 'media-ingestion.upload-enqueue-state.failed',
        projectId: input.projectId,
        uploadAttemptId: input.uploadAttemptId,
        error: 'Upload enqueue state could not be recorded.',
        errorType: statusError instanceof Error ? statusError.name : 'UnknownError',
      })
    }
    throw error
  }
  await writeAuditLog({
    tenantId: input.tenantId,
    actorId: input.actorId,
    actorRole: 'PLATFORM_ADMIN',
    action: 'admin.media_ingestion.upload_completed',
    targetType: 'MediaIngestionProject',
    targetId: input.projectId,
  })
  return { ok: true }
}
