import { z } from 'zod'

import { MachineActorContext } from '@pathfinder/contracts/actor'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

const reviewableCategories = [
  'LOW_CONFIDENCE_ANSWER',
  'KNOWLEDGE_GAP',
  'CONTENT_UPDATE_CANDIDATE',
  'VISITOR_NEGATIVE_FEEDBACK',
] as const

const correctionKinds = [
  'CREATE_KNOWLEDGE',
  'UPDATE_KNOWLEDGE',
  'RETIRE_KNOWLEDGE',
  'RETRIEVAL_CORRECTION',
  'NO_CONTENT_CHANGE',
] as const

const knowledgeDraftActor = MachineActorContext.superRefine((actor, context) => {
  if (actor.capability !== 'knowledge:draft') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capability'],
      message: 'The exact knowledge:draft capability is required.',
    })
  }
  if (!actor.idempotencyKey) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['idempotencyKey'],
      message: 'Machine correction proposals require an idempotency key.',
    })
  }
  if ((actor.modelProvider === undefined) !== (actor.modelName === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['modelProvider'],
      message: 'Model provider and model name must be supplied together.',
    })
  }
})

const proposalInput = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    conversationInsightId: z.string().uuid(),
    targetKnowledgeEntryId: z.string().trim().min(1).max(191).optional(),
    correctionKind: z.enum(correctionKinds),
    aiInference: z.string().trim().min(1).max(2000),
    proposedChange: z.string().trim().min(1).max(10000),
    reason: z.string().trim().min(1).max(2000),
    confidence: z.number().min(0).max(1),
    actor: knowledgeDraftActor,
  })
  .strict()

export type KnowledgeCorrectionKind = (typeof correctionKinds)[number]
export type ProposeKnowledgeCorrectionInput = z.input<typeof proposalInput>

export type KnowledgeCorrectionActionErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT'

