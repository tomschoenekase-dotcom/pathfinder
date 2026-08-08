import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import {
  finishMediaUpload,
  inspectCompletedMediaUpload,
  listReusableMediaUploadParts,
  MediaUploadCompletionUnconfirmedError,
  mediaUploadPartCount,
} from '../../lib/media-storage'
import { adminProcedure } from '../../trpc'
import { queueVerifiedMediaUpload } from './media-ingestion-finalization'
import {
  isNoSuchMediaUpload,
  MAX_MEDIA_ARCHIVE_BYTES as MAX_ARCHIVE_BYTES,
} from './media-ingestion-helpers'

const UNCONFIRMED_ERROR = 'Media upload finalization needs confirmation.'

async function retainUnconfirmedFinalization(input: {
  tenantId: string
  projectId: string
  uploadAttemptId: string
}) {
  await withTenantIsolationBypass(() =>
    db.mediaIngestionProject.updateMany({
      where: {
        id: input.projectId,
        tenantId: input.tenantId,
        status: 'UPLOADING',
        stage: 'finalizing',
        uploadAttemptId: input.uploadAttemptId,
      },
      data: { error: UNCONFIRMED_ERROR },
    }),
  )
}

async function rejectFinalization(input: {
  tenantId: string
  projectId: string
  uploadAttemptId: string
}) {
  const rejected = await withTenantIsolationBypass(() =>
    db.mediaIngestionProject.updateMany({
      where: {
        id: input.projectId,
        tenantId: input.tenantId,
        status: 'UPLOADING',
        stage: 'finalizing',
        uploadAttemptId: input.uploadAttemptId,
      },
      data: {
        status: 'FAILED',
        stage: 'completion-unverified',
        error: 'Media upload completion evidence was invalid.',
      },
    }),
  )
  if (rejected.count !== 1) {
    throw new TRPCError({ code: 'CONFLICT', message: 'The upload state already changed.' })
  }
  throw new TRPCError({
    code: 'CONFLICT',
    message: 'Media upload completion evidence was invalid. Start a new upload attempt.',
  })
}

export const mediaIngestionReconcileUploadRouter = router({
  reconcileUpload: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        projectId: z.string().min(1),
        uploadAttemptId: z
          .string()
          .uuid()
          .transform((value) => value.toLowerCase()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findFirst({
          where: {
            id: input.projectId,
            tenantId: input.tenantId,
            status: 'UPLOADING',
            stage: 'finalizing',
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
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Finalizing upload not found.' })
      }
      const expectedBytes = Number(project.sourceBytes)
      const queueVerified = (verifiedBytes: number) =>
        queueVerifiedMediaUpload({
          tenantId: input.tenantId,
          projectId: project.id,
          venueId: project.venueId,
          uploadAttemptId: input.uploadAttemptId,
          verifiedBytes,
          actorId: ctx.session.userId,
        })

      if (project.sourceObjectGeneration) {
        try {
          const inspection = await inspectCompletedMediaUpload(
            project.sourceObjectKey,
            expectedBytes,
            MAX_ARCHIVE_BYTES,
            project.sourceObjectGeneration,
          )
          if (inspection.state === 'verified') return queueVerified(inspection.bytes)
          if (inspection.state === 'identity-mismatch' || inspection.state === 'invalid') {
            return rejectFinalization(input)
          }
        } catch (error) {
          await retainUnconfirmedFinalization(input)
          throw new TRPCError({
            code: 'CONFLICT',
            message: UNCONFIRMED_ERROR,
            cause: error,
          })
        }
      }

      let reusableParts: Awaited<ReturnType<typeof listReusableMediaUploadParts>>
      try {
        reusableParts = await listReusableMediaUploadParts(
          project.sourceObjectKey,
          project.storageUploadId,
          expectedBytes,
        )
      } catch (error) {
        await retainUnconfirmedFinalization(input)
        throw new TRPCError({
          code: 'CONFLICT',
          message: UNCONFIRMED_ERROR,
          cause: isNoSuchMediaUpload(error) ? undefined : error,
        })
      }

      if (reusableParts.length !== mediaUploadPartCount(expectedBytes)) {
        const restored = await withTenantIsolationBypass(() =>
          db.mediaIngestionProject.updateMany({
            where: {
              id: project.id,
              tenantId: input.tenantId,
              status: 'UPLOADING',
              stage: 'finalizing',
              uploadAttemptId: input.uploadAttemptId,
            },
            data: {
              stage: 'upload',
              error: 'Some upload parts must be sent again before finalization.',
            },
          }),
        )
        if (restored.count !== 1) {
          throw new TRPCError({ code: 'CONFLICT', message: 'The upload state already changed.' })
        }
        return { ok: true, state: 'upload' as const }
      }

      try {
        const verified = await finishMediaUpload(
          project.sourceObjectKey,
          project.storageUploadId,
          reusableParts.map(({ partNumber, etag }) => ({ partNumber, etag })),
          expectedBytes,
          MAX_ARCHIVE_BYTES,
          project.sourceObjectGeneration ?? undefined,
        )
        return queueVerified(verified.bytes)
      } catch (error) {
        if (error instanceof MediaUploadCompletionUnconfirmedError) {
          await retainUnconfirmedFinalization(input)
          throw new TRPCError({ code: 'CONFLICT', message: UNCONFIRMED_ERROR, cause: error })
        }
        return rejectFinalization(input)
      }
    }),
})
