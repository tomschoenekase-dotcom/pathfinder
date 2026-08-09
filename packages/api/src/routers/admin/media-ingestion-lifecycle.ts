import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, withTenantIsolationBypass, writeAuditLog } from '@pathfinder/db'
import { enqueueMediaIngestion } from '@pathfinder/jobs'
import { VenuePackagePayloadV1 } from '@pathfinder/contracts'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { settleClaimedMediaUploadAbort } from './media-ingestion-abort'
import {
  mediaFindingCorrectionSchema,
  mediaFindingsSchema,
  mediaQuestionAnswerSchema,
  mediaQuestionSchema,
} from './media-ingestion-review-schemas'

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
        venueId: z.string().min(1),
        projectId: z.string().min(1),
        reviewGeneration: z.string().uuid().nullable(),
        expectedUpdatedAt: z.coerce.date(),
        questionAnswers: z.array(mediaQuestionAnswerSchema).max(500),
        draftJson: VenuePackagePayloadV1,
        findingCorrections: z.array(mediaFindingCorrectionSchema).max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findFirst({
          where: {
            id: input.projectId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            status: { in: ['NEEDS_INPUT', 'READY_FOR_REVIEW'] },
          },
          select: { findings: true, questions: true, sourceObjectGeneration: true },
        }),
      )
      if (!project) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Reviewable media project not found.' })
      }
      if (project.sourceObjectGeneration !== input.reviewGeneration) {
        throw new TRPCError({ code: 'CONFLICT', message: 'The media source generation changed.' })
      }
      const findings = mediaFindingsSchema.parse(project.findings)
      const questions = z.array(mediaQuestionSchema).max(500).parse(project.questions)
      const answers = new Map<string, string>()
      for (const answer of input.questionAnswers) {
        if (answers.has(answer.id)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Duplicate media question answer.' })
        }
        answers.set(answer.id, answer.answer)
      }
      const knownQuestionIds = new Set(questions.map((question) => question.id))
      if ([...answers.keys()].some((id) => !knownQuestionIds.has(id))) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown media question answer.' })
      }
      const reviewedQuestions = questions.map((question) =>
        answers.has(question.id) ? { ...question, answer: answers.get(question.id) } : question,
      )
      const hasUnansweredQuestions = reviewedQuestions.some((question) => !question.answer?.trim())
      const corrections = new Map<string, (typeof input.findingCorrections)[number]>()
      for (const correction of input.findingCorrections) {
        if (corrections.has(correction.sourceId)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Duplicate finding correction.' })
        }
        corrections.set(correction.sourceId, correction)
      }
      const knownSourceIds = new Set(findings.map((finding) => finding.sourceId))
      if ([...corrections.keys()].some((sourceId) => !knownSourceIds.has(sourceId))) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown media finding correction.' })
      }
      const reviewedAt = new Date().toISOString()
      const reviewedFindings = findings.map((finding) => {
        const correction = corrections.get(finding.sourceId)
        if (!correction) return finding
        return {
          ...finding,
          review: {
            summary: correction.summary,
            uncertainties: correction.uncertainties,
            note: correction.note,
            reviewedBy: ctx.session.userId,
            reviewedAt,
          },
        }
      })
      const nextUpdatedAt = new Date(Math.max(Date.now(), input.expectedUpdatedAt.getTime() + 1))
      const result = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.updateMany({
          where: {
            id: input.projectId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            status: { in: ['NEEDS_INPUT', 'READY_FOR_REVIEW'] },
            sourceObjectGeneration: input.reviewGeneration,
            updatedAt: input.expectedUpdatedAt,
          },
          data: {
            questions: reviewedQuestions,
            draftJson: input.draftJson,
            findings: reviewedFindings,
            status: hasUnansweredQuestions ? 'NEEDS_INPUT' : 'READY_FOR_REVIEW',
            stage: hasUnansweredQuestions ? 'questions' : 'review',
            updatedAt: nextUpdatedAt,
          },
        }),
      )
      if (result.count === 0) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This review changed in another session. Reload before saving again.',
        })
      }
      await writeAuditLog({
        tenantId: input.tenantId,
        actorId: ctx.session.userId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.media_ingestion.review_saved',
        targetType: 'MediaIngestionProject',
        targetId: input.projectId,
      })
      return {
        ok: true,
        updatedAt: nextUpdatedAt,
        status: hasUnansweredQuestions ? ('NEEDS_INPUT' as const) : ('READY_FOR_REVIEW' as const),
        questions: reviewedQuestions,
        findingReviews: reviewedFindings.flatMap((finding) =>
          corrections.has(finding.sourceId) && finding.review
            ? [{ sourceId: finding.sourceId, review: finding.review }]
            : [],
        ),
      }
    }),
})
