import { z } from 'zod'

import { HumanActorContext, MachineActorContext } from '@pathfinder/contracts/actor'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { lockSupportRequest } from './support-actions'

const correctionKinds = [
  'CREATE_KNOWLEDGE',
  'UPDATE_KNOWLEDGE',
  'RETIRE_KNOWLEDGE',
  'RETRIEVAL_CORRECTION',
  'NO_CONTENT_CHANGE',
] as const

const eligibleStatuses = [
  'IN_REVIEW',
  'PATCH_DRAFTED',
  'VALIDATING',
  'AWAITING_APPROVAL',
  'APPLYING',
] as const

const proposalActor = z.union([
  HumanActorContext.superRefine((actor, context) => {
    if (actor.role !== 'PLATFORM_ADMIN') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['role'],
        message: 'A platform administrator must review the support request before handoff.',
      })
    }
  }),
  MachineActorContext.superRefine((actor, context) => {
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
        message: 'Machine proposals require an idempotency key.',
      })
    }
    if ((actor.modelProvider === undefined) !== (actor.modelName === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modelProvider'],
        message: 'Model provider and model name must be supplied together.',
      })
    }
  }),
])

const inputSchema = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    supportRequestId: z.string().trim().min(1).max(191),
    expectedVersion: z.number().int().positive(),
    evidenceMessageIds: z.array(z.string().trim().min(1).max(191)).min(1).max(20),
    targetKnowledgeEntryId: z.string().trim().min(1).max(191).optional(),
    correctionKind: z.enum(correctionKinds),
    aiInference: z.string().trim().min(1).max(2000).optional(),
    proposedChange: z.string().trim().min(1).max(10000),
    reason: z.string().trim().min(1).max(2000),
    confidence: z.number().min(0).max(1),
    actor: proposalActor,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.evidenceMessageIds).size !== value.evidenceMessageIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidenceMessageIds'],
        message: 'Support evidence message IDs must be unique.',
      })
    }
    if (value.actor.type === 'AGENT' && value.actor.idempotencyKey !== value.operationId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actor', 'idempotencyKey'],
        message: 'Machine idempotency evidence must match the operation ID.',
      })
    }
  })

export type SupportKnowledgeProposalInput = z.input<typeof inputSchema>
export type SupportKnowledgeProposalActionErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT'

