import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { publishOperationalEvent } from './operational-events'

export type CustomerAccessExecutionActor = {
  type: 'HUMAN'
  id: string
  role: 'PLATFORM_ADMIN'
}

export type CustomerAccessExecutionClient = Pick<typeof db, '$transaction'>

export class CustomerAccessExecutionError extends Error {
  constructor(
    readonly code: 'CONFLICT' | 'NOT_FOUND' | 'INVALID_INPUT' | 'FORBIDDEN',
    message: string,
  ) {
    super(message)
    this.name = 'CustomerAccessExecutionError'
  }
}

type Scope = {
  tenantId: string
  venueId: string
  requestId: string
  expectedUpdatedAt: Date
  actor: CustomerAccessExecutionActor
}

function requireScope(input: Scope): void {
  if (
    !input.tenantId.trim() ||
    !input.venueId.trim() ||
    !input.requestId.trim() ||
    !(input.expectedUpdatedAt instanceof Date) ||
    Number.isNaN(input.expectedUpdatedAt.getTime()) ||
    input.actor.type !== 'HUMAN' ||
    input.actor.role !== 'PLATFORM_ADMIN' ||
    !input.actor.id.trim()
  ) {
    throw new CustomerAccessExecutionError(
      'INVALID_INPUT',
      'Exact customer-access scope, revision, and a platform administrator are required.',
    )
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

async function lockRequest(tx: typeof db, requestId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`torchiko:customer-access-execution:${requestId}`}, 0))`
}

const executionSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  targetEmail: true,
  requestedRole: true,
  status: true,
  providerInvitationId: true,
  approvalRequestId: true,
  updatedAt: true,
  approvalRequest: {
    select: {
      proposedAction: true,
      decision: {
        select: { id: true, decision: true, decidedByType: true, decidedById: true },
      },
    },
  },
} as const

function requireExactRevision(actual: Date, expected: Date): void {
  if (actual.getTime() !== expected.getTime()) {
    throw new CustomerAccessExecutionError(
      'CONFLICT',
      'Customer access request changed; refresh and try again.',
    )
  }
}

function requireHumanApproval(request: {
  approvalRequest: {
    proposedAction: string
    decision: {
      id: string
      decision: string
      decidedByType: string
      decidedById: string
    } | null
  }
}): asserts request is typeof request & {
  approvalRequest: { decision: NonNullable<typeof request.approvalRequest.decision> }
} {
  const decision = request.approvalRequest.decision
  if (
    request.approvalRequest.proposedAction !== 'torchiko.customer_access.invite_member' ||
    decision?.decision !== 'APPROVED' ||
    decision.decidedByType !== 'HUMAN'
  ) {
    throw new CustomerAccessExecutionError(
      'FORBIDDEN',
      'Customer invitation execution requires the exact human-approved request.',
    )
  }
}

/**
 * Fences provider I/O after revalidating the immutable request and exact human
 * approval. PROVIDER_STARTED is committed before the caller may contact Clerk.
 */
export async function startApprovedCustomerInvitationAction(
  input: Scope,
  client: CustomerAccessExecutionClient = db,
) {
  requireScope(input)
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await lockRequest(tx, input.requestId)
    const request = await tx.customerAccessRequest.findFirst({
      where: { id: input.requestId, tenantId: input.tenantId, venueId: input.venueId },
      select: executionSelect,
    })
    if (!request)
      throw new CustomerAccessExecutionError('NOT_FOUND', 'Customer access request not found.')
    requireExactRevision(request.updatedAt, input.expectedUpdatedAt)
    requireHumanApproval(request)

    if (request.status === 'INVITED' && request.providerInvitationId) {
      return { state: 'INVITED' as const, request }
    }
    if (request.status === 'PROVIDER_STARTED') {
      return { state: 'RECONCILIATION_REQUIRED' as const, request }
    }
    if (request.status !== 'APPROVED' && request.status !== 'RECONCILIATION_REQUIRED') {
      throw new CustomerAccessExecutionError(
        'CONFLICT',
        `Customer access request cannot execute from ${request.status}.`,
      )
    }

    const changed = await tx.customerAccessRequest.updateMany({
      where: {
        id: request.id,
        tenantId: request.tenantId,
        venueId: request.venueId,
        status: request.status,
        updatedAt: request.updatedAt,
      },
      data: { status: 'PROVIDER_STARTED' },
    })
    if (changed.count !== 1) {
      throw new CustomerAccessExecutionError('CONFLICT', 'Customer access execution raced.')
    }
    const updated = await tx.customerAccessRequest.findUniqueOrThrow({
      where: { id: request.id },
      select: executionSelect,
    })
    await writeAuditLogStrict(
      {
        tenantId: request.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'customer-access.provider-started',
        targetType: 'CustomerAccessRequest',
        targetId: request.id,
        beforeState: {
          status: request.status,
          approvalDecisionId: request.approvalRequest.decision.id,
        },
        afterState: { status: 'PROVIDER_STARTED', externalEffectConfirmed: false },
      },
      tx,
    )
    return {
      state: 'CALL_PROVIDER' as const,
      request: updated,
      inviterUserId: request.approvalRequest.decision.decidedById,
    }
  })
}

/** Records exact provider evidence. It never creates local membership; Clerk
 * webhooks remain the authority for accepted membership synchronization. */
export async function confirmCustomerInvitationAction(
  input: Scope & { providerInvitationId: string; providerReplayed: boolean },
  client: CustomerAccessExecutionClient = db,
) {
  requireScope(input)
  const providerInvitationId = input.providerInvitationId.trim()
  if (!providerInvitationId || providerInvitationId.length > 191) {
    throw new CustomerAccessExecutionError(
      'INVALID_INPUT',
      'Exact provider invitation evidence is required.',
    )
  }
  try {
    return await client.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof db
      await lockRequest(tx, input.requestId)
      const request = await tx.customerAccessRequest.findFirst({
        where: { id: input.requestId, tenantId: input.tenantId, venueId: input.venueId },
        select: executionSelect,
      })
      if (!request)
        throw new CustomerAccessExecutionError('NOT_FOUND', 'Customer access request not found.')
      requireHumanApproval(request)
      if (request.status === 'INVITED' && request.providerInvitationId === providerInvitationId) {
        return { ...request, replayed: true as const }
      }
      requireExactRevision(request.updatedAt, input.expectedUpdatedAt)
      if (request.status !== 'PROVIDER_STARTED' && request.status !== 'RECONCILIATION_REQUIRED') {
        throw new CustomerAccessExecutionError(
          'CONFLICT',
          'Customer access request is not awaiting provider confirmation.',
        )
      }
      const changed = await tx.customerAccessRequest.updateMany({
        where: {
          id: request.id,
          tenantId: request.tenantId,
          venueId: request.venueId,
          status: request.status,
          updatedAt: request.updatedAt,
          providerInvitationId: null,
        },
        data: { status: 'INVITED', providerInvitationId },
      })
      if (changed.count !== 1)
        throw new CustomerAccessExecutionError('CONFLICT', 'Provider confirmation raced.')
      const updated = await tx.customerAccessRequest.findUniqueOrThrow({
        where: { id: request.id },
        select: executionSelect,
      })
      await tx.operationalEvent.updateMany({
        where: {
          tenantId: request.tenantId,
          deduplicationKey: `customer-access-reconciliation:${request.id}`,
          state: { in: ['OPEN', 'ACKNOWLEDGED'] },
        },
        data: {
          state: 'RESOLVED',
          readAt: new Date(),
          readBy: input.actor.id,
          resolvedAt: new Date(),
          resolvedBy: input.actor.id,
        },
      })
      await writeAuditLogStrict(
        {
          tenantId: request.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'customer-access.invitation-confirmed',
          targetType: 'CustomerAccessRequest',
          targetId: request.id,
          beforeState: { status: request.status },
          afterState: {
            status: 'INVITED',
            providerInvitationId,
            providerReplayed: input.providerReplayed,
            membershipCreatedLocally: false,
          },
        },
        tx,
      )
      return { ...updated, replayed: false as const }
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new CustomerAccessExecutionError(
        'CONFLICT',
        'Provider invitation evidence is already claimed by another request.',
      )
    }
    throw error
  }
}

/** Preserves ambiguity after provider dispatch. A retry must re-enter through
 * startApprovedCustomerInvitationAction, which revalidates approval and scope. */
export async function markCustomerInvitationReconciliationAction(
  input: Scope & { failureClass: 'PROVIDER_UNAVAILABLE' | 'OUTCOME_AMBIGUOUS' },
  client: CustomerAccessExecutionClient = db,
) {
  requireScope(input)
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await lockRequest(tx, input.requestId)
    const request = await tx.customerAccessRequest.findFirst({
      where: { id: input.requestId, tenantId: input.tenantId, venueId: input.venueId },
      select: executionSelect,
    })
    if (!request)
      throw new CustomerAccessExecutionError('NOT_FOUND', 'Customer access request not found.')
    requireHumanApproval(request)
    if (request.status === 'RECONCILIATION_REQUIRED') return { ...request, replayed: true as const }
    requireExactRevision(request.updatedAt, input.expectedUpdatedAt)
    if (request.status !== 'PROVIDER_STARTED') {
      throw new CustomerAccessExecutionError(
        'CONFLICT',
        'Customer access request has no uncertain provider dispatch.',
      )
    }
    const changed = await tx.customerAccessRequest.updateMany({
      where: { id: request.id, status: 'PROVIDER_STARTED', updatedAt: request.updatedAt },
      data: { status: 'RECONCILIATION_REQUIRED' },
    })
    if (changed.count !== 1)
      throw new CustomerAccessExecutionError('CONFLICT', 'Reconciliation fencing raced.')
    const updated = await tx.customerAccessRequest.findUniqueOrThrow({
      where: { id: request.id },
      select: executionSelect,
    })
    await writeAuditLogStrict(
      {
        tenantId: request.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'customer-access.reconciliation-required',
        targetType: 'CustomerAccessRequest',
        targetId: request.id,
        beforeState: { status: 'PROVIDER_STARTED' },
        afterState: { status: 'RECONCILIATION_REQUIRED', failureClass: input.failureClass },
      },
      tx,
    )
    await publishOperationalEvent({
      client: tx,
      event: {
        tenantId: request.tenantId,
        venueId: request.venueId,
        eventType: 'customer-access.reconciliation-required',
        sourceSubsystem: 'customer-access',
        severity: 'WARNING',
        title: 'Customer invitation needs provider reconciliation',
        summary:
          'An approved invitation crossed the provider boundary but its outcome was not confirmed.',
        actionRequired: true,
        linkedObjectType: 'CustomerAccessRequest',
        linkedObjectId: request.id,
        recommendedAction:
          'Open the exact approval context and reconcile the pending provider invitation before retrying.',
        deduplicationKey: `customer-access-reconciliation:${request.id}`,
      },
    })
    return { ...updated, replayed: false as const }
  })
}
