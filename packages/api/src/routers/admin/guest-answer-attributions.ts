import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { env } from '@pathfinder/config'
import { GuestAnswerClaimInputSchema } from '@pathfinder/contracts/guest-answer-attribution'
import {
  db,
  GuestAnswerAttributionActionError,
  GuestAnswerAttributionEvaluationError,
  isEvaluationRuntimeDurablyEnabled,
  prepareGuestAnswerAttributionEvaluationRequestAction,
  queueGuestAnswerAttributionEvaluationRequestAction,
  readGuestAnswerAttributionAgreement,
  recordHumanReviewedGuestAnswerAttributionAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { enqueueGuestAnswerAttributionEvaluation } from '@pathfinder/jobs'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const scopeSchema = z
  .object({
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
  })
  .strict()

const evaluatorSchema = z
  .object({
    provider: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(191),
    configurationVersion: z.string().trim().min(1).max(191),
    promptVersion: z.string().trim().min(1).max(191),
  })
  .strict()

function mapActionError(error: unknown): never {
  if (
    error instanceof GuestAnswerAttributionActionError ||
    error instanceof GuestAnswerAttributionEvaluationError
  ) {
    throw new TRPCError({
      code:
        error.code === 'INVALID_INPUT'
          ? 'BAD_REQUEST'
          : error.code === 'PRECONDITION_FAILED'
            ? 'PRECONDITION_FAILED'
            : error.code,
      message: error.message,
      cause: error,
    })
  }
  throw error
}

const attributionSelect = {
  id: true,
  operationId: true,
  guestChatTurnId: true,
  schemaVersion: true,
  answerHash: true,
  evidenceSetHash: true,
  evaluatorProvider: true,
  evaluatorModel: true,
  evaluatorConfiguration: true,
  evaluatorPromptVersion: true,
  attributionSnapshot: true,
  claimCount: true,
  supportedCount: true,
  unsupportedCount: true,
  uncertainCount: true,
  nonFactualCount: true,
  supportRate: true,
  actorType: true,
  actorId: true,
  createdAt: true,
} as const

export const adminGuestAnswerAttributionsRouter = router({
  listGuestAnswerAttributionEvaluationRequests: adminProcedure
    .input(scopeSchema.extend({ limit: z.number().int().min(1).max(100).default(25) }).strict())
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const [items, durableGlobalEnabled, tenantFlag] = await Promise.all([
          db.guestAnswerAttributionEvaluationRequest.findMany({
            where: { tenantId: input.tenantId, venueId: input.venueId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: input.limit,
            select: {
              id: true,
              guestChatTurnId: true,
              answerHash: true,
              evidenceSetHash: true,
              status: true,
              attemptNumber: true,
              providerDispatchedAt: true,
              resultAttributionId: true,
              lastErrorCode: true,
              createdById: true,
              queuedAt: true,
              startedAt: true,
              completedAt: true,
              failedAt: true,
              createdAt: true,
            },
          }),
          isEvaluationRuntimeDurablyEnabled(db),
          db.tenantFeatureFlag.findUnique({
            where: {
              tenantId_flagKey: {
                tenantId: input.tenantId,
                flagKey: 'evaluation-runner-v1',
              },
            },
            select: { enabled: true },
          }),
        ])
        const readiness = {
          processEnabled: env.EVALUATION_RUNNER_ENABLED,
          durableGlobalEnabled,
          tenantEnabled: tenantFlag?.enabled === true,
        }
        return {
          items,
          readiness,
          executionEnabled: Object.values(readiness).every(Boolean),
          advisoryOnly: true as const,
        }
      }),
    ),

  prepareGuestAnswerAttributionEvaluation: adminProcedure
    .input(
      scopeSchema
        .extend({ operationId: z.string().uuid(), guestChatTurnId: z.string().uuid() })
        .strict(),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        return await withTenantIsolationBypass(() =>
          prepareGuestAnswerAttributionEvaluationRequestAction({
            ...input,
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          }),
        )
      } catch (error) {
        mapActionError(error)
      }
    }),

  queueGuestAnswerAttributionEvaluation: adminProcedure
    .input(scopeSchema.extend({ requestId: z.string().uuid() }).strict())
    .mutation(async ({ input, ctx }) => {
      if (!env.EVALUATION_RUNNER_ENABLED)
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Evaluation execution is not enabled for this API process',
        })
      try {
        const [durableGlobalEnabled, tenantFlag] = await withTenantIsolationBypass(() =>
          Promise.all([
            isEvaluationRuntimeDurablyEnabled(db),
            db.tenantFeatureFlag.findUnique({
              where: {
                tenantId_flagKey: {
                  tenantId: input.tenantId,
                  flagKey: 'evaluation-runner-v1',
                },
              },
              select: { enabled: true },
            }),
          ]),
        )
        if (!durableGlobalEnabled || tenantFlag?.enabled !== true)
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Evaluation execution is not durably enabled for this tenant',
          })
        const queued = await withTenantIsolationBypass(() =>
          queueGuestAnswerAttributionEvaluationRequestAction({
            ...input,
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          }),
        )
        const published = await enqueueGuestAnswerAttributionEvaluation(
          {
            ...input,
            answerHash: queued.request.answerHash,
            evidenceSetHash: queued.request.evidenceSetHash,
          },
          { enabled: true },
        )
        return { ...queued, enqueued: published.enqueued }
      } catch (error) {
        mapActionError(error)
      }
    }),

  recordHumanReviewedGuestAnswerAttribution: adminProcedure
    .input(
      scopeSchema
        .extend({
          operationId: z.string().uuid(),
          guestChatTurnId: z.string().uuid(),
          evaluator: evaluatorSchema,
          claims: z.array(GuestAnswerClaimInputSchema).max(100),
        })
        .strict(),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        return await withTenantIsolationBypass(() =>
          recordHumanReviewedGuestAnswerAttributionAction(
            {
              ...input,
              actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
            },
            db,
          ),
        )
      } catch (error) {
        mapActionError(error)
      }
    }),

  listGuestAnswerAttributions: adminProcedure
    .input(
      scopeSchema
        .extend({
          guestChatTurnId: z.string().uuid().optional(),
          limit: z.number().int().min(1).max(100).default(25),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(() =>
        db.guestAnswerAttribution.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            ...(input.guestChatTurnId ? { guestChatTurnId: input.guestChatTurnId } : {}),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit,
          select: attributionSelect,
        }),
      ),
    ),

  previewGuestAnswerAttributionAgreement: adminProcedure
    .input(
      scopeSchema
        .extend({
          limit: z.number().int().min(2).max(100).default(100),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(() => readGuestAnswerAttributionAgreement(input, db)),
    ),
})