export class SupportKnowledgeProposalActionError extends Error {
  constructor(
    readonly code: SupportKnowledgeProposalActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SupportKnowledgeProposalActionError'
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}

function sameOptional(left: string | null, right: string | undefined): boolean {
  return left === (right ?? null)
}

export async function prepareSupportKnowledgeProposalAction(
  input: SupportKnowledgeProposalInput,
  client: typeof db = db,
) {
  const parsedResult = inputSchema.safeParse(input)
  if (!parsedResult.success) {
    throw new SupportKnowledgeProposalActionError(
      'INVALID_INPUT',
      parsedResult.error.issues[0]?.message ?? 'Support knowledge proposal input is invalid.',
    )
  }
  const parsed = parsedResult.data
  const storedChange = `[${parsed.correctionKind}]\n${parsed.proposedChange}`
  const createdByType = parsed.actor.type === 'AGENT' ? 'AGENT' : 'HUMAN'

  try {
    return await client.$transaction(async (tx) => {
      await lockSupportRequest(tx, parsed.tenantId, parsed.supportRequestId)

      const existing = await tx.knowledgeChangeProposal.findUnique({
        where: { id: parsed.operationId },
        select: {
          id: true,
          tenantId: true,
          venueId: true,
          supportRequestId: true,
          supportRequestVersion: true,
          targetKnowledgeEntryId: true,
          aiInference: true,
          proposedChange: true,
          reason: true,
          confidence: true,
          evidenceMessageIds: true,
          createdByType: true,
          createdById: true,
          status: true,
        },
      })
      if (existing) {
        const exactReplay =
          existing.tenantId === parsed.tenantId &&
          existing.venueId === parsed.venueId &&
          existing.supportRequestId === parsed.supportRequestId &&
          existing.supportRequestVersion === parsed.expectedVersion &&
          sameOptional(existing.targetKnowledgeEntryId, parsed.targetKnowledgeEntryId) &&
          existing.aiInference === (parsed.aiInference ?? null) &&
          existing.proposedChange === storedChange &&
          existing.reason === parsed.reason &&
          Number(existing.confidence) === parsed.confidence &&
          JSON.stringify(existing.evidenceMessageIds) ===
            JSON.stringify(parsed.evidenceMessageIds) &&
          existing.createdByType === createdByType &&
          existing.createdById === parsed.actor.actorId
        if (!exactReplay) {
          throw new SupportKnowledgeProposalActionError(
            'CONFLICT',
            'Operation ID is already bound to different support evidence or proposal content.',
          )
        }
        return { proposal: existing, replayed: true as const }
      }

      const request = await tx.supportRequest.findFirst({
        where: {
          id: parsed.supportRequestId,
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          version: parsed.expectedVersion,
          category: 'CONTENT_CORRECTION',
          status: { in: [...eligibleStatuses] },
        },
        select: { id: true, subject: true, version: true, status: true },
      })
      if (!request) {
        throw new SupportKnowledgeProposalActionError(
          'CONFLICT',
          'The exact in-review content-correction request version is no longer eligible.',
        )
      }

      const requestEvent = await tx.supportRequestAuditEvent.findUnique({
        where: {
          supportRequestId_tenantId_venueId_requestVersion: {
            supportRequestId: request.id,
            tenantId: parsed.tenantId,
            venueId: parsed.venueId,
            requestVersion: request.version,
          },
        },
        select: { id: true },
      })
      if (!requestEvent) {
        throw new SupportKnowledgeProposalActionError(
          'CONFLICT',
          'Exact support request version evidence is unavailable.',
        )
      }

      const evidence = await tx.supportMessage.findMany({
        where: {
          id: { in: parsed.evidenceMessageIds },
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          supportRequestId: request.id,
          requestVersion: { not: null, lte: request.version },
        },
        select: { id: true },
      })
      if (
        evidence.length !== parsed.evidenceMessageIds.length ||
        new Set(evidence.map((message) => message.id)).size !== parsed.evidenceMessageIds.length
      ) {
        throw new SupportKnowledgeProposalActionError(
          'NOT_FOUND',
          'Every evidence message must belong to this request at or before the frozen version.',
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
          throw new SupportKnowledgeProposalActionError(
            'NOT_FOUND',
            'Target knowledge entry was not found.',
          )
        }
      }

      const proposal = await tx.knowledgeChangeProposal.create({
        data: {
          id: parsed.operationId,
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          supportRequestId: request.id,
          supportRequestVersion: request.version,
          ...(parsed.targetKnowledgeEntryId
            ? { targetKnowledgeEntryId: parsed.targetKnowledgeEntryId }
            : {}),
          observedVisitorClaim: `Client requested correction: ${request.subject}`,
          ...(parsed.aiInference ? { aiInference: parsed.aiInference } : {}),
          proposedChange: storedChange,
          reason: parsed.reason,
          confidence: parsed.confidence,
          evidenceMessageIds: parsed.evidenceMessageIds,
          status: 'PENDING_REVIEW',
          createdByType,
          createdById: parsed.actor.actorId,
        },
        select: {
          id: true,
          status: true,
          supportRequestId: true,
          supportRequestVersion: true,
          createdAt: true,
          updatedAt: true,
        },
      })

      await writeAuditLogStrict(
        {
          tenantId: parsed.tenantId,
          actor: parsed.actor,
          action: 'knowledge-proposal.created-from-support',
          targetType: 'KnowledgeChangeProposal',
          targetId: proposal.id,
          sourceReferences: parsed.evidenceMessageIds.map((id) => ({
            type: 'SupportMessage',
            id,
          })),
          structuredReason: {
            correctionKind: parsed.correctionKind,
            supportRequestId: request.id,
            supportRequestVersion: request.version,
          },
          afterState: {
            venueId: parsed.venueId,
            supportRequestId: request.id,
            supportRequestVersion: request.version,
            evidenceMessageCount: parsed.evidenceMessageIds.length,
            status: proposal.status,
            canonicalKnowledgeChanged: false,
          },
        },
        tx,
      )

      return { proposal, replayed: false as const }
    })
  } catch (error) {
    if (error instanceof SupportKnowledgeProposalActionError) throw error
    if (isUniqueConstraintError(error)) {
      throw new SupportKnowledgeProposalActionError(
        'CONFLICT',
        'This exact support request version already has a knowledge proposal.',
      )
    }
    throw error
  }
}
