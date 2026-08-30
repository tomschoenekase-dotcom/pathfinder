import { randomUUID } from 'node:crypto'

import { EVAL_SCHEMA_VERSION, EvalCaseSchema } from '@pathfinder/contracts/evaluation'
import {
  createOrReplayEvaluationCase,
  db,
  hashEvalCase,
  listConversationKnowledgeGaps,
  withTenantIsolationBypass,
  writeAuditLogStrict,
} from '@pathfinder/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const reviewableCategories = [
  'LOW_CONFIDENCE_ANSWER',
  'KNOWLEDGE_GAP',
  'CONTENT_UPDATE_CANDIDATE',
  'VISITOR_NEGATIVE_FEEDBACK',
] as const

const scopedInput = z.object({
  tenantId: z.string().trim().min(1).max(191),
  venueId: z.string().trim().min(1).max(191),
})

const phrase = z.string().trim().min(1).max(300)

const prepareInput = scopedInput
  .extend({
    insightId: z.string().uuid(),
    sanitizedQuestion: z.string().trim().min(1).max(2_000),
    expectation: z.enum(['KNOWN_ANSWER', 'UNKNOWN_ANSWER']),
    acceptablePhrases: z.array(phrase).min(1).max(10),
    forbiddenPhrases: z.array(phrase).max(20).default([]),
    maxWords: z.number().int().min(1).max(1_000).default(200),
    sanitizationConfirmed: z.literal(true),
  })
  .strict()
  .superRefine((value, context) => {
    const normalized = [...value.acceptablePhrases, ...value.forbiddenPhrases].map((item) =>
      item.normalize('NFC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim(),
    )
    if (new Set(normalized).size !== normalized.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acceptablePhrases'],
        message: 'Expected and forbidden phrases must be unique and must not overlap',
      })
    }
  })

