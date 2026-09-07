import { z } from 'zod'

import { db, publishOperationalEvent, writeAuditLogStrict } from '@pathfinder/db'

import type { BillingEnvironment } from './config'
import type { BillingProvider } from './provider'
import { requestTenantCancellation } from './customer-requests'
import { BillingServiceError, createBillingAccessOverride, createTenantCheckout } from './service'

type DbClient = typeof db

export const BILLING_COMMAND_LEASE_MS = 5 * 60_000

export const BillingAgentCommandPayload = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('CREATE_NEGOTIATED_CHECKOUT'),
      planKey: z.string().trim().min(1).max(100),
      planVersion: z.number().int().positive().optional(),
      venueIds: z.array(z.string().trim().min(1).max(191)).min(1).max(100),
      amountMinor: z.string().regex(/^[1-9]\d{0,11}$/u),
      currency: z.literal('usd'),
      interval: z.enum(['month', 'year']),
      reference: z.string().trim().min(1).max(191),
      reason: z.string().trim().min(3).max(500),
    })
    .strict(),
  z
    .object({
      action: z.literal('SET_GRACE_PERIOD'),
      agreementId: z.string().trim().min(1).max(191),
      expiresAt: z.string().datetime({ offset: true }),
      reference: z.string().trim().min(1).max(191),
      reason: z.string().trim().min(3).max(500),
    })
    .strict(),
  z
    .object({
      action: z.literal('CANCEL_AT_PERIOD_END'),
      reason: z.string().trim().min(3).max(2000),
    })
    .strict(),
])
export type BillingAgentCommandPayload = z.infer<typeof BillingAgentCommandPayload>

export async function proposeBillingAgentCommand(params: {
  operationId: string
  tenantId: string
  venueId: string
  agentIdentityId: string
  agentRunId?: string
  payload: BillingAgentCommandPayload
  approvalTtlHours?: number
  client?: DbClient
}) {
  const client = params.client ?? db
  const payload = BillingAgentCommandPayload.parse(params.payload)
  const approvalTtlHours = params.approvalTtlHours ?? 24
  if (!Number.isInteger(approvalTtlHours) || approvalTtlHours < 1 || approvalTtlHours > 168) {
    throw new BillingServiceError('DISABLED', 'Billing approval TTL is invalid.')
  }
  const result = await client.$transaction(async (tx) => {
    const replay = await tx.billingAgentCommand.findFirst({
      where: { tenantId: params.tenantId, operationId: params.operationId },
      include: { approvalRequest: true },
    })
    if (replay) return { command: replay, replayed: true }
    const [venue, agentIdentity, account] = await Promise.all([
      tx.venue.findFirst({
        where: { id: params.venueId, tenantId: params.tenantId },
        select: { id: true },
      }),
      tx.agentIdentity.findFirst({
        where: { id: params.agentIdentityId, tenantId: params.tenantId, enabled: true },
        select: { id: true },
      }),
      tx.billingAccount.findUnique({ where: { tenantId: params.tenantId }, select: { id: true } }),
    ])
    if (!venue) throw new BillingServiceError('FORBIDDEN', 'Venue scope is unavailable.')
    if (!agentIdentity) throw new BillingServiceError('FORBIDDEN', 'Agent identity is unavailable.')
    if (params.agentRunId) {
      const run = await tx.agentRun.findFirst({
        where: {
          id: params.agentRunId,
          tenantId: params.tenantId,
          venueId: params.venueId,
          agentIdentityId: params.agentIdentityId,
        },
        select: { id: true },
      })
      if (!run) throw new BillingServiceError('FORBIDDEN', 'Agent run scope is unavailable.')
    }
    if (payload.action !== 'CREATE_NEGOTIATED_CHECKOUT' && !account) {
      throw new BillingServiceError('NOT_FOUND', 'No billing account is linked.')
    }
    if (payload.action === 'CREATE_NEGOTIATED_CHECKOUT') {
      const invalidVenue = payload.venueIds.find((id) => id !== params.venueId)
      if (invalidVenue)
        throw new BillingServiceError('FORBIDDEN', 'Proposal exceeds verified venue scope.')
    }
    const approval = await tx.approvalRequest.create({
      data: {
        tenantId: params.tenantId,
        venueId: params.venueId,
        agentIdentityId: params.agentIdentityId,
        agentRunId: params.agentRunId ?? null,
        requestedByType: 'AGENT',
        requestedById: params.agentIdentityId,
        proposedAction: `billing.${payload.action.toLowerCase()}`,
        scopeSnapshot: { tenantId: params.tenantId, venueId: params.venueId, payload },
        reason: payload.reason,
        riskCategory: payload.action === 'SET_GRACE_PERIOD' ? 'HIGH' : 'CRITICAL',
        artifacts: [],
        expiresAt: new Date(Date.now() + approvalTtlHours * 60 * 60 * 1000),
      },
    })
    const command = await tx.billingAgentCommand.create({
      data: {
        operationId: params.operationId,
        tenantId: params.tenantId,
        venueId: params.venueId,
        billingAccountId: account?.id ?? null,
        approvalRequestId: approval.id,
        action: payload.action,
        payload,
        requestedByAgentId: params.agentIdentityId,
      },
      include: { approvalRequest: true },
    })
    await writeAuditLogStrict(
      {
        tenantId: params.tenantId,
        actorId: params.agentIdentityId,
        actorRole: 'AGENT',
        action: 'billing.agent-command.proposed',
        targetType: 'BillingAgentCommand',
        targetId: command.id,
        afterState: {
          action: command.action,
          approvalRequestId: approval.id,
          providerActionExecuted: false,
        },
      },
      tx,
    )
    return { command, replayed: false }
  })
  await publishOperationalEvent({
    event: {
      tenantId: params.tenantId,
      venueId: params.venueId,
      eventType: 'billing.agent-command-awaiting-approval',
      sourceSubsystem: 'billing',
      severity: 'WARNING',
      title: 'Agent billing action needs approval',
      summary: `Review the exact ${payload.action.toLowerCase().replaceAll('_', ' ')} proposal before execution.`,
      actionRequired: true,
      recommendedAction:
        'Open Agent approvals, verify the agreed commercial terms, and approve or reject.',
      linkedObjectType: 'BillingAgentCommand',
      linkedObjectId: result.command.id,
      deduplicationKey: `billing-agent-command:${result.command.id}`,
    },
  })
  return result
}

