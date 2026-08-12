import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { logger } from '@pathfinder/config'
import { claimMediaUploadFinalizationAction, db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import {
  canonicalMediaUploadEtag,
  finishMediaUpload,
  listReusableMediaUploadParts,
  MediaUploadCompletionUnconfirmedError,
  mediaUploadPartCount,
  normalizeMediaUploadParts,
  signMediaUploadPart,
} from '../../lib/media-storage'
import { adminProcedure } from '../../trpc'
import { queueVerifiedMediaUpload } from './media-ingestion-finalization'
import {
  isMediaIngestionActionError,
  MAX_MEDIA_ARCHIVE_BYTES as MAX_ARCHIVE_BYTES,
} from './media-ingestion-helpers'

export const mediaIngestionCompleteUploadRouter = router({
  signPart: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        projectId: z.string().min(1),
        uploadAttemptId: z
          .string()
          .uuid()
          .transform((value) => value.toLowerCase()),
        partNumber: z.number().int().min(1).max(10_000),
      }),
    )
    .mutation(async ({ input }) => {
      const project = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findFirst({
          where: {
            id: input.projectId,
            tenantId: input.tenantId,
            status: 'UPLOADING',
            stage: 'upload',
            uploadAttemptId: input.uploadAttemptId,
          },
          select: { sourceObjectKey: true, sourceBytes: true, storageUploadId: true },
        }),
      )
      if (!project?.sourceObjectKey || project.sourceBytes === null || !project.storageUploadId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Active upload not found.' })
      }
      const expectedPartCount = mediaUploadPartCount(Number(project.sourceBytes))
      if (input.partNumber > expectedPartCount) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `This upload has only ${expectedPartCount} parts.`,
        })
      }
      return {
        url: await signMediaUploadPart(
          project.sourceObjectKey,
          project.storageUploadId,
          input.partNumber,
        ),
      }
    }),

  completeUpload: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        projectId: z.string().min(1),
        uploadAttemptId: z
          .string()
          .uuid()
          .transform((value) => value.toLowerCase()),
        parts: z
          .array(
            z.object({
              partNumber: z.number().int().min(1).max(10_000),
              etag: z.string().min(1),
            }),
          )
          .min(1)
          .max(10_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findFirst({
          where: {
            id: input.projectId,
            tenantId: input.tenantId,
            status: 'UPLOADING',
            stage: 'upload',
            uploadAttemptId: input.uploadAttemptId,
          },
          select: {
            id: true,
            venueId: true,
            sourceObjectKey: true,
            sourceBytes: true,
            sourceObjectGeneration: true,
            storageUploadId: true,
          },
        }),
      )
      if (!project?.sourceObjectKey || project.sourceBytes === null || !project.storageUploadId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Active upload not found.' })
      }
      const expectedBytes = Number(project.sourceBytes)
      let submittedParts: Array<{ partNumber: number; etag: string }>
      try {
        submittedParts = normalizeMediaUploadParts(input.parts, mediaUploadPartCount(expectedBytes))
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Invalid media upload parts.',
          cause: error,
        })
      }
      const storageParts = await listReusableMediaUploadParts(
        project.sourceObjectKey,
        project.storageUploadId,
        expectedBytes,
      )
      const exactStorageMatch =
        storageParts.length === submittedParts.length &&
        storageParts.every(
          (part, index) =>
            part.partNumber === submittedParts[index]?.partNumber &&
            canonicalMediaUploadEtag(part.etag) ===
              canonicalMediaUploadEtag(submittedParts[index]?.etag ?? ''),
        )
      if (!exactStorageMatch) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Uploaded parts changed; refresh the resumable upload state and try again.',
        })
      }
      const parts = storageParts.map(({ partNumber, etag }) => ({ partNumber, etag }))
      try {
        await claimMediaUploadFinalizationAction({
          tenantId: input.tenantId,
          venueId: project.venueId,
          projectId: project.id,
          uploadAttemptId: input.uploadAttemptId,
          actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
        })
      } catch (error) {
        if (!isMediaIngestionActionError(error)) throw error
        throw new TRPCError({
          code: error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'CONFLICT',
          message:
            error.code === 'NOT_FOUND'
              ? 'Active upload not found.'
              : 'This upload is already being finalized.',
          cause: error,
        })
      }
      let verifiedBytes: number
      try {
        const verified = await finishMediaUpload(
          project.sourceObjectKey,
          project.storageUploadId,
          parts,
          expectedBytes,
          MAX_ARCHIVE_BYTES,
          project.sourceObjectGeneration ?? undefined,
        )
        verifiedBytes = verified.bytes
      } catch (error) {
        if (error instanceof MediaUploadCompletionUnconfirmedError) {
          await withTenantIsolationBypass(() =>
            db.mediaIngestionProject.updateMany({
              where: {
                id: project.id,
                tenantId: input.tenantId,
                status: 'UPLOADING',
                stage: 'finalizing',
                uploadAttemptId: input.uploadAttemptId,
              },
              data: { error: 'Media upload finalization needs confirmation.' },
            }),
          )
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Media upload finalization needs confirmation.',
            cause: error,
          })
        }
        const message = error instanceof Error ? error.message : 'Media upload completion failed.'
        try {
          const compensated = await withTenantIsolationBypass(() =>
            db.mediaIngestionProject.updateMany({
              where: {
                id: project.id,
                tenantId: input.tenantId,
                status: 'UPLOADING',
                stage: 'finalizing',
                uploadAttemptId: input.uploadAttemptId,
              },
              data: { status: 'FAILED', stage: 'upload', error: message },
            }),
          )
          if (compensated.count !== 1) {
            logger.warn({
              action: 'media-ingestion.upload-finalization-compensation.missed',
              projectId: project.id,
              error: 'The finalization claim no longer matched.',
            })
          }
        } catch (compensationError) {
          logger.warn({
            action: 'media-ingestion.upload-finalization-compensation.failed',
            projectId: project.id,
            error:
              compensationError instanceof Error
                ? compensationError.message
                : 'Unknown compensation error',
          })
        }
        throw error
      }
      return queueVerifiedMediaUpload({
        tenantId: input.tenantId,
        projectId: project.id,
        venueId: project.venueId,
        uploadAttemptId: input.uploadAttemptId,
        verifiedBytes,
        actorId: ctx.session.userId,
      })
    }),
})
