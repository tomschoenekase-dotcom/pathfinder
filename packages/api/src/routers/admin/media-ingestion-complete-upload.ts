import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { logger } from '@pathfinder/config'
import { db, withTenantIsolationBypass, writeAuditLog } from '@pathfinder/db'
import { enqueueMediaIngestion } from '@pathfinder/jobs'

import { router } from '../../core'
import {
  canonicalMediaUploadEtag,
  finishMediaUpload,
  listReusableMediaUploadParts,
  mediaUploadPartCount,
  normalizeMediaUploadParts,
  signMediaUploadPart,
} from '../../lib/media-storage'
import { adminProcedure } from '../../trpc'
import { MAX_MEDIA_ARCHIVE_BYTES as MAX_ARCHIVE_BYTES } from './media-ingestion-helpers'

export const mediaIngestionCompleteUploadRouter = router({
  signPart: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        projectId: z.string().min(1),
        uploadAttemptId: z.string().uuid(),
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
        uploadAttemptId: z.string().uuid(),
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
      const claimed = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.updateMany({
          where: {
            id: project.id,
            tenantId: input.tenantId,
            status: 'UPLOADING',
            stage: 'upload',
            uploadAttemptId: input.uploadAttemptId,
          },
          data: { stage: 'finalizing', error: null },
        }),
      )
      if (claimed.count !== 1) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This upload is already being finalized.',
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
        )
        verifiedBytes = verified.bytes
      } catch (error) {
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
      let transitionedCount: number | null = null
      let transitionError: unknown
      try {
        const transitioned = await withTenantIsolationBypass(() =>
          db.mediaIngestionProject.updateMany({
            where: {
              id: project.id,
              tenantId: input.tenantId,
              status: 'UPLOADING',
              stage: 'finalizing',
              uploadAttemptId: input.uploadAttemptId,
            },
            data: {
              status: 'QUEUED',
              stage: 'inventory',
              progress: 1,
              sourceBytes: BigInt(verifiedBytes),
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
                id: project.id,
                tenantId: input.tenantId,
                uploadAttemptId: input.uploadAttemptId,
              },
              select: { status: true, stage: true, sourceBytes: true },
            }),
          )
        } catch (readbackError) {
          logger.warn({
            action: 'media-ingestion.upload-queue-transition.uncertain',
            projectId: project.id,
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
          readback.sourceBytes === BigInt(verifiedBytes)
        const alreadyProcessing =
          readback !== null &&
          ['INVENTORYING', 'ANALYZING', 'SYNTHESIZING'].includes(readback.status)
        if (alreadyProcessing) return { ok: true }
        if (!exactQueued) {
          if (transitionError !== undefined) {
            logger.warn({
              action: 'media-ingestion.upload-queue-transition.uncertain',
              projectId: project.id,
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
          venueId: project.venueId,
          projectId: project.id,
          uploadAttemptId: input.uploadAttemptId,
        })
      } catch (error) {
        try {
          await withTenantIsolationBypass(() =>
            db.mediaIngestionProject.updateMany({
              where: {
                id: project.id,
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
            projectId: project.id,
            uploadAttemptId: input.uploadAttemptId,
            error: 'Upload enqueue state could not be recorded.',
            errorType: statusError instanceof Error ? statusError.name : 'UnknownError',
          })
        }
        throw error
      }
      await writeAuditLog({
        tenantId: input.tenantId,
        actorId: ctx.session.userId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.media_ingestion.upload_completed',
        targetType: 'MediaIngestionProject',
        targetId: project.id,
      })
      return { ok: true }
    }),
})