export async function executeApprovedBillingAgentCommand(params: {
  tenantId: string
  commandId: string
  actorId: string
  provider: BillingProvider
  environment: BillingEnvironment
  client?: DbClient
}) {
  const client = params.client ?? db
  const reserved = await client.$transaction(async (tx) => {
    const command = await tx.billingAgentCommand.findFirst({
      where: { id: params.commandId, tenantId: params.tenantId },
      include: { approvalRequest: { include: { decision: true } } },
    })
    if (!command) throw new BillingServiceError('NOT_FOUND', 'Billing command was not found.')
    if (command.status === 'COMPLETED') return { command, replayed: true }
    const recovering = command.status === 'EXECUTING' || command.status === 'FAILED'
    if (
      command.status === 'EXECUTING' &&
      command.updatedAt.getTime() + BILLING_COMMAND_LEASE_MS > Date.now()
    )
      throw new BillingServiceError('CONFLICT', 'Billing command is already executing.')
    if (!['PENDING_APPROVAL', 'APPROVED', 'EXECUTING', 'FAILED'].includes(command.status))
      throw new BillingServiceError(
        'CONFLICT',
        'Billing command requires reconciliation before retry.',
      )
    if (
      recovering &&
      !['EXECUTION_CLAIM_V2', 'RECONCILIATION_REQUIRED_V2'].includes(command.failureCode ?? '')
    )
      throw new BillingServiceError(
        'CONFLICT',
        'Legacy billing outcome requires explicit reconciliation before recovery.',
      )
    if (command.approvalRequest.expiresAt && command.approvalRequest.expiresAt <= new Date())
      throw new BillingServiceError('CONFLICT', 'Billing approval has expired.')
    if (
      command.approvalRequest.decision?.decision !== 'APPROVED' ||
      command.approvalRequest.decision.decidedByType !== 'HUMAN'
    ) {
      throw new BillingServiceError('FORBIDDEN', 'A current human approval is required.')
    }
    const payload = BillingAgentCommandPayload.parse(command.payload)
    const approvalScope = z
      .object({
        tenantId: z.string(),
        venueId: z.string(),
        payload: BillingAgentCommandPayload,
      })
      .strict()
      .safeParse(command.approvalRequest.scopeSnapshot)
    if (
      command.action !== payload.action ||
      command.approvalRequest.tenantId !== command.tenantId ||
      command.approvalRequest.venueId !== command.venueId ||
      command.approvalRequest.requestedByType !== 'AGENT' ||
      command.approvalRequest.proposedAction !== `billing.${payload.action.toLowerCase()}` ||
      !approvalScope.success ||
      approvalScope.data.tenantId !== command.tenantId ||
      approvalScope.data.venueId !== command.venueId ||
      JSON.stringify(approvalScope.data.payload) !== JSON.stringify(payload)
    ) {
      throw new BillingServiceError(
        'FORBIDDEN',
        'Billing approval does not match the exact command action and scope.',
      )
    }
    // The monotonically increasing revision fences completion by an expired worker.
    const claimedAt = new Date(Math.max(Date.now(), command.updatedAt.getTime() + 1))
    const claimed = await tx.billingAgentCommand.updateMany({
      where: {
        id: command.id,
        tenantId: params.tenantId,
        status: command.status,
        updatedAt: command.updatedAt,
      },
      data: { status: 'EXECUTING', failureCode: 'EXECUTION_CLAIM_V2', updatedAt: claimedAt },
    })
    if (claimed.count !== 1)
      throw new BillingServiceError(
        'CONFLICT',
        'Billing command changed or was claimed by another worker.',
      )
    return { command: { ...command, updatedAt: claimedAt }, payload, recovering, replayed: false }
  })
  if (reserved.replayed) return { command: reserved.command, replayed: true }
  const payload = BillingAgentCommandPayload.parse(reserved.command.payload)
  try {
    let result: unknown
    if (reserved.recovering && payload.action !== 'SET_GRACE_PERIOD') {
      // Provider-start records are durable, but their existence is not evidence of success.
      // Never repeat a money-like effect after an unknown outcome.
      if (payload.action === 'CREATE_NEGOTIATED_CHECKOUT') {
        const attempt = await client.billingCheckoutAttempt.findFirst({
          where: { tenantId: params.tenantId, operationKey: reserved.command.operationId },
        })
        if (
          attempt?.status !== 'CREATED' ||
          !attempt.providerCreatedAt ||
          !attempt.stripeCheckoutSessionId ||
          !attempt.stripeCheckoutUrl
        )
          throw new BillingServiceError(
            'CONFLICT',
            'Checkout outcome requires provider reconciliation; no new checkout was issued.',
          )
        result = {
          attemptId: attempt.id,
          sessionId: attempt.stripeCheckoutSessionId,
          url: attempt.stripeCheckoutUrl,
          replayed: true,
        }
      } else {
        const request = await client.billingCustomerRequest.findFirst({
          where: {
            tenantId: params.tenantId,
            operationId: reserved.command.operationId,
            kind: 'CANCELLATION',
          },
        })
        if (request?.status !== 'COMPLETED' || !request.providerActionAt)
          throw new BillingServiceError(
            'CONFLICT',
            'Cancellation outcome requires provider reconciliation; no cancellation was repeated.',
          )
        result = { request, replayed: true, awaitingWebhook: true }
      }
    } else if (payload.action === 'CREATE_NEGOTIATED_CHECKOUT') {
      result = await createTenantCheckout({
        tenantId: params.tenantId,
        actorId: params.actorId,
        actorRole: 'PLATFORM_ADMIN',
        planKey: payload.planKey,
        ...(payload.planVersion ? { planVersion: payload.planVersion } : {}),
        venueIds: payload.venueIds,
        operationKey: reserved.command.operationId,
        negotiatedTerms: {
          amountMinor: BigInt(payload.amountMinor),
          currency: payload.currency,
          interval: payload.interval,
          intervalCount: 1,
          reason: payload.reason,
          reference: payload.reference,
        },
        provider: params.provider,
        environment: params.environment,
        client,
      })
    } else if (payload.action === 'SET_GRACE_PERIOD') {
      result = await createBillingAccessOverride({
        tenantId: params.tenantId,
        agreementId: payload.agreementId,
        venueId: reserved.command.venueId,
        actorId: params.actorId,
        effect: 'GRANT',
        kind: 'GRACE_PERIOD',
        expiresAt: new Date(payload.expiresAt),
        reason: payload.reason,
        reference: payload.reference,
        idempotencyKey: `agent-command:${reserved.command.id}`,
        client,
      })
    } else {
      result = await requestTenantCancellation({
        tenantId: params.tenantId,
        actorId: params.actorId,
        actorRole: 'PLATFORM_ADMIN',
        operationId: reserved.command.operationId,
        reason: payload.reason,
        provider: params.provider,
        environment: params.environment,
        client,
      })
    }
    const completed = await client.billingAgentCommand.updateMany({
      where: {
        id: reserved.command.id,
        tenantId: params.tenantId,
        status: 'EXECUTING',
        updatedAt: reserved.command.updatedAt,
      },
      data: {
        status: 'COMPLETED',
        failureCode: null,
        executedBy: params.actorId,
        executedAt: new Date(),
        result: JSON.parse(
          JSON.stringify(result, (_, value) =>
            typeof value === 'bigint' ? value.toString() : value,
          ),
        ),
      },
    })
    if (completed.count !== 1)
      throw new BillingServiceError(
        'CONFLICT',
        'Billing execution lease was lost; its outcome must be reconciled.',
      )
    const command = await client.billingAgentCommand.findFirst({
      where: { id: reserved.command.id, tenantId: params.tenantId },
    })
    return { command, result, replayed: false }
  } catch (error) {
    await client.billingAgentCommand.updateMany({
      where: {
        id: reserved.command.id,
        tenantId: params.tenantId,
        status: 'EXECUTING',
        updatedAt: reserved.command.updatedAt,
      },
      data: {
        status: 'FAILED',
        executedBy: params.actorId,
        executedAt: new Date(),
        failureCode: 'RECONCILIATION_REQUIRED_V2',
      },
    })
    throw error
  }
}
