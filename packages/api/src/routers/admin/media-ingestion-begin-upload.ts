import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { logger } from '@pathfinder/config'
import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { currentDeploymentStorageKey } from '../../lib/deployment-storage-key'
import {
  abortMediaUpload,
  beginMediaUpload,
  listReusableMediaUploadParts,
  MEDIA_UPLOAD_PART_SIZE,
} from '../../lib/media-storage'
import { adminProcedure } from '../../trpc'
import {
  MAX_MEDIA_ARCHIVE_BYTES as MAX_ARCHIVE_BYTES,
  MEDIA_SOURCE_FINGERPRINT_ALGORITHM,
  isNoSuchMediaUpload,
  safeMediaFileName as safeFileName,
} from './media-ingestion-helpers'

export const mediaIngestionBeginUploadRouter = router({
  beginUpload: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        projectId: z.string().min(1),
        uploadAttemptId: z
          .string()
          .uuid()
          .transform((value) => value.toLowerCase()),
        filename: z.string().trim().min(1).max(255),
        bytes: z.number().int().positive().max(MAX_ARCHIVE_BYTES),
        lastModified: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
        sourceIdentity: z
          .object({
            algorithm: z.literal(MEDIA_SOURCE_FINGERPRINT_ALGORITHM),
            digest: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .optional(),
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
            sourceObjectKey: true,
            status: true,
            stage: true,
            sourceFileName: true,
            sourceBytes: true,
            sourceLastModified: true,
            sourceFingerprintAlgorithm: true,
            sourceFingerprint: true,
            sourceObjectGeneration: true,
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
        project.sourceLastModified === BigInt(input.lastModified) &&
        ((project.sourceFingerprintAlgorithm === null &&
          project.sourceFingerprint === null &&
          input.sourceIdentity === undefined) ||
          (project.sourceFingerprintAlgorithm === input.sourceIdentity?.algorithm &&
            project.sourceFingerprint === input.sourceIdentity?.digest)) &&
        (project.sourceObjectGeneration === null ||
          project.sourceObjectGeneration === input.uploadAttemptId) &&
        project.sourceContentType === input.contentType &&
        project.sourceObjectKey &&
        project.storageUploadId
      ) {
        let reusableParts: Awaited<ReturnType<typeof listReusableMediaUploadParts>>
        try {
          reusableParts = await listReusableMediaUploadParts(
            project.sourceObjectKey,
            project.storageUploadId,
            input.bytes,
          )
        } catch (error) {
          if (isNoSuchMediaUpload(error)) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'This multipart upload expired. Abort it and start again.',
              cause: error,
            })
          }
          throw error
        }
        return {
          partSize: MEDIA_UPLOAD_PART_SIZE,
          parts: reusableParts.map(({ partNumber, etag, size }) => ({
            partNumber,
            etag,
            size,
          })),
        }
      }
      if (!['DRAFT', 'FAILED'].includes(project.status)) {
        throw new TRPCError({ code: 'CONFLICT', message: 'This project already has an upload.' })
      }
      if (project.uploadAttemptId === input.uploadAttemptId) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Start the replacement upload with a fresh attempt ID.',
        })
      }
      if (input.sourceIdentity === undefined) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Refresh the Media Lab before starting a new upload.',
        })
      }
      const sourceIdentity = input.sourceIdentity
      const objectKey = currentDeploymentStorageKey(
        `media-ingestion/${input.tenantId}/${project.venueId}/${project.id}/${input.uploadAttemptId}/${safeFileName(input.filename)}`,
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
            sourceLastModified: BigInt(input.lastModified),
            sourceFingerprintAlgorithm: sourceIdentity.algorithm,
            sourceFingerprint: sourceIdentity.digest,
            sourceObjectGeneration: input.uploadAttemptId,
            sourceContentType: input.contentType,
            uploadAttemptId: input.uploadAttemptId,
            uploadStartedAt: new Date(),
            storageUploadId: null,
            providerOperationCount: 0,
            error: null,
          },
        }),
      )
      if (reserved.count !== 1) {
        throw new TRPCError({ code: 'CONFLICT', message: 'This project already has an upload.' })
      }
      let started: Awaited<ReturnType<typeof beginMediaUpload>>
      try {
        started = await beginMediaUpload(objectKey, input.contentType, input.uploadAttemptId)
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
                sourceObjectGeneration: null,
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
            return { partSize: started.partSize, parts: [] }
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
      return { partSize: started.partSize, parts: [] }
    }),
})
