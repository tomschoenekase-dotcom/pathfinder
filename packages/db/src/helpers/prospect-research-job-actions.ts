import { randomUUID } from 'node:crypto'

import { db } from '../client'

type Client = typeof db
type HumanActor = { type: 'HUMAN'; id: string; role: 'PLATFORM_ADMIN' }
export type ProspectResearchContext = {
  agentRunId: string
  agentIdentityId: string
  territoryIds?: readonly string[]
  modelProvider: string | null
  modelName: string | null
  promptIdentity: string
}

type TerminalOutcome = 'RESEARCHED' | 'NEEDS_REVIEW' | 'BLOCKED' | 'CAP_REACHED' | 'SKIPPED'

export class ProspectResearchJobError extends Error {
  constructor(
    readonly code: 'APPROVAL_REQUIRED' | 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message)
    this.name = 'ProspectResearchJobError'
  }
}

function json(value: unknown): object | unknown[] {
  return JSON.parse(JSON.stringify(value)) as object | unknown[]
}

export async function queueProspectResearchJobsAction(
  input: { organizationIds: readonly string[]; priority?: number; actor: HumanActor },
  client: Client = db,
) {
  if (!input.actor.id || input.actor.type !== 'HUMAN' || input.actor.role !== 'PLATFORM_ADMIN') {
    throw new ProspectResearchJobError('APPROVAL_REQUIRED', 'A human administrator is required')
  }
  const ids = [...new Set(input.organizationIds)]
  if (
    !ids.length ||
    ids.length > 5_000 ||
    (input.priority ?? 0) < -100 ||
    (input.priority ?? 0) > 100
  ) {
    throw new ProspectResearchJobError('INVALID_INPUT', 'A bounded research queue is required')
  }
  return client.$transaction(async (tx) => {
    const available = await tx.prospectOrganization.count({
      where: { id: { in: ids }, archivedAt: null },
    })
    if (available !== ids.length) {
      throw new ProspectResearchJobError('NOT_FOUND', 'One or more prospects are unavailable')
    }
    for (let offset = 0; offset < ids.length; offset += 500) {
      await tx.prospectResearchJob.createMany({
        data: ids.slice(offset, offset + 500).map((organizationId) => ({
          organizationId,
          priority: input.priority ?? 0,
          queuedBy: input.actor.id,
        })),
        skipDuplicates: true,
      })
    }
    return { queued: ids.length }
  })
}

export async function claimNextProspectResearchJobAction(
  input: { context: ProspectResearchContext; leaseSeconds?: number; now?: Date },
  client: Client = db,
) {
  const now = input.now ?? new Date()
  const leaseSeconds = Math.max(60, Math.min(input.leaseSeconds ?? 900, 1_800))
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1_000)
  const claimToken = randomUUID()
  return client.$transaction(async (tx) => {
    const candidate = await tx.prospectResearchJob.findFirst({
      where: {
        OR: [{ status: 'QUEUED' }, { status: 'CLAIMED', claimExpiresAt: { lt: now } }],
        organization: {
          archivedAt: null,
          ...(input.context.territoryIds?.length
            ? { territoryId: { in: [...new Set(input.context.territoryIds)] } }
            : {}),
        },
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      include: { organization: { include: { venues: true, contacts: true, sources: true } } },
    })
    if (!candidate) return null
    const claimed = await tx.prospectResearchJob.updateMany({
      where: {
        id: candidate.id,
        OR: [{ status: 'QUEUED' }, { status: 'CLAIMED', claimExpiresAt: { lt: now } }],
      },
      data: {
        status: 'CLAIMED',
        claimToken,
        claimOwnerId: input.context.agentIdentityId,
        claimAgentRunId: input.context.agentRunId,
        claimExpiresAt: leaseExpiresAt,
        attemptCount: { increment: 1 },
        terminalReason: null,
        completedAt: null,
      },
    })
    if (claimed.count !== 1) return null
    if (candidate.claimToken) {
      await tx.prospectResearchAttempt.updateMany({
        where: { claimToken: candidate.claimToken, status: 'CLAIMED' },
        data: { status: 'EXPIRED', completedAt: now, outcomeReason: 'LEASE_EXPIRED' },
      })
    }
    const attempt = await tx.prospectResearchAttempt.create({
      data: {
        jobId: candidate.id,
        claimToken,
        agentRunId: input.context.agentRunId,
        agentIdentityId: input.context.agentIdentityId,
        modelProvider: input.context.modelProvider,
        modelName: input.context.modelName,
        promptIdentity: input.context.promptIdentity,
        leaseExpiresAt,
      },
    })
    return {
      jobId: candidate.id,
      claimToken,
      leaseExpiresAt,
      attemptId: attempt.id,
      organization: candidate.organization,
    }
  })
}

export async function finishProspectResearchJobAction(
  input: {
    claimToken: string
    outcome: TerminalOutcome | 'RELEASED'
    reason: string
    usage?: unknown
    costUsd?: number
    context: ProspectResearchContext
    now?: Date
  },
  client: Client = db,
) {
  const now = input.now ?? new Date()
  const reason = input.reason.trim()
  if (!reason || reason.length > 2_000 || (input.costUsd ?? 0) < 0) {
    throw new ProspectResearchJobError(
      'INVALID_INPUT',
      'A bounded outcome reason and cost are required',
    )
  }
  return client.$transaction(async (tx) => {
    const job = await tx.prospectResearchJob.findUnique({ where: { claimToken: input.claimToken } })
    if (!job) throw new ProspectResearchJobError('NOT_FOUND', 'Research claim not found')
    if (
      job.status !== 'CLAIMED' ||
      job.claimOwnerId !== input.context.agentIdentityId ||
      job.claimAgentRunId !== input.context.agentRunId ||
      !job.claimExpiresAt ||
      job.claimExpiresAt <= now
    ) {
      throw new ProspectResearchJobError(
        'CONFLICT',
        'Research claim is expired or not owned by this run',
      )
    }
    const released = input.outcome === 'RELEASED'
    let terminalOutcome: TerminalOutcome | null = null
    let status: 'QUEUED' | TerminalOutcome = 'QUEUED'
    if (input.outcome !== 'RELEASED') {
      terminalOutcome = input.outcome
      status = input.outcome
    }
    await tx.prospectResearchAttempt.update({
      where: { claimToken: input.claimToken },
      data: {
        status: released ? 'RELEASED' : 'COMPLETED',
        outcome: terminalOutcome,
        outcomeReason: reason,
        usage: json(input.usage ?? {}),
        costUsd: input.costUsd === undefined ? null : input.costUsd.toFixed(6),
        completedAt: now,
      },
    })
    return tx.prospectResearchJob.update({
      where: { id: job.id },
      data: {
        status,
        claimToken: null,
        claimOwnerId: null,
        claimAgentRunId: null,
        claimExpiresAt: null,
        terminalReason: released ? null : reason,
        completedAt: released ? null : now,
      },
    })
  })
}
