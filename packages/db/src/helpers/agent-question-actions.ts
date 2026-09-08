import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { Prisma } from '@prisma/client'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { expireAgentQuestionIfDue } from './agent-question-expiration-actions'

export type AgentQuestionClient = Pick<typeof db, '$transaction'>

const id = z.string().trim().min(1).max(191)
const metadataValue = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()])
const evidenceKind = z.enum([
  'SOURCE_LINK',
  'DOCUMENT_EXCERPT',
  'PHOTO',
  'VIDEO_TIMESTAMP',
  'MAP',
  'CANDIDATE_ENTITY',
])
const evidenceItem = z
  .object({
    label: z.string().trim().min(1).max(200),
    reference: z.string().trim().min(1).max(500),
    summary: z.string().trim().min(1).max(1000).optional(),
    kind: evidenceKind.optional(),
    timestampSeconds: z.number().int().min(0).max(86_400).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.timestampSeconds !== undefined && value.kind !== 'VIDEO_TIMESTAMP') {
      ctx.addIssue({
        code: 'custom',
        path: ['timestampSeconds'],
        message: 'Evidence timestamps require VIDEO_TIMESTAMP kind.',
      })
    }
  })
const candidateEntity = z
  .object({
    label: z.string().trim().min(1).max(200),
    entityType: z.string().trim().min(1).max(100).optional(),
    reference: z.string().trim().min(1).max(500).optional(),
    summary: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
const answerConsequence = z
  .object({
    answer: z.string().trim().min(1).max(200),
    consequence: z.string().trim().min(1).max(1000),
  })
  .strict()
const candidateEntities = z.array(candidateEntity).max(12)
const answerConsequences = z.array(answerConsequence).max(8)
const proposedAnswer = z
  .record(z.string().max(100), z.union([metadataValue, candidateEntities, answerConsequences]))
  .superRefine((value, ctx) => {
    for (const [key, fieldValue] of Object.entries(value)) {
      const expected =
        key === 'candidateEntities'
          ? candidateEntities
          : key === 'answerConsequences'
            ? answerConsequences
            : metadataValue
      if (!expected.safeParse(fieldValue).success) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `Unsupported structured proposed-answer field: ${key}.`,
        })
      }
      if (
        key === 'confidence' &&
        (typeof fieldValue !== 'number' || fieldValue < 0 || fieldValue > 1)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'Proposed-answer confidence must be between 0 and 1.',
        })
      }
    }
  })
const questionFields = z
  .object({
    operationId: z.string().uuid(),
    tenantId: id,
    venueId: id,
    agentIdentityId: id,
    agentRunId: id.optional(),
    question: z.string().trim().min(1).max(2000),
    context: z.string().trim().min(1).max(2000).optional(),
    questionType: z
      .enum([
        'YES_NO',
        'MULTIPLE_CHOICE',
        'MULTI_SELECT',
        'SHORT_TEXT',
        'LONG_TEXT',
        'APPROVAL_REJECT',
        'DATE_TIME',
        'STRUCTURED_OBJECT',
      ])
      .default('SHORT_TEXT'),
    category: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u)
      .default('general'),
    urgency: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
    choices: z.array(z.string().trim().min(1).max(200)).max(8).default([]),
    dueAt: z.date().optional(),
    expiresAt: z.date().optional(),
    evidence: z.array(evidenceItem).max(20).default([]),
    proposedAnswer: proposedAnswer.optional(),
    callbackMetadata: z.record(z.string().max(100), metadataValue).optional(),
    blocking: z.boolean().default(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.questionType === 'MULTIPLE_CHOICE' || value.questionType === 'MULTI_SELECT') &&
      value.choices.length < 2
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['choices'],
        message: 'Choice questions require at least two choices.',
      })
    }
  })

const answerFields = z
  .object({
    tenantId: id,
    venueId: id,
    questionId: id,
    expectedUpdatedAt: z.date(),
    outcome: z.enum(['ANSWERED', 'DISMISSED']),
    answer: z.string().trim().min(1).max(5000),
    actor: z
      .object({
        actorType: z.literal('HUMAN'),
        actorId: id,
        auditRole: z.literal('PLATFORM_ADMIN'),
      })
      .strict(),
  })
  .strict()

export type AskAgentQuestionInput = z.input<typeof questionFields>
export type AnswerAgentQuestionInput = z.input<typeof answerFields>

export class AgentQuestionActionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'INVALID_INPUT' | 'EXPIRED',
    message: string,
  ) {
    super(message)
    this.name = 'AgentQuestionActionError'
  }
}

