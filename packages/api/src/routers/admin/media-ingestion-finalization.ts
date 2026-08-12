import { TRPCError } from '@trpc/server'

import { logger } from '@pathfinder/config'
import { db, queueVerifiedMediaUploadAction, withTenantIsolationBypass } from '@pathfinder/db'
import { enqueueMediaIngestion } from '@pathfinder/jobs'
import { isMediaIngestionActionError } from './media-ingestion-helpers'

export async function queueVerifiedMediaUpload(input: {
  tenantId: string
  projectId: string
  venueId: string
  uploadAttemptId: string
  verifiedBytes: number
  actorId: string
}) {
  try {
    const transition = await queueVerifiedMediaUploadAction({
      tenantId: input.tenantId,
      venueId: input.venueId,
      projectId: input.projectId,
      uploadAttemptId: input.uploadAttemptId,
      verifiedBytes: input.verifiedBytes,
      actor: { type: 'HUMAN', id: input.actorId, role: 'PLATFORM_ADMIN' },
    })
    if (transition.replayed && transition.state !== 'QUEUED') return { ok: true }
  } catch (error) {
    if (isMediaIngestionActionError(error)) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'The upload state changed before completion could be recorded.',
        cause: error,
      })
    }
    let readback: { status: string; stage: string; sourceBytes: bigint | null } | null
    try {
      readback = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findFirst({
          where: {
            id: input.projectId,
            tenantId: input.tenantId,
            venueId: input.venueId,
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
      throw error
    }
    const exactBytes = readback?.sourceBytes === BigInt(input.verifiedBytes)
    if (
      exactBytes &&
      readback !== null &&
      ['INVENTORYING', 'ANALYZING', 'SYNTHESIZING'].includes(readback.status)
    ) {
      return { ok: true }
    }
    if (!(exactBytes && readback?.status === 'QUEUED' && readback.stage === 'inventory')) {
      logger.warn({
        action: 'media-ingestion.upload-queue-transition.uncertain',
        projectId: input.projectId,
        uploadAttemptId: input.uploadAttemptId,
        error: 'Upload queue transition could not be confirmed.',
        errorType: error instanceof Error ? error.name : 'UnknownError',
      })
      throw error
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
  return { ok: true }
}
