import { TRPCError } from '@trpc/server'

import { logger } from '@pathfinder/config'
import { completeMediaUploadAbortAction, db, withTenantIsolationBypass } from '@pathfinder/db'

import { abortMediaUpload } from '../../lib/media-storage'
import {
  isMediaIngestionActionError,
  isNoSuchMediaUpload as isNoSuchUpload,
} from './media-ingestion-helpers'

export async function settleClaimedMediaUploadAbort(input: {
  tenantId: string
  venueId: string
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

  try {
    return await completeMediaUploadAbortAction({
      ...input,
      actor: { type: 'HUMAN', id: input.actorId, role: 'PLATFORM_ADMIN' },
    })
  } catch (error) {
    if (!isMediaIngestionActionError(error)) throw error
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'The abort result could not be recorded.',
      cause: error,
    })
  }
}