function unique(values: string[]): string[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const key = value.normalize('NFC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const adminEvaluationConversationCasesRouter = router({
  listEvaluationSourceInsights: adminProcedure
    .input(scopedInput.extend({ limit: z.number().int().min(1).max(25).default(10) }).strict())
    .query(({ input }) =>
      withTenantIsolationBypass(() => listConversationKnowledgeGaps(input, db)),
    ),

  prepareConversationEvaluationCase: adminProcedure.input(prepareInput).mutation(({ input, ctx }) =>
    withTenantIsolationBypass(() =>
      db.$transaction(async (tx) => {
        const insight = await tx.conversationInsight.findFirst({
          where: {
            id: input.insightId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            category: { in: [...reviewableCategories] },
            reviewStatus: { in: ['UNREVIEWED', 'ACKNOWLEDGED'] },
            guestChatTurnId: { not: null },
            session: { experienceScope: 'PUBLIC' },
          },
          select: {
            id: true,
            category: true,
            reviewStatus: true,
            guestChatTurnId: true,
            guestChatTurn: {
              select: {
                id: true,
                userMessage: { select: { id: true } },
                assistantMessage: {
                  select: {
                    id: true,
                    feedback: { select: { rating: true }, take: 10 },
                  },
                },
              },
            },
          },
        })
        if (!insight?.guestChatTurn?.userMessage || !insight.guestChatTurn.assistantMessage) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Reviewable public conversation evidence was not found',
          })
        }
        if (
          insight.category === 'VISITOR_NEGATIVE_FEEDBACK' &&
          !insight.guestChatTurn.assistantMessage.feedback.some(
            (feedback) => feedback.rating === 'NOT_HELPFUL',
          )
        ) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'The source answer no longer has active negative visitor feedback',
          })
        }

        const [venue, places] = await Promise.all([
          tx.venue.findFirst({
            where: { id: input.venueId, tenantId: input.tenantId },
            select: { guideMode: true },
          }),
          tx.place.findMany({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              isActive: true,
              visibility: 'PUBLIC',
            },
            orderBy: [{ importanceScore: 'desc' }, { name: 'asc' }, { id: 'asc' }],
            take: 100,
            select: { name: true },
          }),
        ])
        if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue was not found' })

        const caseKey = `conversation-insight-${insight.id}`
        const placeNames = unique(places.map((place) => place.name))
        const category = input.expectation === 'KNOWN_ANSWER' ? 'known-answer' : 'unknown-answer'
        const parsedCase = EvalCaseSchema.safeParse({
          schemaVersion: EVAL_SCHEMA_VERSION,
          caseId: caseKey,
          category,
          venue: {
            fixtureId: 'reviewed-conversation',
            guideMode: venue.guideMode === 'non_location' ? 'non_location' : 'location_aware',
            placeNameUniverse: placeNames,
            allowedPlaceNames: placeNames,
          },
          turns: [{ role: 'user', content: input.sanitizedQuestion }],
          rules: {
            requiredPhrases: [],
            requiredFacts:
              input.expectation === 'KNOWN_ANSWER'
                ? [
                    {
                      ruleId: 'human-expected-answer',
                      acceptablePhrases: input.acceptablePhrases,
                    },
                  ]
                : [],
            forbiddenPhrases: input.forbiddenPhrases.map((item, index) => ({
              ruleId: `human-forbidden-${index + 1}`,
              phrase: item,
            })),
            maxWords: input.maxWords,
            unknownAnswer: {
              required: input.expectation === 'UNKNOWN_ANSWER',
              ruleId: 'human-unknown-boundary',
              acceptablePhrases:
                input.expectation === 'UNKNOWN_ANSWER' ? input.acceptablePhrases : [],
            },
          },
        })
        if (!parsedCase.success) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: parsedCase.error.issues[0]?.message ?? 'Evaluation case is invalid',
          })
        }

        const sourceType = 'REVIEWED_CONVERSATION_INSIGHT'
        const sourceRef = `conversation-insight:${insight.id}:turn:${insight.guestChatTurn.id}`
        const latest = await tx.evalCase.findFirst({
          where: { tenantId: input.tenantId, venueId: input.venueId, caseKey },
          orderBy: { revision: 'desc' },
          select: {
            id: true,
            revision: true,
            caseHash: true,
            sourceType: true,
            sourceRef: true,
          },
        })
        const caseHash = hashEvalCase(parsedCase.data)
        const exactReplay =
          latest?.caseHash === caseHash &&
          latest.sourceType === sourceType &&
          latest.sourceRef === sourceRef
        const revision = exactReplay ? latest.revision : (latest?.revision ?? 0) + 1
        const result = await createOrReplayEvaluationCase({
          db: tx,
          caseId: exactReplay ? latest.id : randomUUID(),
          identity: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            caseKey,
            revision,
            schemaVersion: parsedCase.data.schemaVersion,
            category: parsedCase.data.category,
            caseSnapshot: parsedCase.data,
            createdBy: ctx.session.userId,
            sourceType,
            sourceRef,
          },
        })

        if (insight.reviewStatus === 'UNREVIEWED') {
          await tx.conversationInsight.updateMany({
            where: {
              id: insight.id,
              tenantId: input.tenantId,
              venueId: input.venueId,
              reviewStatus: 'UNREVIEWED',
            },
            data: {
              reviewStatus: 'ACKNOWLEDGED',
              reviewedBy: ctx.session.userId,
              reviewedAt: new Date(),
            },
          })
        }

        await writeAuditLogStrict(
          {
            tenantId: input.tenantId,
            actorId: ctx.session.userId,
            actorRole: 'PLATFORM_ADMIN',
            action: 'evaluation-case.prepared-from-conversation',
            targetType: 'EvalCase',
            targetId: result.evalCase.id,
            sourceReferences: [
              `conversation-insight:${insight.id}`,
              `guest-chat-turn:${insight.guestChatTurn.id}`,
            ],
            afterState: {
              venueId: input.venueId,
              caseKey: result.evalCase.caseKey,
              revision: result.evalCase.revision,
              category: result.evalCase.category,
              sourceType,
              sourceRef,
              sanitizationConfirmed: true,
              replayed: result.replayed,
            },
          },
          tx,
        )

        return {
          id: result.evalCase.id,
          caseKey: result.evalCase.caseKey,
          revision: result.evalCase.revision,
          category: result.evalCase.category,
          sourceInsightId: insight.id,
          replayed: result.replayed,
        }
      }),
    ),
  ),
})