export class KnowledgeCorrectionActionError extends Error {
  constructor(
    readonly code: KnowledgeCorrectionActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'KnowledgeCorrectionActionError'
  }
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`
}

function sameOptional(left: string | null, right: string | undefined): boolean {
  return left === (right ?? null)
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}

function evidenceIds(turn: {
  userMessage: { id: string } | null
  assistantMessage: { id: string } | null
}): string[] {
  return [turn.userMessage?.id, turn.assistantMessage?.id].filter(
    (value): value is string => typeof value === 'string',
  )
}

export async function listConversationKnowledgeGaps(
  input: {
    tenantId: string
    venueId: string
    limit?: number
  },
  client: typeof db = db,
) {
  const parsed = z
    .object({
      tenantId: z.string().trim().min(1).max(191),
      venueId: z.string().trim().min(1).max(191),
      limit: z.number().int().min(1).max(25).default(10),
    })
    .strict()
    .parse(input)

  const rows = await client.conversationInsight.findMany({
    where: {
      tenantId: parsed.tenantId,
      venueId: parsed.venueId,
      OR: [
        {
          category: {
            in: reviewableCategories.filter((category) => category !== 'VISITOR_NEGATIVE_FEEDBACK'),
          },
        },
        {
          category: 'VISITOR_NEGATIVE_FEEDBACK',
          guestChatTurn: {
            assistantMessage: {
              feedback: { some: { rating: 'NOT_HELPFUL' } },
            },
          },
        },
      ],
      reviewStatus: { in: ['UNREVIEWED', 'ACKNOWLEDGED'] },
      guestChatTurnId: { not: null },
      session: { experienceScope: 'PUBLIC' },
    },
    orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    take: parsed.limit,
    select: {
      id: true,
      category: true,
      confidence: true,
      severity: true,
      summary: true,
      suggestedAction: true,
      createdAt: true,
      guestChatTurn: {
        select: {
          id: true,
          userMessage: { select: { id: true, content: true } },
          assistantMessage: { select: { id: true, content: true } },
        },
      },
    },
  })

  return rows.flatMap((row) => {
    if (!row.guestChatTurn?.userMessage || !row.guestChatTurn.assistantMessage) return []
    return [
      {
        id: row.id,
        category: row.category,
        confidence: Number(row.confidence),
        severity: row.severity,
        summary: row.summary,
        suggestedAction: row.suggestedAction,
        guestChatTurnId: row.guestChatTurn.id,
        visitorQuestion: clip(row.guestChatTurn.userMessage.content, 2000),
        assistantAnswer: clip(row.guestChatTurn.assistantMessage.content, 4000),
        evidenceMessageIds: evidenceIds(row.guestChatTurn),
        createdAt: row.createdAt,
      },
    ]
  })
}

export async function proposeKnowledgeCorrectionAction(
  input: ProposeKnowledgeCorrectionInput,
  client: typeof db = db,
) {
  const parsedResult = proposalInput.safeParse(input)
  if (!parsedResult.success) {
    throw new KnowledgeCorrectionActionError(
      'INVALID_INPUT',
      parsedResult.error.issues[0]?.message ?? 'Knowledge correction input is invalid.',
    )
  }
  const parsed = parsedResult.data
  const agentIdentityId = parsed.actor.agentIdentityId
  const storedProposedChange = `[${parsed.correctionKind}]\n${parsed.proposedChange}`

  try {
    return await client.$transaction(async (tx) => {
      const existing = await tx.knowledgeChangeProposal.findUnique({
        where: { id: parsed.operationId },
        select: {
          id: true,
          tenantId: true,
          venueId: true,
          conversationInsightId: true,
          targetKnowledgeEntryId: true,
          aiInference: true,
          proposedChange: true,
          reason: true,
          confidence: true,
          createdByType: true,
          createdById: true,
          status: true,
        },
      })
      if (existing) {
        if (
          existing.tenantId !== parsed.tenantId ||
          existing.venueId !== parsed.venueId ||
          existing.conversationInsightId !== parsed.conversationInsightId ||
          !sameOptional(existing.targetKnowledgeEntryId, parsed.targetKnowledgeEntryId) ||
          existing.aiInference !== parsed.aiInference ||
          existing.proposedChange !== storedProposedChange ||
          existing.reason !== parsed.reason ||
          Number(existing.confidence) !== parsed.confidence ||
          existing.createdByType !== 'AGENT' ||
          existing.createdById !== agentIdentityId
        ) {
          throw new KnowledgeCorrectionActionError(
            'CONFLICT',
            'Knowledge correction operation ID was already used for different evidence or content.',
          )
        }
        return { proposal: existing, replayed: true as const }
      }

      const active = await tx.knowledgeChangeProposal.findFirst({
        where: {
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          conversationInsightId: parsed.conversationInsightId,
          status: { in: ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'PUBLISHED'] },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, status: true },
      })
      if (active) {
        throw new KnowledgeCorrectionActionError(
          'CONFLICT',
          'This conversation insight already has an active knowledge correction proposal.',
        )
      }

      const insight = await tx.conversationInsight.findFirst({
        where: {
          id: parsed.conversationInsightId,
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          category: { in: [...reviewableCategories] },
          reviewStatus: { in: ['UNREVIEWED', 'ACKNOWLEDGED'] },
          session: { experienceScope: 'PUBLIC' },
        },
        select: {
          id: true,
          sessionId: true,
          category: true,
          guestChatTurn: {
            select: {
              userMessage: { select: { id: true, content: true } },
              assistantMessage: { select: { id: true, content: true } },
            },
          },
        },
      })
      if (!insight?.guestChatTurn?.userMessage || !insight.guestChatTurn.assistantMessage) {
        throw new KnowledgeCorrectionActionError(
          'NOT_FOUND',
          'Reviewable public conversation evidence was not found.',
        )
      }

      if (parsed.targetKnowledgeEntryId) {
        const target = await tx.venueKnowledgeEntry.findFirst({
          where: {
            id: parsed.targetKnowledgeEntryId,
            tenantId: parsed.tenantId,
            venueId: parsed.venueId,
          },
          select: { id: true },
        })
        if (!target) {
          throw new KnowledgeCorrectionActionError(
            'NOT_FOUND',
            'Target knowledge entry was not found.',
          )
        }
      }

      const messageIds = evidenceIds(insight.guestChatTurn)
      const proposal = await tx.knowledgeChangeProposal.create({
        data: {
          id: parsed.operationId,
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          sessionId: insight.sessionId,
          conversationInsightId: insight.id,
          ...(parsed.targetKnowledgeEntryId
            ? { targetKnowledgeEntryId: parsed.targetKnowledgeEntryId }
            : {}),
          observedVisitorClaim: clip(
            `Visitor asked: ${insight.guestChatTurn.userMessage.content}`,
            2000,
          ),
          aiInference: parsed.aiInference,
          proposedChange: storedProposedChange,
          reason: parsed.reason,
          confidence: parsed.confidence,
          evidenceMessageIds: messageIds,
          status: 'PENDING_REVIEW',
          createdByType: 'AGENT',
          createdById: agentIdentityId,
        },
        select: { id: true, status: true, createdAt: true, updatedAt: true },
      })

      const insightChanged = await tx.conversationInsight.updateMany({
        where: {
          id: insight.id,
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          reviewStatus: { in: ['UNREVIEWED', 'ACKNOWLEDGED'] },
        },
        data: {
          reviewStatus: 'ACTIONED',
          reviewedBy: agentIdentityId,
          reviewedAt: new Date(),
        },
      })
      if (insightChanged.count !== 1) {
        throw new KnowledgeCorrectionActionError(
          'CONFLICT',
          'Conversation insight review state changed; refresh before proposing a correction.',
        )
      }

      await writeAuditLogStrict(
        {
          tenantId: parsed.tenantId,
          actor: parsed.actor,
          action: 'knowledge-proposal.agent-prepared',
          targetType: 'KnowledgeChangeProposal',
          targetId: proposal.id,
          sourceReferences: messageIds.map((id) => ({ type: 'Message', id })),
          structuredReason: {
            correctionKind: parsed.correctionKind,
            conversationInsightId: insight.id,
            insightCategory: insight.category,
          },
          afterState: {
            status: proposal.status,
            canonicalKnowledgeChanged: false,
            targetKnowledgeEntryId: parsed.targetKnowledgeEntryId ?? null,
          },
        },
        tx,
      )

      return { proposal, replayed: false as const }
    })
  } catch (error) {
    if (error instanceof KnowledgeCorrectionActionError) throw error
    if (isUniqueConstraintError(error)) {
      throw new KnowledgeCorrectionActionError(
        'CONFLICT',
        'A knowledge correction already exists for this operation or conversation insight.',
      )
    }
    throw error
  }
}
