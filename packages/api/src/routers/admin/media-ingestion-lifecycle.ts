import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  assertVenueAvailable,
  claimMediaUploadAbortAction,
  db,
  saveMediaIngestionReviewAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { enqueueMediaIngestion } from '@pathfinder/jobs'
import { VenuePackagePayloadV1 } from '@pathfinder/contracts'

import { router } from '../../core'
import { adminAiProcedure, adminProcedure } from '../../trpc'
import { settleClaimedMediaUploadAbort } from './media-ingestion-abort'
import { isMediaIngestionActionError } from './media-ingestion-helpers'
import {
  mediaFindingCorrectionSchema,
  mediaFindingsSchema,
  mediaQuestionAnswerSchema,
  mediaQuestionSchema,
} from './media-ingestion-review-schemas'

export const mediaIngestionLifecycleRouter = router({
  retryEnqueue: adminAiProcedure
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
      try {
        await withTenantIsolationBypass(() =>
          assertVenueAvailable(db, {
            tenantId: input.tenantId,
            venueId: project.venueId,
          }),
        )
      } catch {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This venue is temporarily unavailable.',
        })
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
      let projectScope = await withTenantIsolationBypass(() =>
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
            stage: true,
            sourceObjectKey: true,
            storageUploadId: true,
          },
        }),
      )
      let resumedAbort = false
      if (!projectScope) {
        projectScope = await withTenantIsolationBypass(() =>
          db.mediaIngestionProject.findFirst({
            where: {
              id: input.projectId,
              tenantId: input.tenantId,
              status: 'UPLOADING',
              stage: 'aborting',
              uploadAttemptId: input.uploadAttemptId,
            },
            select: {
              id: true,
              venueId: true,
              stage: true,
              sourceObjectKey: true,
              storageUploadId: true,
            },
          }),
        )
        resumedAbort = projectScope !== null
      }
      if (!projectScope) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Active upload not found.' })
      }
      let claim
      try {
        claim = await claimMediaUploadAbortAction({
          tenantId: input.tenantId,
          venueId: projectScope.venueId,
          projectId: input.projectId,
          uploadAttemptId: input.uploadAttemptId,
          expectedStage: resumedAbort ? 'aborting' : 'upload',
          ...(projectScope.sourceObjectKey
            ? { expectedSourceObjectKey: projectScope.sourceObjectKey }
            : {}),
          ...(projectScope.storageUploadId
            ? { expectedStorageUploadId: projectScope.storageUploadId }
            : {}),
          actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
        })
      } catch (error) {
        if (isMediaIngestionActionError(error)) {
          throw new TRPCError({
            code: error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'CONFLICT',
            message:
              error.code === 'NOT_FOUND'
                ? 'Active upload not found.'
                : 'The upload state already changed.',
            cause: error,
          })
        }
        throw error
      }
      return settleClaimedMediaUploadAbort({
        tenantId: input.tenantId,
        venueId: projectScope.venueId,
        projectId: input.projectId,
        uploadAttemptId: input.uploadAttemptId,
        sourceObjectKey: claim.sourceObjectKey,
        storageUploadId: claim.storageUploadId,
        resumedAbort: claim.resumed,
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
      let nextUpdatedAt: Date
      try {
        const saved = await saveMediaIngestionReviewAction({
          tenantId: input.tenantId,
          venueId: input.venueId,
          projectId: input.projectId,
          reviewGeneration: input.reviewGeneration,
          expectedUpdatedAt: input.expectedUpdatedAt,
          questions: reviewedQuestions,
          draftJson: input.draftJson,
          findings: reviewedFindings,
          status: hasUnansweredQuestions ? 'NEEDS_INPUT' : 'READY_FOR_REVIEW',
          stage: hasUnansweredQuestions ? 'questions' : 'review',
          actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
        })
        nextUpdatedAt = saved.updatedAt
      } catch (error) {
        if (!isMediaIngestionActionError(error)) throw error
        throw new TRPCError({
          code: error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'CONFLICT',
          message:
            error.code === 'NOT_FOUND'
              ? 'Reviewable media project not found.'
              : 'This review changed in another session. Reload before saving again.',
          cause: error,
        })
      }
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
