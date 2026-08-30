import { z } from 'zod'

import { MachineActorContext } from '@pathfinder/contracts/actor'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

const customerAccessActor = MachineActorContext.superRefine((actor, context) => {
  if (actor.capability !== 'customer-access:prepare') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capability'],
      message: 'The exact customer-access:prepare capability is required.',
    })
  }
  if (!actor.idempotencyKey) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['idempotencyKey'],
      message: 'Customer access preparation requires an idempotency key.',
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

const inputSchema = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    supportRequestId: z.string().trim().min(1).max(191),
    sourceSupportMessageId: z.string().trim().min(1).max(191),
    emailAddress: z.string().trim().email().max(320),
    requestedRole: z.literal('MEMBER'),
    reason: z.string().trim().min(3).max(2000),
    actor: customerAccessActor,
  })
  .strict()

export type PrepareCustomerAccessRequestInput = z.input<typeof inputSchema>
export type CustomerAccessRequestActionErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'

export class CustomerAccessRequestActionError extends Error {
  constructor(
    readonly code: CustomerAccessRequestActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CustomerAccessRequestActionError'
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

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

const requestSelect = {
  id: true,
  operationId: true,
  tenantId: true,
  venueId: true,
  agentIdentityId: true,
  agentRunId: true,
  supportRequestId: true,
  sourceSupportMessageId: true,
  approvalRequestId: true,
  targetEmail: true,
  requestedRole: true,
  reason: true,
  status: true,
  providerInvitationId: true,
  createdAt: true,
  updatedAt: true,
} as const

function matchesReplay(
  existing: {
    venueId: string
    agentIdentityId: string
    agentRunId: string
    supportRequestId: string
    sourceSupportMessageId: string
    targetEmail: string
    requestedRole: string
    reason: string
  },
  parsed: z.infer<typeof inputSchema>,
  targetEmail: string,
): boolean {
  return (
    existing.venueId === parsed.venueId &&
    existing.agentIdentityId === parsed.actor.agentIdentityId &&
    existing.agentRunId === parsed.actor.agentRunId &&
    existing.supportRequestId === parsed.supportRequestId &&
    existing.sourceSupportMessageId === parsed.sourceSupportMessageId &&
    existing.targetEmail === targetEmail &&
    existing.requestedRole === parsed.requestedRole &&
    existing.reason === parsed.reason
  )
}

/**
 * Creates a provider-dark customer invitation request from one exact, active
 * owner-authored support message. It creates review and agent evidence only:
 * no Clerk API, email, membership, or customer-facing state is changed.
 */
export async function prepareCustomerAccessRequestAction(
  input: PrepareCustomerAccessRequestInput,
  client: Pick<typeof db, '$transaction'> = db,
) {
  const parsedResult = inputSchema.safeParse(input)
  if (!parsedResult.success) {
    throw new CustomerAccessRequestActionError(
      'INVALID_INPUT',
      parsedResult.error.issues[0]?.message ?? 'Customer access request input is invalid.',
    )
  }
  const parsed = parsedResult.data
  const targetEmail = normalizeEmail(parsed.emailAddress)

  try {
    return await client.$transaction(async (tx) => {
      const existing = await tx.customerAccessRequest.findUnique({
        where: {
          tenantId_operationId: { tenantId: parsed.tenantId, operationId: parsed.operationId },
        },
        select: requestSelect,
      })
      if (existing) {
        if (!matchesReplay(existing, parsed, targetEmail)) {
          throw new CustomerAccessRequestActionError(
            'CONFLICT',
            'Customer access operation ID was already used for a different request.',
          )
        }
        return { request: existing, replayed: true as const }
      }

      const identity = await tx.agentIdentity.findFirst({
        where: {
          id: parsed.actor.agentIdentityId,
          tenantId: parsed.tenantId,
          enabled: true,
          accessCapabilities: { has: 'customer-access:prepare' },
          OR: [
            { accessScope: { in: ['CLIENT', 'PLATFORM'] } },
            { accessScope: 'VENUE', venueId: parsed.venueId },
          ],
        },
        select: { id: true },
      })
      if (!identity) {
        throw new CustomerAccessRequestActionError(
          'FORBIDDEN',
          'Enabled customer-access agent identity is not in scope.',
        )
      }

      const run = await tx.agentRun.findFirst({
        where: {
          id: parsed.actor.agentRunId,
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          agentIdentityId: identity.id,
          status: 'RUNNING',
        },
        select: { id: true, requestedOperation: true },
      })
      if (!run) {
        throw new CustomerAccessRequestActionError(
          'FORBIDDEN',
          'Running customer-access agent run is not in scope.',
        )
      }

      const sourceMessage = await tx.supportMessage.findFirst({
        where: {
          id: parsed.sourceSupportMessageId,
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          supportRequestId: parsed.supportRequestId,
          authorKind: 'CLIENT',
          visibility: 'CLIENT_VISIBLE',
          supportRequest: { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
        },
        select: {
          id: true,
          authorId: true,
          body: true,
          supportRequest: { select: { id: true, version: true, subject: true } },
        },
      })
      if (!sourceMessage) {
        throw new CustomerAccessRequestActionError(
          'NOT_FOUND',
          'Active client-authored support evidence was not found in scope.',
        )
      }

      const authorizedRequester = await tx.tenantMembership.findFirst({
        where: {
          tenantId: parsed.tenantId,
          userId: sourceMessage.authorId,
          role: 'OWNER',
          status: 'ACTIVE',
        },
        select: { id: true, userId: true },
      })
      if (!authorizedRequester) {
        throw new CustomerAccessRequestActionError(
          'FORBIDDEN',
          'The source request was not authored by an active organization owner.',
        )
      }
      if (!sourceMessage.body.toLowerCase().includes(targetEmail)) {
        throw new CustomerAccessRequestActionError(
          'FORBIDDEN',
          'The requested email is not present in the exact owner-authored support message.',
        )
      }

      const [existingMember, activeRequest] = await Promise.all([
        tx.tenantMembership.findFirst({
          where: {
            tenantId: parsed.tenantId,
            status: { not: 'REMOVED' },
            user: { email: { equals: targetEmail, mode: 'insensitive' } },
          },
          select: { id: true },
        }),
        tx.customerAccessRequest.findFirst({
          where: {
            tenantId: parsed.tenantId,
            targetEmail,
            status: {
              in: ['AWAITING_APPROVAL', 'APPROVED', 'PROVIDER_STARTED', 'RECONCILIATION_REQUIRED'],
            },
          },
          select: { id: true },
        }),
      ])
      if (existingMember) {
        throw new CustomerAccessRequestActionError(
          'CONFLICT',
          'This email already belongs to a current organization member.',
        )
      }
      if (activeRequest) {
        throw new CustomerAccessRequestActionError(
          'CONFLICT',
          'An active customer access request already exists for this email.',
        )
      }

      const approvalRequest = await tx.approvalRequest.create({
        data: {
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          agentIdentityId: identity.id,
          agentRunId: run.id,
          requestedByType: 'AGENT',
          requestedById: identity.id,
          proposedAction: 'torchiko.customer_access.invite_member',
          scopeSnapshot: {
            tenantId: parsed.tenantId,
            venueId: parsed.venueId,
            targetEmail,
            requestedRole: parsed.requestedRole,
            supportRequestId: parsed.supportRequestId,
            sourceSupportMessageId: sourceMessage.id,
            authorizedRequesterUserId: authorizedRequester.userId,
            externalEffectsExecuted: false,
          },
          reason: parsed.reason,
          riskCategory: 'HIGH',
          artifacts: [
            { type: 'SupportRequest', id: sourceMessage.supportRequest.id },
            { type: 'SupportMessage', id: sourceMessage.id },
          ],
        },
        select: { id: true },
      })

      const request = await tx.customerAccessRequest.create({
        data: {
          operationId: parsed.operationId,
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          agentIdentityId: identity.id,
          agentRunId: run.id,
          supportRequestId: sourceMessage.supportRequest.id,
          sourceSupportMessageId: sourceMessage.id,
          approvalRequestId: approvalRequest.id,
          targetEmail,
          requestedRole: parsed.requestedRole,
          reason: parsed.reason,
        },
        select: requestSelect,
      })

      const action = await tx.agentAction.create({
        data: {
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          agentRunId: run.id,
          agentIdentityId: identity.id,
          actorType: 'AGENT',
          actorId: identity.id,
          requestedOperation: run.requestedOperation,
          actionName: 'torchiko.customer_access.prepare_invitation',
          inputSummary: `Prepare one member invitation for human review from owner-authored support evidence.`,
          inputReference: `SupportMessage:${sourceMessage.id}`,
          output: {
            customerAccessRequestId: request.id,
            approvalRequestId: approvalRequest.id,
            status: request.status,
            externalEffectsExecuted: false,
          },
          modelProvider: parsed.actor.modelProvider ?? null,
          modelName: parsed.actor.modelName ?? null,
          status: 'SUCCEEDED',
          beforeVersionRef: `SupportRequest:${sourceMessage.supportRequest.id}:v${sourceMessage.supportRequest.version}`,
          afterVersionRef: `CustomerAccessRequest:${request.id}:${request.status}`,
        },
        select: { id: true },
      })

      const transitioned = await tx.agentRun.updateMany({
        where: {
          id: run.id,
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          status: 'RUNNING',
        },
        data: { status: 'AWAITING_APPROVAL' },
      })
      if (transitioned.count !== 1) {
        throw new CustomerAccessRequestActionError(
          'CONFLICT',
          'Agent run changed before the approval request was recorded.',
        )
      }

      await tx.agentTimelineEvent.create({
        data: {
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          agentRunId: run.id,
          agentActionId: action.id,
          actorType: 'AGENT',
          actorId: identity.id,
          eventType: 'customer-access.awaiting-approval',
          message: 'Customer invitation prepared from verified owner-authored support evidence.',
          data: {
            customerAccessRequestId: request.id,
            approvalRequestId: approvalRequest.id,
            externalEffectsExecuted: false,
          },
        },
      })

      await writeAuditLogStrict(
        {
          tenantId: parsed.tenantId,
          actor: parsed.actor,
          action: 'customer-access.invitation-prepared',
          targetType: 'CustomerAccessRequest',
          targetId: request.id,
          sourceReferences: [
            { type: 'SupportRequest', id: sourceMessage.supportRequest.id },
            { type: 'SupportMessage', id: sourceMessage.id },
          ],
          structuredReason: {
            approvalRequestId: approvalRequest.id,
            requestedRole: parsed.requestedRole,
          },
          afterState: {
            status: request.status,
            externalEffectsExecuted: false,
            membershipChanged: false,
            invitationSent: false,
          },
        },
        tx,
      )

      return { request, replayed: false as const }
    })
  } catch (error) {
    if (error instanceof CustomerAccessRequestActionError) throw error
    if (isUniqueConstraintError(error)) {
      throw new CustomerAccessRequestActionError(
        'CONFLICT',
        'A customer access request already exists for this operation or email.',
      )
    }
    throw error
  }
}
