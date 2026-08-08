import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { logger } from '@pathfinder/config'
import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { currentDeploymentStorageKey } from '../../lib/deployment-storage-key'
import { abortMediaUpload, beginMediaUpload, MEDIA_UPLOAD_PART_SIZE } from '../../lib/media-storage'
import { adminProcedure } from '../../trpc'
import {
  MAX_MEDIA_ARCHIVE_BYTES as MAX_ARCHIVE_BYTES,
  safeMediaFileName as safeFileName,
} from './media-ingestion-helpers'

export const mediaIngestionBeginUploadRouter = router({
  beginUpload: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        projectId: z.string().min(1),
        uploadAttemptId: z.string().uuid(),
        filename: z.string().trim().min(1).max(255),
        bytes: z.number().int().positive().max(MAX_ARCHIVE_BYTES),
        contentType: z.enum(['application/zip', 'application/x-zip-compressed']),
      }),
    )
    .mutation(async ({ input }) => {
      const project = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findFirst({
          where: { id: input.projectId, tenantId: input.tenantId },
          select: {
            id: true,
            venueId: true,
            status: true,
            stage: true,
            sourceFileName: true,
            sourceBytes: true,
            sourceContentType: true,
            uploadAttemptId: true,
            storageUploadId: true,
          },
        }),
      )
      if (!project) throw new TRPCError({ code: 'NOT_FOUND', message: 'Media project not found.' })
      if (
        project.status === 'UPLOADING' &&
        project.stage === 'upload' &&
        project.uploadAttemptId === input.uploadAttemptId &&
        project.sourceFileName === input.filename &&
        project.sourceBytes === BigInt(input.bytes) &&
        project.sourceContentType === input.contentType &&
        project.storageUploadId
      ) {
        return { partSize: MEDIA_UPLOAD_PART_SIZE }
      }
      if (!['DRAFT', 'FAILED'].includes(project.status)) {
        throw new TRPCError({ code: 'CONFLICT', message: 'This project already has an upload.' })
      }
      const objectKey = currentDeploymentStorageKey(
        `media-ingestion/${input.tenantId}/${project.venueId}/${project.id}/${safeFileName(input.filename)}`,
      )
      const reserved = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.updateMany({
          where: {
            id: project.id,
            tenantId: input.tenantId,
            status: { in: ['DRAFT', 'FAILED'] },
          },
          data: {
            status: 'UPLOADING',
            stage: 'creating-upload',
            sourceObjectKey: objectKey,
            sourceFileName: input.filename,
            sourceBytes: BigInt(input.bytes),
            sourceContentType: input.contentType,
            uploadAttemptId: input.uploadAttemptId,
            uploadStartedAt: new Date(),
            storageUploadId: null,
            error: null,
          },
        }),
      )
      if (reserved.count !== 1) {
        throw new TRPCError({ code: 'CONFLICT', message: 'This project already has an upload.' })
      }
      let started: Awaited<ReturnType<typeof beginMediaUpload>>
      try {
        started = await beginMediaUpload(objectKey, input.contentType)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Media upload creation failed.'
        try {
          const compensated = await withTenantIsolationBypass(() =>
            db.mediaIngestionProject.updateMany({
              where: {
                id: project.id,
                tenantId: input.tenantId,
                status: 'UPLOADING',
                stage: 'creating-upload',
                uploadAttemptId: input.uploadAttemptId,
              },
              data: {
                status: 'FAILED',
                stage: 'upload',
                error: message,
                uploadAttemptId: null,
                uploadStartedAt: null,
                storageUploadId: null,
                sourceContentType: null,
              },
            }),
          )
          if (compensated.count !== 1) {
            logger.warn({
              action: 'media-ingestion.upload-creation-compensation.missed',
              projectId: project.id,
              uploadAttemptId: input.uploadAttemptId,
            })
          }
        } catch (compensationError) {
          logger.warn({
            action: 'media-ingestion.upload-creation-compensation.failed',
            projectId: project.id,
            uploadAttemptId: input.uploadAttemptId,
            error:
              compensationError instanceof Error
                ? compensationError.message
                : 'Unknown compensation error',
          })
        }
        throw error
      }
      let persistenceError: unknown
      try {
        const persisted = await withTenantIsolationBypass(() =>
          db.mediaIngestionProject.updateMany({
            where: {
              id: project.id,
              tenantId: input.tenantId,
              status: 'UPLOADING',
              stage: 'creating-upload',
              uploadAttemptId: input.uploadAttemptId,
            },
            data: { stage: 'upload', storageUploadId: started.uploadId },
          }),
        )
        if (persisted.count !== 1) {
          persistenceError = new Error(
            'The media upload generation claim was lost before persistence.',
          )
        }
      } catch (error) {
        try {
          const readback = await withTenantIsolationBypass(() =>
            db.mediaIngestionProject.findFirst({
              where: {
                id: project.id,
                tenantId: input.tenantId,
                status: 'UPLOADING',
                uploadAttemptId: input.uploadAttemptId,
              },
              select: { stage: true, storageUploadId: true },
            }),
          )
          if (readback?.stage === 'upload' && readback.storageUploadId === started.uploadId) {
            return { partSize: started.partSize }
          }
        } catch (readbackError) {
          logger.warn({
            action: 'media-ingestion.upload-identity-persistence.uncertain',
            projectId: project.id,
            uploadAttemptId: input.uploadAttemptId,
            error: 'Upload identity persistence could not be confirmed.',
            errorType: readbackError instanceof Error ? readbackError.name : 'UnknownError',
          })
          throw error
        }
        logger.warn({
          action: 'media-ingestion.upload-identity-persistence.uncertain',
          projectId: project.id,
          uploadAttemptId: input.uploadAttemptId,
          error: 'Upload identity persistence could not be confirmed.',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        })
        throw error
      }
      if (persistenceError !== undefined) {
        try {
          await abortMediaUpload(objectKey, started.uploadId)
        } catch (abortError) {
          logger.warn({
            action: 'media-ingestion.upload-creation-abort.failed',
            projectId: project.id,
            uploadAttemptId: input.uploadAttemptId,
            error: 'Newly created multipart upload abort failed.',
            errorType: abortError instanceof Error ? abortError.name : 'UnknownError',
          })
        }
        const message = 'Upload identity persistence failed.'
        try {
          const compensated = await withTenantIsolationBypass(() =>
            db.mediaIngestionProject.updateMany({
              where: {
                id: project.id,
                tenantId: input.tenantId,
                status: 'UPLOADING',
                stage: 'creating-upload',
                uploadAttemptId: input.uploadAttemptId,
              },
              data: {
                status: 'FAILED',
                stage: 'upload',
                error: message,
                uploadAttemptId: null,
                uploadStartedAt: null,
                storageUploadId: null,
                sourceContentType: null,
              },
            }),
          )
          if (compensated.count !== 1) {
            logger.warn({
              action: 'media-ingestion.upload-identity-compensation.missed',
              projectId: project.id,
              uploadAttemptId: input.uploadAttemptId,
            })
          }
        } catch (compensationError) {
          logger.warn({
            action: 'media-ingestion.upload-identity-compensation.failed',
            projectId: project.id,
            uploadAttemptId: input.uploadAttemptId,
            error: 'Upload identity compensation failed.',
            errorType: compensationError instanceof Error ? compensationError.name : 'UnknownError',
          })
        }
        throw persistenceError
      }
      return { partSize: started.partSize }
    }),
})