async function lockScopedAgentRun(
  transaction: Parameters<Parameters<AgentQuestionClient['$transaction']>[0]>[0],
  tenantId: string,
  venueId: string,
  agentRunId: string,
) {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM agent_runs
    WHERE id = ${agentRunId}
      AND tenant_id = ${tenantId}
      AND venue_id = ${venueId}
    FOR UPDATE
  `
  return rows.length === 1
}

function sameStoredJson(left: unknown, right: unknown) {
  // JSONB reorders object keys; compare its persisted shape while preserving array order.
  return isDeepStrictEqual(
    JSON.parse(JSON.stringify(left ?? null)),
    JSON.parse(JSON.stringify(right ?? null)),
  )
}

function sameQuestion(
  existing: {
    venueId: string
    agentIdentityId: string
    agentRunId: string | null
    question: string
    context: string | null
    choices: string[]
    blocking: boolean
    questionType: string
    category: string
    urgency: string
    expiresAt?: Date | null
    dueAt: Date | null
    evidence: unknown
    proposedAnswer: unknown
    callbackMetadata: unknown
  },
  input: z.output<typeof questionFields>,
) {
  return (
    existing.venueId === input.venueId &&
    existing.agentIdentityId === input.agentIdentityId &&
    existing.agentRunId === (input.agentRunId ?? null) &&
    existing.question === input.question &&
    existing.context === (input.context ?? null) &&
    existing.blocking === input.blocking &&
    existing.questionType === input.questionType &&
    existing.category === input.category &&
    existing.urgency === input.urgency &&
    existing.dueAt?.toISOString() === input.dueAt?.toISOString() &&
    existing.expiresAt?.toISOString() === input.expiresAt?.toISOString() &&
    sameStoredJson(existing.evidence, input.evidence) &&
    sameStoredJson(existing.proposedAnswer, input.proposedAnswer ?? null) &&
    sameStoredJson(existing.callbackMetadata, input.callbackMetadata ?? null) &&
    sameStoredJson(existing.choices, input.choices)
  )
}

const returnedQuestionSelect = {
  id: true,
  venueId: true,
  agentIdentityId: true,
  agentRunId: true,
  question: true,
  context: true,
  choices: true,
  blocking: true,
  questionType: true,
  category: true,
  urgency: true,
  dueAt: true,
  expiresAt: true,
  evidence: true,
  proposedAnswer: true,
  callbackMetadata: true,
  status: true,
  answer: true,
  updatedAt: true,
} satisfies Prisma.AgentQuestionSelect

/** Creates or replays one scoped clarification. It grants no approval or action authority. */
export async function askAgentQuestionAction(
  rawInput: AskAgentQuestionInput,
  client: AgentQuestionClient = db,
) {
  const input = questionFields.parse(rawInput)
  return client.$transaction(async (transaction) => {
    if (input.callbackMetadata?.workflow === 'intake-file-extraction-clarification') {
      const receiptId = input.callbackMetadata.receiptId
      const runId = input.callbackMetadata.runId
      const extractedTextHash = input.callbackMetadata.extractedTextHash
      if (
        typeof receiptId !== 'string' ||
        typeof runId !== 'string' ||
        typeof extractedTextHash !== 'string'
      ) {
        throw new AgentQuestionActionError(
          'INVALID_INPUT',
          'File clarification callback evidence is incomplete',
        )
      }
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:intake-file-extraction-review:${input.tenantId}:${input.venueId}:${receiptId}`}, 0))`
      const exactReceipt = await transaction.intakeFileExtractionReceipt.findFirst({
        where: {
          id: receiptId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          runId,
          outcome: 'SUCCEEDED',
          extractedTextHash,
          review: { is: null },
        },
        select: { id: true },
      })
      if (!exactReceipt) {
        throw new AgentQuestionActionError(
          'CONFLICT',
          'Exact unreviewed file extraction is no longer available for clarification',
        )
      }
    }
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:agent-question-operation:${input.tenantId}:${input.operationId}`}, 0))`
    const operation = await transaction.agentQuestionOperation.findUnique({
      where: {
        tenantId_operationId: { tenantId: input.tenantId, operationId: input.operationId },
      },
      select: { question: { select: returnedQuestionSelect } },
    })
    if (operation) {
      if (!sameQuestion(operation.question, input)) {
        throw new AgentQuestionActionError(
          'CONFLICT',
          'Question operation was already used for different content',
        )
      }
      return { question: operation.question, replayed: true, consolidated: false }
    }

    const existing = await transaction.agentQuestion.findFirst({
      where: { tenantId: input.tenantId, operationId: input.operationId },
      select: returnedQuestionSelect,
    })
    if (existing) {
      if (!sameQuestion(existing, input)) {
        throw new AgentQuestionActionError(
          'CONFLICT',
          'Question operation was already used for different content',
        )
      }
      await transaction.agentQuestionOperation.create({
        data: {
          tenantId: input.tenantId,
          operationId: input.operationId,
          venueId: input.venueId,
          questionId: existing.id,
        },
      })
      return { question: existing, replayed: true, consolidated: false }
    }

    const identity = await transaction.agentIdentity.findFirst({
      where: {
        id: input.agentIdentityId,
        tenantId: input.tenantId,
        enabled: true,
        OR: [{ venueId: input.venueId }, { venueId: null, accessScope: 'CLIENT' }],
      },
      select: { id: true },
    })
    if (!identity) {
      throw new AgentQuestionActionError('FORBIDDEN', 'Enabled agent identity is not in scope')
    }

    if (input.agentRunId) {
      if (
        !(await lockScopedAgentRun(transaction, input.tenantId, input.venueId, input.agentRunId))
      ) {
        throw new AgentQuestionActionError('FORBIDDEN', 'Active agent run is not in scope')
      }
      const run = await transaction.agentRun.findFirst({
        where: {
          id: input.agentRunId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentIdentityId: input.agentIdentityId,
          status: { in: ['QUEUED', 'RUNNING', 'AWAITING_INPUT', 'AWAITING_APPROVAL'] },
        },
        select: { id: true },
      })
      if (!run) throw new AgentQuestionActionError('FORBIDDEN', 'Active agent run is not in scope')

      const duplicate = await transaction.agentQuestion.findFirst({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentIdentityId: input.agentIdentityId,
          agentRunId: input.agentRunId,
          status: 'PENDING',
          expiresAt: input.expiresAt ?? null,
          question: input.question,
          context: input.context ?? null,
          questionType: input.questionType,
          category: input.category,
          urgency: input.urgency,
          choices: { equals: input.choices },
          dueAt: input.dueAt ?? null,
          evidence: { equals: input.evidence },
          proposedAnswer: {
            equals: input.proposedAnswer ?? Prisma.AnyNull,
          },
          callbackMetadata: {
            equals: input.callbackMetadata ?? Prisma.AnyNull,
          },
          blocking: input.blocking,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: returnedQuestionSelect,
      })
      if (
        duplicate &&
        (duplicate.expiresAt === null || duplicate.expiresAt > new Date()) &&
        sameQuestion(duplicate, input)
      ) {
        await transaction.agentQuestionOperation.create({
          data: {
            tenantId: input.tenantId,
            operationId: input.operationId,
            venueId: input.venueId,
            questionId: duplicate.id,
          },
        })
        await writeAuditLogStrict(
          {
            tenantId: input.tenantId,
            actorId: input.agentIdentityId,
            actorRole: 'AGENT',
            action: 'agent-question.consolidated',
            targetType: 'AgentQuestion',
            targetId: duplicate.id,
            afterState: {
              venueId: input.venueId,
              agentRunId: input.agentRunId,
              operationId: input.operationId,
            },
          },
          transaction,
        )
        return { question: duplicate, replayed: false, consolidated: true }
      }
    }

    const created = await transaction.agentQuestion.create({
      data: {
        operationId: input.operationId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentIdentityId: input.agentIdentityId,
        agentRunId: input.agentRunId ?? null,
        question: input.question,
        context: input.context ?? null,
        choices: input.choices,
        questionType: input.questionType,
        category: input.category,
        urgency: input.urgency,
        dueAt: input.dueAt ?? null,
        expiresAt: input.expiresAt ?? null,
        evidence: input.evidence,
        ...(input.proposedAnswer ? { proposedAnswer: input.proposedAnswer } : {}),
        ...(input.callbackMetadata ? { callbackMetadata: input.callbackMetadata } : {}),
        blocking: input.blocking,
      },
      select: returnedQuestionSelect,
    })

    await transaction.agentQuestionOperation.create({
      data: {
        tenantId: input.tenantId,
        operationId: input.operationId,
        venueId: input.venueId,
        questionId: created.id,
      },
    })

    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.agentIdentityId,
        actorRole: 'AGENT',
        action: 'agent-question.asked',
        targetType: 'AgentQuestion',
        targetId: created.id,
        afterState: {
          venueId: input.venueId,
          agentRunId: input.agentRunId ?? null,
          blocking: input.blocking,
        },
      },
      transaction,
    )

    if (input.agentRunId) {
      await transaction.agentTimelineEvent.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentRunId: input.agentRunId,
          actorType: 'AGENT',
          actorId: input.agentIdentityId,
          eventType: 'QUESTION_ASKED',
          message: input.blocking
            ? 'Agent asked a blocking operator question.'
            : 'Agent asked an operator question.',
          data: { questionId: created.id, blocking: input.blocking },
        },
      })
      await transaction.agentMessage.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentRunId: input.agentRunId,
          agentIdentityId: input.agentIdentityId,
          role: 'AGENT',
          messageType: 'STATUS',
          content: input.question,
          actorId: input.agentIdentityId,
        },
      })
      if (input.blocking) {
        await transaction.agentRun.updateMany({
          where: {
            id: input.agentRunId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            status: { in: ['QUEUED', 'RUNNING'] },
          },
          data: { status: 'AWAITING_INPUT' },
        })
      }
    }
    return { question: created, replayed: false, consolidated: false }
  })
}

/** Records one human response and makes a blocked run eligible to resume; it executes no tool. */
export async function answerAgentQuestionAction(
  rawInput: AnswerAgentQuestionInput,
  client: AgentQuestionClient = db,
) {
  const input = answerFields.parse(rawInput)
  const transactionResult = client.$transaction(async (transaction) => {
    async function resumeEligibility(agentRunId: string | null, blocking: boolean) {
      if (!agentRunId || !blocking) return false
      const hasOutstandingDelegatedDependency = async () => {
        const rows = await transaction.$queryRaw<Array<{ outstanding: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM agent_timeline_events waiting
            WHERE waiting.tenant_id=${input.tenantId}
              AND waiting.venue_id=${input.venueId}
              AND waiting.agent_run_id=${agentRunId}
              AND waiting.event_type='DELEGATED_DEPENDENCY_WAITING'
              AND jsonb_typeof(waiting.data->'childAgentRunId')='string'
              AND NOT EXISTS (
                SELECT 1 FROM agent_timeline_events ready
                WHERE ready.tenant_id=waiting.tenant_id
                  AND ready.venue_id=waiting.venue_id
                  AND ready.agent_run_id=waiting.agent_run_id
                  AND ready.event_type='DELEGATED_DEPENDENCY_READY'
                  AND ready.data->>'childAgentRunId'=waiting.data->>'childAgentRunId'
              )
          ) AS outstanding`
        return rows[0]?.outstanding !== false
      }
      const remainingBlockingQuestions = () =>
        transaction.agentQuestion.count({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            agentRunId,
            blocking: true,
            status: { in: ['PENDING', 'EXPIRED'] },
          },
        })
      const remaining = await remainingBlockingQuestions()
      if (remaining !== 0 || (await hasOutstandingDelegatedDependency())) return false
      const transitioned = await transaction.agentRun.updateMany({
        where: {
          id: agentRunId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          status: 'AWAITING_INPUT',
          cancelRequestedAt: null,
        },
        data: {
          status: 'QUEUED',
          executionBridgeSessionId: null,
          executionWorkerId: null,
          executionLeaseToken: null,
          executionLeaseExpiresAt: null,
          lastHeartbeatAt: null,
        },
      })
      if (transitioned.count === 1) {
        if (
          (await remainingBlockingQuestions()) === 0 &&
          !(await hasOutstandingDelegatedDependency())
        )
          return true
        await transaction.agentRun.updateMany({
          where: {
            id: agentRunId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            status: 'QUEUED',
          },
          data: { status: 'AWAITING_INPUT' },
        })
        return false
      }
      const alreadyQueued = await transaction.agentRun.findFirst({
        where: {
          id: agentRunId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          status: 'QUEUED',
          cancelRequestedAt: null,
        },
        select: { id: true },
      })
      return Boolean(
        alreadyQueued &&
        (await remainingBlockingQuestions()) === 0 &&
        !(await hasOutstandingDelegatedDependency()),
      )
    }
    const existing = await transaction.agentQuestion.findFirst({
      where: { id: input.questionId, tenantId: input.tenantId, venueId: input.venueId },
      select: {
        id: true,
        agentRunId: true,
        agentIdentityId: true,
        blocking: true,
        status: true,
        expiresAt: true,
        answer: true,
        answeredById: true,
        updatedAt: true,
      },
    })
    if (!existing) throw new AgentQuestionActionError('NOT_FOUND', 'Agent question not found')
    if (
      existing.agentRunId &&
      existing.blocking &&
      !(await lockScopedAgentRun(transaction, input.tenantId, input.venueId, existing.agentRunId))
    ) {
      throw new AgentQuestionActionError('NOT_FOUND', 'Agent question run is not in scope')
    }
    if (
      existing.status === input.outcome &&
      existing.answer === input.answer &&
      existing.answeredById === input.actor.actorId
    ) {
      const runEligibleToResume = await resumeEligibility(existing.agentRunId, existing.blocking)
      return {
        questionId: existing.id,
        agentRunId: existing.agentRunId,
        status: input.outcome,
        runEligibleToResume,
        replayed: true as const,
      }
    }
    if (existing.status === 'EXPIRED' || existing.expiresAt) {
      const expiry = await expireAgentQuestionIfDue(transaction, {
        tenantId: input.tenantId,
        venueId: input.venueId,
        questionId: existing.id,
      })
      if (expiry === 'EXPIRED') return { expired: true as const }
    }
    if (
      existing.status !== 'PENDING' ||
      existing.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()
    ) {
      throw new AgentQuestionActionError('CONFLICT', 'Agent question changed; refresh and retry')
    }

    const changed = await transaction.agentQuestion.updateMany({
      where: {
        id: existing.id,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'PENDING',
        updatedAt: input.expectedUpdatedAt,
      },
      data: {
        status: input.outcome,
        answer: input.answer,
        answeredById: input.actor.actorId,
        answeredAt: new Date(),
      },
    })
    if (changed.count !== 1) {
      const winner = await transaction.agentQuestion.findFirst({
        where: { id: input.questionId, tenantId: input.tenantId, venueId: input.venueId },
        select: {
          id: true,
          agentRunId: true,
          blocking: true,
          status: true,
          answer: true,
          answeredById: true,
        },
      })
      if (
        winner?.status === input.outcome &&
        winner.answer === input.answer &&
        winner.answeredById === input.actor.actorId
      ) {
        const runEligibleToResume = await resumeEligibility(winner.agentRunId, winner.blocking)
        return {
          questionId: winner.id,
          agentRunId: winner.agentRunId,
          status: input.outcome,
          runEligibleToResume,
          replayed: true as const,
        }
      }
      throw new AgentQuestionActionError('CONFLICT', 'Agent question changed; refresh and retry')
    }

    if (existing.agentRunId) {
      await transaction.agentTimelineEvent.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentRunId: existing.agentRunId,
          actorType: 'HUMAN',
          actorId: input.actor.actorId,
          eventType: input.outcome === 'ANSWERED' ? 'QUESTION_ANSWERED' : 'QUESTION_DISMISSED',
          message: 'Operator responded to an agent question.',
          data: { questionId: existing.id, outcome: input.outcome },
        },
      })
      await transaction.agentMessage.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentRunId: existing.agentRunId,
          agentIdentityId: existing.agentIdentityId,
          role: 'OPERATOR',
          messageType: 'ANSWER',
          content: input.answer,
          actorId: input.actor.actorId,
        },
      })
    }

    const runEligibleToResume = await resumeEligibility(existing.agentRunId, existing.blocking)

    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.actorId,
        actorRole: input.actor.auditRole,
        action: 'agent-question.responded',
        targetType: 'AgentQuestion',
        targetId: existing.id,
        beforeState: { status: existing.status },
        afterState: {
          status: input.outcome,
          runEligibleToResume,
        },
      },
      transaction,
    )
    return {
      questionId: existing.id,
      agentRunId: existing.agentRunId,
      status: input.outcome,
      runEligibleToResume,
      replayed: false as const,
    }
  })
  const result = await transactionResult.catch(async (error: unknown) => {
    // The cutoff can pass between the locked check and SQL answer write. That failed
    // transaction rolled back; commit expiration separately before reporting expiry.
    if (
      !(error instanceof Error) ||
      !error.message.includes('agent question answer deadline has expired')
    )
      throw error
    const expiry = await client.$transaction((tx) =>
      expireAgentQuestionIfDue(tx, {
        tenantId: input.tenantId,
        venueId: input.venueId,
        questionId: input.questionId,
      }),
    )
    if (expiry !== 'EXPIRED') throw error
    return { expired: true as const }
  })
  if ('expired' in result)
    throw new AgentQuestionActionError(
      'EXPIRED',
      'This question has expired. Review the blocked run before starting replacement work.',
    )
  return result
}
