import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, withTenantIsolationBypass, writeAuditLog } from '@pathfinder/db'
import { enqueueMediaIngestion } from '@pathfinder/jobs'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { settleClaimedMediaUploadAbort } from './media-ingestion-abort'

export const mediaIngestionLifecycleRouter = router({
  retryEnqueue: adminProcedure
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
    .mutation(async ({ input }) => {
      const project = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findFirst({
          where: {
            id: input.projectId,
            tenantId: input.tenantId,
            status: 'QUEUED',
            stage: 'inventory',
            uploadAttemptId: input.uploadAttemptId,
          },
          select: { id: true, venueId: true },
        }),
      )
      if (!project) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Queued upload generation not found.' })
      }
      await enqueueMediaIngestion({
        tenantId: input.tenantId,
        venueId: project.venueId,
        projectId: project.id,
        uploadAttemptId: input.uploadAttemptId,
      })
      return { ok: true }
    }),

  abortUpload: adminProcedure
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
      let project = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findFirst({
          where: {
            id: input.projectId,
            tenantId: input.tenantId,
            status: 'UPLOADING',
            stage: 'upload',
            uploadAttemptId: input.uploadAttemptId,
          },
          select: { id: true, sourceObjectKey: true, storageUploadId: true },
        }),
      )
      let resumedAbort = false
      if (!project) {
        project = await withTenantIsolationBypass(() =>
          db.mediaIngestionProject.findFirst({
            where: {
              id: input.projectId,
              tenantId: input.tenantId,
              status: 'UPLOADING',
              stage: 'aborting',
              uploadAttemptId: input.uploadAttemptId,
            },
            select: { id: true, sourceObjectKey: true, storageUploadId: true },
          }),
        )
        resumedAbort = project !== null
      }
      if (!project?.sourceObjectKey || !project.storageUploadId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Active upload not found.' })
      }
      if (!resumedAbort) {
        const claimed = await withTenantIsolationBypass(() =>
          db.mediaIngestionProject.updateMany({
            where: {
              id: project.id,
              tenantId: input.tenantId,
              status: 'UPLOADING',
              stage: 'upload',
              uploadAttemptId: input.uploadAttemptId,
            },
            data: { stage: 'aborting', error: null },
          }),
        )
        if (claimed.count !== 1) {
          throw new TRPCError({ code: 'CONFLICT', message: 'The upload state already changed.' })
        }
      }
      return settleClaimedMediaUploadAbort({
        tenantId: input.tenantId,
        projectId: project.id,
        uploadAttemptId: input.uploadAttemptId,
        sourceObjectKey: project.sourceObjectKey,
        storageUploadId: project.storageUploadId,
        resumedAbort,
        actorId: ctx.session.userId,
        auditAction: 'admin.media_ingestion.upload_aborted',
      })
    }),

  saveReview: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        projectId: z.string().min(1),
        questions: z.array(z.record(z.unknown())).max(500),
        draftJson: z.record(z.unknown()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.updateMany({
          where: { id: input.projectId, tenantId: input.tenantId },
          data: {
            questions: input.questions,
            draftJson: input.draftJson,
            status: 'READY_FOR_REVIEW',
            stage: 'review',
          },
        }),
      )
      if (result.count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Media project not found.' })
      }
      await writeAuditLog({
        tenantId: input.tenantId,
        actorId: ctx.session.userId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.media_ingestion.review_saved',
        targetType: 'MediaIngestionProject',
        targetId: input.projectId,
      })
      return { ok: true }
    }),
})
