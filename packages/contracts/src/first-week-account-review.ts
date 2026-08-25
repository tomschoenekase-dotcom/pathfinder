import { z } from 'zod'

export const FIRST_WEEK_ACCOUNT_REVIEW_VERSION = 1 as const

export const FirstWeekReviewMilestone = z.enum(['DAY_1', 'DAY_3', 'DAY_7'])
export type FirstWeekReviewMilestone = z.infer<typeof FirstWeekReviewMilestone>

export const FirstWeekReviewDisposition = z.enum(['NO_ACTION', 'DRAFT_READY'])
export type FirstWeekReviewDisposition = z.infer<typeof FirstWeekReviewDisposition>

const count = z.number().int().nonnegative()

/** Privacy-bounded aggregates only. Raw messages, feedback reasons, and customer data are excluded. */
export const FirstWeekAccountReviewMetrics = z
  .object({
    publicSessions: count,
    guestQuestions: count,
    lowConfidenceInsights: count,
    knowledgeGapInsights: count,
    negativeFeedback: count,
    supportRequestsCreated: count,
    aiRequests: count,
    failedAiRequests: count,
    estimatedAiCostUsd: z.string().regex(/^\d+(?:\.\d{1,8})?$/u),
  })
  .strict()
export type FirstWeekAccountReviewMetrics = z.infer<typeof FirstWeekAccountReviewMetrics>

export const FirstWeekAccountReviewSnapshot = z
  .object({
    version: z.literal(FIRST_WEEK_ACCOUNT_REVIEW_VERSION),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    releaseMilestoneEventId: z.string().uuid(),
    milestone: FirstWeekReviewMilestone,
    releaseAt: z.string().datetime({ offset: true }),
    dueAt: z.string().datetime({ offset: true }),
    metrics: FirstWeekAccountReviewMetrics,
    disposition: FirstWeekReviewDisposition,
    draftSubject: z.string().trim().min(1).max(191).nullable(),
    draftBody: z.string().trim().min(1).max(4000).nullable(),
    draftReason: z.string().trim().min(1).max(500).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasDraft =
      value.draftSubject !== null && value.draftBody !== null && value.draftReason !== null
    if (value.disposition === 'DRAFT_READY' && !hasDraft) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['draftSubject'],
        message: 'Draft-ready reviews require a complete draft and reason.',
      })
    }
    if (
      value.disposition === 'NO_ACTION' &&
      (value.draftSubject !== null || value.draftBody !== null || value.draftReason !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['draftSubject'],
        message: 'No-action reviews must not contain a communication draft.',
      })
    }
  })
export type FirstWeekAccountReviewSnapshot = z.infer<typeof FirstWeekAccountReviewSnapshot>
