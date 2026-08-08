import { TRPCError } from '@trpc/server'

import { logger } from '@pathfinder/config'
import { db, withTenantIsolationBypass, writeAuditLog } from '@pathfinder/db'

import { abortMediaUpload } from '../../lib/media-storage'
import { isNoSuchMediaUpload as isNoSuchUpload } from './media-ingestion-helpers'

export async function settleClaimedMediaUploadAbort(input: {
  tenantId: string
  projectId: string
  uploadAttemptId: string
  sourceObjectKey: string
  storageUploadId: string
  resumedAbort: boolean
  actorId: string
  auditAction: 'admin.media_ingestion.upload_aborted' | 'admin.media_ingestion.upload_expired'
}) {
  try {
    await abortMediaUpload(input.sourceObjectKey, input.storageUploadId)
  } catch (error) {
    if (input.resumedAbort && isNoSuchUpload(error)) {
      // A prior abort succeeded but its terminal database write was lost.
    } else {
      try {
        const compensated = await withTenantIsolationBypass(() =>
          db.mediaIngestionProject.updateMany({
            where: {
              id: input.projectId,
              tenantId: input.tenantId,
              status: 'UPLOADING',
              stage: 'aborting',
              uploadAttemptId: input.uploadAttemptId,
              sourceObjectKey: input.sourceObjectKey,
              storageUploadId: input.storageUploadId,
            },
            data: {
              stage: 'aborting',
              error: 'Media upload abort could not be confirmed.',
            },
          }),
        )
        if (compensated.count !== 1) {
          logger.warn({
            action: 'media-ingestion.upload-abort-compensation.missed',
            projectId: input.projectId,
            uploadAttemptId: input.uploadAttemptId,
          })
        }
      } catch (compensationError) {
        logger.warn({
          action: 'media-ingestion.upload-abort-compensation.failed',
          projectId: input.projectId,
          uploadAttemptId: input.uploadAttemptId,
          error: 'Upload abort state persistence failed.',
          errorType: compensationError instanceof Error ? compensationError.name : 'UnknownError',
        })
      }
      throw error
    }
  }

  const cancelled = await withTenantIsolationBypass(() =>
    db.mediaIngestionProject.updateMany({
      where: {
        id: input.projectId,
        tenantId: input.tenantId,
        status: 'UPLOADING',
        stage: 'aborting',
        uploadAttemptId: input.uploadAttemptId,
        sourceObjectKey: input.sourceObjectKey,
        storageUploadId: input.storageUploadId,
      },
      data: {
        status: 'CANCELLED',
        stage: 'cancelled',
        uploadAttemptId: null,
        uploadStartedAt: null,
        storageUploadId: null,
        sourceObjectGeneration: null,
        sourceContentType: null,
        error: null,
      },
    }),
  )
  if (cancelled.count !== 1) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'The abort result could not be recorded.',
    })
  }
  await writeAuditLog({
    tenantId: input.tenantId,
    actorId: input.actorId,
    actorRole: 'PLATFORM_ADMIN',
    action: input.auditAction,
    targetType: 'MediaIngestionProject',
    targetId: input.projectId,
  })
  return { ok: true }
}
