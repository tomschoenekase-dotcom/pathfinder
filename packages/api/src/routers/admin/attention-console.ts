import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const cursor = z.object({ createdAt: z.string().datetime(), id: z.string().min(1).max(191) })
const input = z
  .object({
    limit: z.number().int().min(1).max(25).default(10),
    jobsCursor: cursor.optional(),
    evaluationsCursor: cursor.optional(),
    approvalsCursor: cursor.optional(),
    supportCursor: cursor.optional(),
    agentsCursor: cursor.optional(),
    questionsCursor: cursor.optional(),
    workingAgentsCursor: cursor.optional(),
    blockedAgentsCursor: cursor.optional(),
    completedAgentsCursor: cursor.optional(),
    outcomesCursor: cursor.optional(),
  })
  .default({ limit: 10 })

type Cursor = z.infer<typeof cursor>

function after(value?: Cursor) {
  if (!value) return {}
  const createdAt = new Date(value.createdAt)
  return {
    AND: [
      {
        OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: value.id } }],
      },
    ],
  }
}

function afterCondition(value?: Cursor) {
  if (!value) return undefined
  const createdAt = new Date(value.createdAt)
  return { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: value.id } }] }
}

function page<T extends { id: string; createdAt: Date }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  return {
    items,
    nextCursor:
      rows.length > limit && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null,
  }
}

/**
 * Bounded, metadata-only cross-tenant read model for internal operations triage.
 * It intentionally omits payloads, snapshots, artifacts, support messages, raw
 * provider errors, and action controls.
 */
export const adminAttentionConsoleRouter = router({
  attentionConsole: adminProcedure.input(input).query(({ input: query }) =>
    withTenantIsolationBypass(async () => {
      const now = new Date()
      const take = query.limit + 1
      const [
        jobs,
        evaluations,
        approvals,
        support,
        agents,
        questions,
        workingAgents,
        blockedAgents,
        completedAgents,
        outcomes,
      ] = await Promise.all([
        db.jobRecord.findMany({
          where: { status: 'FAILED', ...after(query.jobsCursor) },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          select: {
            id: true,
            tenantId: true,
            queue: true,
            jobName: true,
            status: true,
            attemptNumber: true,
            maxAttempts: true,
            failureDisposition: true,
            terminalAt: true,
            createdAt: true,
          },
        }),
        db.evalRun.findMany({
          where: {
            AND: [
              {
                OR: [
                  { status: { in: ['FAILED', 'STAGED', 'RETRY_SCHEDULED'] } },
                  {
                    status: 'RUNNING',
                    executionLeaseExpiresAt: { lte: now },
                  },
                ],
              },
              ...(afterCondition(query.evaluationsCursor)
                ? [afterCondition(query.evaluationsCursor)!]
                : []),
            ],
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            status: true,
            attemptNumber: true,
            maxAttempts: true,
            executionLeaseExpiresAt: true,
            lastErrorCode: true,
            createdAt: true,
          },
        }),
        db.approvalRequest.findMany({
          where: { decision: { is: null }, ...after(query.approvalsCursor) },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            proposedAction: true,
            riskCategory: true,
            expiresAt: true,
            createdAt: true,
            agentIdentity: { select: { name: true } },
          },
        }),
        db.supportRequest.findMany({
          where: {
            status: { in: ['WAITING_FOR_CLIENT', 'VALIDATING', 'AWAITING_APPROVAL'] },
            ...after(query.supportCursor),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            category: true,
            status: true,
            subject: true,
            version: true,
            updatedAt: true,
            createdAt: true,
            onboardingQuestionLink: {
              select: { id: true, agentQuestionId: true },
            },
          },
        }),
        db.agentRun.findMany({
          where: after(query.agentsCursor),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            runType: true,
            requestedOperation: true,
            status: true,
            startedAt: true,
            completedAt: true,
            createdAt: true,
            agentIdentity: { select: { name: true } },
          },
        }),
        db.agentQuestion.findMany({
          where: { status: 'PENDING', ...after(query.questionsCursor) },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            agentRunId: true,
            question: true,
            context: true,
            choices: true,
            blocking: true,
            createdAt: true,
            agentIdentity: { select: { name: true } },
            agentRun: { select: { id: true, status: true, requestedOperation: true } },
          },
        }),
        db.agentRun.findMany({
          where: {
            status: { in: ['QUEUED', 'RUNNING'] },
            ...after(query.workingAgentsCursor),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            runType: true,
            requestedOperation: true,
            status: true,
            startedAt: true,
            createdAt: true,
            agentIdentity: { select: { name: true } },
          },
        }),
        db.agentRun.findMany({
          where: {
            status: { in: ['AWAITING_INPUT', 'AWAITING_APPROVAL', 'FAILED'] },
            ...after(query.blockedAgentsCursor),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            runType: true,
            requestedOperation: true,
            status: true,
            errorCode: true,
            createdAt: true,
            agentIdentity: { select: { name: true } },
          },
        }),
        db.agentRun.findMany({
          where: { status: 'COMPLETED', ...after(query.completedAgentsCursor) },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            runType: true,
            requestedOperation: true,
            status: true,
            completedAt: true,
            createdAt: true,
            agentIdentity: { select: { name: true } },
            _count: { select: { outcomeObservations: true } },
          },
        }),
        db.agentOutcomeObservation.findMany({
          where: after(query.outcomesCursor),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            agentRunId: true,
            signalKind: true,
            verdict: true,
            summary: true,
            taskClass: true,
            modelProvider: true,
            modelName: true,
            createdAt: true,
            agentIdentity: { select: { name: true } },
          },
        }),
      ])

      return {
        generatedAt: now,
        jobs: page(jobs, query.limit),
        evaluations: {
          ...page(evaluations, query.limit),
          items: page(evaluations, query.limit).items.map((item) => ({
            ...item,
            expiredLease:
              item.status === 'RUNNING' &&
              item.executionLeaseExpiresAt !== null &&
              item.executionLeaseExpiresAt <= now,
          })),
        },
        approvals: {
          ...page(approvals, query.limit),
          items: page(approvals, query.limit).items.map((item) => ({
            ...item,
            expired: item.expiresAt !== null && item.expiresAt <= now,
          })),
        },
        support: page(support, query.limit),
        agents: page(agents, query.limit),
        questions: page(questions, query.limit),
        workingAgents: page(workingAgents, query.limit),
        blockedAgents: page(blockedAgents, query.limit),
        completedAgents: page(completedAgents, query.limit),
        outcomes: page(outcomes, query.limit),
      }
    }),
  ),
})
