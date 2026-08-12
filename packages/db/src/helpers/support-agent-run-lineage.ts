import { createHash } from 'node:crypto'

import { z } from 'zod'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

const inputSchema = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    requestId: z.string().trim().min(1).max(191),
    agentRunId: z.string().trim().min(1).max(191),
    expectedVersion: z.number().int().positive(),
    actor: z
      .object({
        actorType: z.literal('HUMAN'),
        actorId: z.string().trim().min(1).max(191),
        auditRole: z.literal('PLATFORM_ADMIN'),
      })
      .strict(),
  })
  .strict()

type LineageClient = Pick<typeof db, '$transaction'>

export class SupportAgentRunLineageError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN',
    message: string,
  ) {
    super(message)
    this.name = 'SupportAgentRunLineageError'
  }
}

function parseInput(input: unknown): z.infer<typeof inputSchema> {
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) {
    throw new SupportAgentRunLineageError('INVALID_INPUT', 'Invalid Support lineage input')
  }
  return parsed.data
}

function operationHash(input: z.infer<typeof inputSchema>) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        domain: 'pathfinder.support-agent-run-lineage.v1',
        actorId: input.actor.actorId,
        agentRunId: input.agentRunId,
        expectedVersion: input.expectedVersion,
        requestId: input.requestId,
        tenantId: input.tenantId,
        venueId: input.venueId,
      }),
    )
    .digest('hex')
}

function isUniqueConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

const lineageSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  supportRequestId: true,
  requestVersion: true,
  agentRunId: true,
  linkedRunStatus: true,
  linkedRunCompletedAt: true,
  linkedByKind: true,
  linkedById: true,
  linkedByRole: true,
  createdAt: true,
} as const

async function linkOnce(input: z.infer<typeof inputSchema>, client: LineageClient) {
  const hash = operationHash(input)
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:support-agent-run:${input.tenantId}:${input.operationId}`}, 0))`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:support-request:${input.tenantId}:${input.requestId}`}, 0))`

    const request = await tx.supportRequest.findFirst({
      where: { id: input.requestId, tenantId: input.tenantId, venueId: input.venueId },
      select: { id: true, status: true, version: true },
    })
    if (!request) throw new SupportAgentRunLineageError('NOT_FOUND', 'Support request not found')
    const run = await tx.agentRun.findFirst({
      where: { id: input.agentRunId, tenantId: input.tenantId, venueId: input.venueId },
      select: { id: true, status: true, agentIdentityId: true, completedAt: true },
    })
    if (!run) throw new SupportAgentRunLineageError('NOT_FOUND', 'Agent run not found')

    const replay = await tx.supportAgentRunLineage.findFirst({
      where: { tenantId: input.tenantId, operationId: input.operationId },
      select: { ...lineageSelect, operationHash: true },
    })
    if (replay) {
      if (
        replay.venueId !== input.venueId ||
        replay.supportRequestId !== input.requestId ||
        replay.agentRunId !== input.agentRunId ||
        replay.linkedById !== input.actor.actorId ||
        replay.linkedByKind !== 'OPERATOR' ||
        replay.linkedByRole !== 'PLATFORM_ADMIN' ||
        replay.operationHash !== hash
      ) {
        throw new SupportAgentRunLineageError('CONFLICT', 'Operation ID was already used')
      }
      return {
        lineage: {
          id: replay.id,
          tenantId: replay.tenantId,
          venueId: replay.venueId,
          supportRequestId: replay.supportRequestId,
          requestVersion: replay.requestVersion,
          agentRunId: replay.agentRunId,
          linkedRunStatus: replay.linkedRunStatus,
          linkedRunCompletedAt: replay.linkedRunCompletedAt,
          linkedByKind: replay.linkedByKind,
          linkedById: replay.linkedById,
          linkedByRole: replay.linkedByRole,
          createdAt: replay.createdAt,
        },
        requestVersion: replay.requestVersion,
        replayed: true as const,
      }
    }

    if (request.version !== input.expectedVersion) {
      throw new SupportAgentRunLineageError('CONFLICT', 'Support request changed; refresh it')
    }
    if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status) || run.completedAt === null) {
      throw new SupportAgentRunLineageError('CONFLICT', 'Agent run is not terminal evidence')
    }
    const requestEvent = await tx.supportRequestAuditEvent.findFirst({
      where: {
        supportRequestId: request.id,
        tenantId: input.tenantId,
        venueId: input.venueId,
        requestVersion: input.expectedVersion,
      },
      select: { id: true },
    })
    if (!requestEvent) {
      throw new SupportAgentRunLineageError(
        'CONFLICT',
        'Support request version evidence is unavailable',
      )
    }
    const existingRunLink = await tx.supportAgentRunLineage.findFirst({
      where: { tenantId: input.tenantId, venueId: input.venueId, agentRunId: run.id },
      select: { id: true },
    })
    if (existingRunLink) {
      throw new SupportAgentRunLineageError('CONFLICT', 'Agent run is already linked')
    }

    const lineage = await tx.supportAgentRunLineage.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        supportRequestId: request.id,
        requestVersion: input.expectedVersion,
        agentRunId: run.id,
        linkedRunStatus: run.status,
        linkedRunCompletedAt: run.completedAt,
        operationId: input.operationId,
        operationHash: hash,
        linkedByKind: 'OPERATOR',
        linkedById: input.actor.actorId,
        linkedByRole: 'PLATFORM_ADMIN',
      },
      select: lineageSelect,
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.actorId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'support-request.agent-run-linked',
        targetType: 'SupportRequest',
        targetId: request.id,
        beforeState: { status: request.status, version: request.version },
        afterState: {
          status: request.status,
          version: request.version,
          agentRunId: run.id,
          agentIdentityId: run.agentIdentityId,
          linkedRunStatus: run.status,
          linkedRunCompletedAt: run.completedAt,
          agentRunLifecycleChanged: false,
          executionTriggered: false,
        },
      },
      tx,
    )
    return { lineage, requestVersion: input.expectedVersion, replayed: false as const }
  })
}

/** Records lineage only; it never creates or mutates an AgentRun. */
export async function linkSupportRequestAgentRunAction(
  rawInput: unknown,
  client: LineageClient = db,
) {
  const input = parseInput(rawInput)
  try {
    return await linkOnce(input, client)
  } catch (error) {
    if (!isUniqueConflict(error)) throw error
    try {
      return await linkOnce(input, client)
    } catch (replayError) {
      if (isUniqueConflict(replayError)) {
        throw new SupportAgentRunLineageError('CONFLICT', 'Lineage could not be reconciled')
      }
      throw replayError
    }
  }
}
