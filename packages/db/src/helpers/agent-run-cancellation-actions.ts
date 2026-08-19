import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type AgentRunCancellationActor = {
  type: 'HUMAN'
  id: string
  role: 'PLATFORM_ADMIN'
}
export type AgentRunCancellationClient = Pick<typeof db, '$transaction'>
export type AgentRunCancellationErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT'

export class AgentRunCancellationError extends Error {
  constructor(
    readonly code: AgentRunCancellationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AgentRunCancellationError'
  }
}

const cancellableStatuses = ['QUEUED', 'RUNNING', 'AWAITING_INPUT', 'AWAITING_APPROVAL'] as const
const terminalStatuses = ['COMPLETED', 'FAILED', 'CANCELLED'] as const

function invalid(message: string): never {
  throw new AgentRunCancellationError('INVALID_INPUT', message)
}

function validate(input: {
  tenantId: string
  venueId: string
  agentRunId: string
  reason: string
  actor: AgentRunCancellationActor
}) {
  if (
    typeof input?.tenantId !== 'string' ||
    !input.tenantId.trim() ||
    typeof input.venueId !== 'string' ||
    !input.venueId.trim() ||
    typeof input.agentRunId !== 'string' ||
    !input.agentRunId.trim()
  ) {
    invalid('Exact tenant, venue, and agent run scope is required.')
  }
  if (
    !input.actor ||
    input.actor.type !== 'HUMAN' ||
    input.actor.role !== 'PLATFORM_ADMIN' ||
    typeof input.actor.id !== 'string' ||
    !input.actor.id.trim()
  ) {
    invalid('A human platform administrator is required.')
  }
  if (typeof input.reason !== 'string') invalid('A cancellation reason is required.')
  const reason = input.reason.trim()
  if (!reason || reason.length > 500)
    invalid('A cancellation reason of 1 to 500 characters is required.')
  return reason
}

export async function requestAgentRunCancellationAction(
  input: {
    tenantId: string
    venueId: string
    agentRunId: string
    reason: string
    actor: AgentRunCancellationActor
  },
  client: AgentRunCancellationClient = db,
) {
  const reason = validate(input)
  return client.$transaction(async (rawTransaction) => {
    const transaction = rawTransaction as unknown as typeof db
    const run = await transaction.agentRun.findFirst({
      where: { id: input.agentRunId, tenantId: input.tenantId, venueId: input.venueId },
      select: { id: true, status: true, cancelRequestedAt: true },
    })
    if (!run) throw new AgentRunCancellationError('NOT_FOUND', 'Agent run not found.')

    // Cancellation intent is a run-level monotonic fact. Once present, every authorized
    // request converges on that fact regardless of the later caller or reason text.
    if (run.cancelRequestedAt) {
      return {
        id: run.id,
        status: run.status,
        cancelRequestedAt: run.cancelRequestedAt,
        outcome: 'REPLAYED' as const,
      }
    }
    if ((terminalStatuses as readonly string[]).includes(run.status)) {
      return {
        id: run.id,
        status: run.status,
        cancelRequestedAt: null,
        outcome: 'TERMINAL' as const,
      }
    }
    if (!(cancellableStatuses as readonly string[]).includes(run.status)) {
      throw new AgentRunCancellationError('CONFLICT', 'Agent run is not cancellable.')
    }

    const requestedAt = new Date()
    const changed = await transaction.agentRun.updateMany({
      where: {
        id: input.agentRunId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: run.status,
        cancelRequestedAt: null,
      },
      data: { cancelRequestedAt: requestedAt },
    })
    if (changed.count !== 1) {
      const current = await transaction.agentRun.findFirst({
        where: { id: input.agentRunId, tenantId: input.tenantId, venueId: input.venueId },
        select: { id: true, status: true, cancelRequestedAt: true },
      })
      if (!current) throw new AgentRunCancellationError('NOT_FOUND', 'Agent run not found.')
      if (current.cancelRequestedAt) {
        return {
          id: current.id,
          status: current.status,
          cancelRequestedAt: current.cancelRequestedAt,
          outcome: 'REPLAYED' as const,
        }
      }
      if ((terminalStatuses as readonly string[]).includes(current.status)) {
        return {
          id: current.id,
          status: current.status,
          cancelRequestedAt: null,
          outcome: 'TERMINAL' as const,
        }
      }
      throw new AgentRunCancellationError(
        'CONFLICT',
        'Agent run cancellation state changed; refresh and try again.',
      )
    }

    await transaction.agentTimelineEvent.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentRunId: input.agentRunId,
        actorType: 'HUMAN',
        actorId: input.actor.id,
        eventType: 'CANCELLATION_REQUESTED',
        message: 'A platform administrator requested cancellation.',
        data: { reasonLength: reason.length },
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'admin.agent-run.cancellation-requested',
        targetType: 'AgentRun',
        targetId: input.agentRunId,
        beforeState: { status: run.status, cancelRequested: false },
        afterState: {
          status: run.status,
          cancelRequested: true,
          requestedAt: requestedAt.toISOString(),
          reasonLength: reason.length,
        },
      },
      transaction,
    )
    return {
      id: run.id,
      status: run.status,
      cancelRequestedAt: requestedAt,
      outcome: 'REQUESTED' as const,
    }
  })
}
