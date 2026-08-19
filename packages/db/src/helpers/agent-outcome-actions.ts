import { z } from 'zod'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type AgentOutcomeActionClient = Pick<typeof db, '$transaction'>
type AgentOutcomeTransaction = Pick<
  typeof db,
  'agentOutcomeObservation' | 'agentRun' | 'agentTimelineEvent' | 'auditLog'
>

const inputSchema = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    agentRunId: z.string().trim().min(1).max(191),
    verdict: z.enum(['POSITIVE', 'MIXED', 'NEGATIVE', 'INCONCLUSIVE']),
    summary: z.string().trim().min(1).max(2000),
    evidenceRef: z.string().trim().min(1).max(500).optional(),
    actor: z
      .object({
        type: z.literal('HUMAN'),
        id: z.string().trim().min(1).max(191),
        role: z.literal('PLATFORM_ADMIN'),
      })
      .strict(),
  })
  .strict()

export type RecordAgentOutcomeInput = z.input<typeof inputSchema>

export class AgentOutcomeActionError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'AgentOutcomeActionError'
  }
}

const outcomeSelect = {
  id: true,
  operationId: true,
  tenantId: true,
  venueId: true,
  agentRunId: true,
  agentIdentityId: true,
  signalKind: true,
  verdict: true,
  summary: true,
  evidenceRef: true,
  taskClass: true,
  modelProvider: true,
  modelName: true,
  actorType: true,
  actorId: true,
  createdAt: true,
} as const

type NormalizedInput = z.output<typeof inputSchema>

function sameObservation(
  existing: {
    venueId: string
    agentRunId: string
    signalKind: string
    verdict: string
    summary: string
    evidenceRef: string | null
    actorType: string
    actorId: string
  },
  input: NormalizedInput,
) {
  return (
    existing.venueId === input.venueId &&
    existing.agentRunId === input.agentRunId &&
    existing.signalKind === 'HUMAN_REVIEW' &&
    existing.verdict === input.verdict &&
    existing.summary === input.summary &&
    existing.evidenceRef === (input.evidenceRef ?? null) &&
    existing.actorType === input.actor.type &&
    existing.actorId === input.actor.id
  )
}

function isUniqueConflict(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}

async function findReplay(transaction: AgentOutcomeTransaction, input: NormalizedInput) {
  const existing = await transaction.agentOutcomeObservation.findFirst({
    where: { tenantId: input.tenantId, operationId: input.operationId },
    select: outcomeSelect,
  })
  if (!existing) return null
  if (!sameObservation(existing, input)) {
    throw new AgentOutcomeActionError(
      'CONFLICT',
      'Outcome operation ID was already used for different evidence.',
    )
  }
  return { ...existing, replayed: true as const }
}

/** Appends one human quality observation. It never changes run status or execution authority. */
export async function recordAgentOutcomeAction(
  rawInput: RecordAgentOutcomeInput,
  client: AgentOutcomeActionClient = db,
) {
  const parsed = inputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new AgentOutcomeActionError('INVALID_INPUT', 'Agent outcome input is invalid.')
  }
  const input = parsed.data

  const attempt = () =>
    client.$transaction(async (transaction) => {
      const replay = await findReplay(transaction, input)
      if (replay) return replay

      const run = await transaction.agentRun.findFirst({
        where: {
          id: input.agentRunId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] },
        },
        select: {
          id: true,
          agentIdentityId: true,
          runType: true,
          modelProvider: true,
          modelName: true,
        },
      })
      if (!run) {
        throw new AgentOutcomeActionError(
          'NOT_FOUND',
          'A terminal agent run was not found in this venue.',
        )
      }

      const created = await transaction.agentOutcomeObservation.create({
        data: {
          operationId: input.operationId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentRunId: run.id,
          agentIdentityId: run.agentIdentityId,
          signalKind: 'HUMAN_REVIEW',
          verdict: input.verdict,
          summary: input.summary,
          evidenceRef: input.evidenceRef ?? null,
          taskClass: run.runType,
          modelProvider: run.modelProvider,
          modelName: run.modelName,
          actorType: input.actor.type,
          actorId: input.actor.id,
        },
        select: outcomeSelect,
      })

      await transaction.agentTimelineEvent.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentRunId: run.id,
          actorType: input.actor.type,
          actorId: input.actor.id,
          eventType: 'OUTCOME_OBSERVED',
          message: 'Operator recorded an explicit quality observation.',
          data: {
            outcomeObservationId: created.id,
            signalKind: created.signalKind,
            verdict: created.verdict,
          },
        },
      })

      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'agent-outcome.observed',
          targetType: 'AgentOutcomeObservation',
          targetId: created.id,
          afterState: {
            venueId: input.venueId,
            agentRunId: run.id,
            agentIdentityId: run.agentIdentityId,
            signalKind: created.signalKind,
            verdict: created.verdict,
            taskClass: created.taskClass,
            modelProvider: created.modelProvider,
            modelName: created.modelName,
            hasEvidenceReference: created.evidenceRef !== null,
          },
        },
        transaction,
      )

      return { ...created, replayed: false as const }
    })

  try {
    return await attempt()
  } catch (error) {
    if (error instanceof AgentOutcomeActionError || !isUniqueConflict(error)) throw error
    return client.$transaction(async (transaction) => {
      const replay = await findReplay(transaction, input)
      if (replay) return replay
      throw new AgentOutcomeActionError(
        'CONFLICT',
        'Outcome evidence changed concurrently; refresh before retrying.',
      )
    })
  }
}
