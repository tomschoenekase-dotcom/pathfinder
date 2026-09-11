import { z } from 'zod'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type AgentQuestionExpirationTransaction = Pick<
  typeof db,
  '$queryRaw' | 'agentQuestion' | 'agentTimelineEvent' | 'auditLog'
>
export type AgentQuestionExpirationClient = Pick<typeof db, '$queryRaw' | '$transaction'>
export type AgentQuestionExpirationResult = 'EXPIRED' | 'NOT_DUE' | 'SKIPPED' | 'NOT_FOUND'

const scopeInput = z
  .object({
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    questionId: z.string().trim().min(1).max(191),
  })
  .strict()

async function questionMetadata(
  transaction: AgentQuestionExpirationTransaction,
  input: z.output<typeof scopeInput>,
) {
  const rows = await transaction.$queryRaw<Array<{ agentRunId: string | null }>>`
    SELECT agent_run_id AS "agentRunId"
    FROM agent_questions
    WHERE id = ${input.questionId}
      AND tenant_id = ${input.tenantId}
      AND venue_id = ${input.venueId}
  `
  return rows[0]
}

async function lockRun(
  transaction: AgentQuestionExpirationTransaction,
  input: z.output<typeof scopeInput>,
  agentRunId: string,
  skipLocked: boolean,
) {
  const rows = skipLocked
    ? await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM agent_runs
        WHERE id = ${agentRunId} AND tenant_id = ${input.tenantId} AND venue_id = ${input.venueId}
        FOR UPDATE SKIP LOCKED
      `
    : await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM agent_runs
        WHERE id = ${agentRunId} AND tenant_id = ${input.tenantId} AND venue_id = ${input.venueId}
        FOR UPDATE
      `
  return rows.length === 1
}

async function lockQuestion(
  transaction: AgentQuestionExpirationTransaction,
  input: z.output<typeof scopeInput>,
  skipLocked: boolean,
) {
  const rows = skipLocked
    ? await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM agent_questions
        WHERE id = ${input.questionId} AND tenant_id = ${input.tenantId} AND venue_id = ${input.venueId}
        FOR UPDATE SKIP LOCKED
      `
    : await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM agent_questions
        WHERE id = ${input.questionId} AND tenant_id = ${input.tenantId} AND venue_id = ${input.venueId}
        FOR UPDATE
      `
  return rows.length === 1
}

/** Expires one due question under the canonical run-before-question lock order. */
async function expireAgentQuestionIfDueDetailed(
  transaction: AgentQuestionExpirationTransaction,
  rawInput: z.input<typeof scopeInput>,
  options: { skipLocked?: boolean } = {},
): Promise<{ outcome: AgentQuestionExpirationResult; changed: boolean }> {
  const input = scopeInput.parse(rawInput)
  const metadata = await questionMetadata(transaction, input)
  if (!metadata) return { outcome: 'NOT_FOUND', changed: false }
  const skipLocked = options.skipLocked === true
  if (metadata.agentRunId && !(await lockRun(transaction, input, metadata.agentRunId, skipLocked)))
    return { outcome: skipLocked ? 'SKIPPED' : 'NOT_FOUND', changed: false }
  if (!(await lockQuestion(transaction, input, skipLocked)))
    return { outcome: skipLocked ? 'SKIPPED' : 'NOT_FOUND', changed: false }

  const rows = await transaction.$queryRaw<
    Array<{
      status: string
      expiresAt: Date | null
      now: Date
      agentRunId: string | null
    }>
  >`
    SELECT status, expires_at AS "expiresAt", clock_timestamp() AS now,
           agent_run_id AS "agentRunId"
    FROM agent_questions
    WHERE id = ${input.questionId}
      AND tenant_id = ${input.tenantId}
      AND venue_id = ${input.venueId}
  `
  const question = rows[0]
  if (!question) return { outcome: 'NOT_FOUND', changed: false }
  if (question.status === 'EXPIRED') return { outcome: 'EXPIRED', changed: false }
  if (
    question.status !== 'PENDING' ||
    question.expiresAt === null ||
    question.expiresAt > question.now
  )
    return { outcome: 'NOT_DUE', changed: false }

  const changed = await transaction.agentQuestion.updateMany({
    where: {
      id: input.questionId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      status: 'PENDING',
      expiresAt: question.expiresAt,
    },
    data: { status: 'EXPIRED' },
  })
  if (changed.count !== 1) return { outcome: 'NOT_DUE', changed: false }

  if (question.agentRunId) {
    await transaction.agentTimelineEvent.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentRunId: question.agentRunId,
        actorType: 'SYSTEM',
        actorId: 'agent-question-expiration',
        eventType: 'QUESTION_EXPIRED',
        message: 'The operator response window expired without an answer.',
        data: { questionId: input.questionId },
      },
    })
  }
  await writeAuditLogStrict(
    {
      tenantId: input.tenantId,
      actorType: 'SYSTEM',
      actorId: 'agent-question-expiration',
      actorRole: 'SYSTEM',
      action: 'agent-question.expired',
      targetType: 'AgentQuestion',
      targetId: input.questionId,
      beforeState: { status: 'PENDING' },
      afterState: {
        status: 'EXPIRED',
        venueId: input.venueId,
        expiresAt: question.expiresAt.toISOString(),
      },
    },
    transaction,
  )
  return { outcome: 'EXPIRED', changed: true }
}

export async function expireAgentQuestionIfDue(
  transaction: AgentQuestionExpirationTransaction,
  rawInput: z.input<typeof scopeInput>,
  options: { skipLocked?: boolean } = {},
): Promise<AgentQuestionExpirationResult> {
  return (await expireAgentQuestionIfDueDetailed(transaction, rawInput, options)).outcome
}

const batchInput = z.object({ limit: z.number().int().min(1).max(100).default(100) }).strict()

/** Runs one bounded global maintenance scan; every candidate settles in a short transaction. */
export async function expireAgentQuestionsAction(
  rawInput: { limit?: number } = {},
  client: AgentQuestionExpirationClient = db,
) {
  const { limit } = batchInput.parse(rawInput)
  const scanLimit = limit * 4
  const candidates = await client.$queryRaw<
    Array<{ id: string; tenantId: string; venueId: string }>
  >`
    SELECT id, tenant_id AS "tenantId", venue_id AS "venueId"
    FROM agent_questions
    WHERE status = 'PENDING'
      AND expires_at IS NOT NULL
      AND expires_at <= clock_timestamp()
    ORDER BY expires_at ASC, id ASC
    LIMIT ${scanLimit}
  `
  let expired = 0
  let skipped = 0
  let scanned = 0
  for (const candidate of candidates) {
    if (expired >= limit) break
    scanned += 1
    const result = await client.$transaction((transaction) =>
      expireAgentQuestionIfDueDetailed(
        transaction,
        {
          tenantId: candidate.tenantId,
          venueId: candidate.venueId,
          questionId: candidate.id,
        },
        { skipLocked: true },
      ),
    )
    if (result.outcome === 'EXPIRED' && result.changed) expired += 1
    else skipped += 1
  }
  return { scanned, expired, skipped }
}
