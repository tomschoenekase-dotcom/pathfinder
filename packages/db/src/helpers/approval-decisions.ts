import type { ApprovalDecisionOutcome } from '@prisma/client'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

type ApprovalDecisionClient = Pick<typeof db, '$transaction'>

export type ApprovalDecisionActor = {
  actorType: 'HUMAN'
  actorId: string
  auditRole: 'PLATFORM_ADMIN'
}

export class ApprovalDecisionActionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN',
    message: string,
  ) {
    super(message)
    this.name = 'ApprovalDecisionActionError'
  }
}

function assertHumanPlatformAdmin(actor: ApprovalDecisionActor) {
  if (actor.actorType !== 'HUMAN' || actor.auditRole !== 'PLATFORM_ADMIN') {
    throw new ApprovalDecisionActionError(
      'FORBIDDEN',
      'Approval decisions require a human platform administrator',
    )
  }
}

function isUniqueConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

/**
 * Records one terminal human decision. It deliberately does not create an
 * AgentAction, change an AgentRun, enqueue work, or execute the proposed action.
 */
export async function recordApprovalDecisionAction(
  input: {
    tenantId: string
    venueId: string | null
    approvalRequestId: string
    decision: Extract<ApprovalDecisionOutcome, 'APPROVED' | 'REJECTED' | 'CANCELLED'>
    reason?: string | undefined
    decidedAt?: Date | undefined
    actor: ApprovalDecisionActor
  },
  client: ApprovalDecisionClient = db,
) {
  assertHumanPlatformAdmin(input.actor)
  try {
    return await client.$transaction(async (tx) => {
      const request = await tx.approvalRequest.findFirst({
        where: {
          id: input.approvalRequestId,
          tenantId: input.tenantId,
          venueId: input.venueId,
        },
        select: {
          id: true,
          venueId: true,
          proposedAction: true,
          riskCategory: true,
          expiresAt: true,
          decision: { select: { id: true } },
        },
      })
      if (!request) {
        throw new ApprovalDecisionActionError('NOT_FOUND', 'Approval request not found')
      }
      if (request.decision) {
        throw new ApprovalDecisionActionError('CONFLICT', 'Approval request already has a decision')
      }
      const decidedAt = input.decidedAt ?? new Date()
      if (request.expiresAt && request.expiresAt <= decidedAt) {
        throw new ApprovalDecisionActionError('CONFLICT', 'Approval request has expired')
      }

      const decision = await tx.approvalDecision.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          approvalRequestId: request.id,
          decision: input.decision,
          decidedByType: 'HUMAN',
          decidedById: input.actor.actorId,
          reason: input.reason ?? null,
        },
        select: {
          id: true,
          tenantId: true,
          venueId: true,
          approvalRequestId: true,
          decision: true,
          decidedByType: true,
          decidedById: true,
          reason: true,
          createdAt: true,
        },
      })

      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: input.actor.actorId,
          actorRole: input.actor.auditRole,
          action: 'approval-request.decision-recorded',
          targetType: 'ApprovalRequest',
          targetId: request.id,
          beforeState: { state: 'PENDING' },
          afterState: {
            state: input.decision,
            decisionId: decision.id,
            proposedAction: request.proposedAction,
            riskCategory: request.riskCategory,
            executionTriggered: false,
          },
        },
        tx,
      )
      return decision
    })
  } catch (error) {
    if (isUniqueConflict(error)) {
      throw new ApprovalDecisionActionError('CONFLICT', 'Approval request already has a decision')
    }
    throw error
  }
}
