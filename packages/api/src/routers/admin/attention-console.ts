import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import {
  ACTIVE_SUPPORT_REQUEST_STATUSES,
  after,
  afterCondition,
  attentionConsoleInput,
  page,
} from './attention-pagination'

// Bounded metadata-only platform triage; no payloads, artifacts, messages, or raw provider errors.
export const adminAttentionConsoleRouter = router({
  attentionConsole: adminProcedure.input(attentionConsoleInput).query(({ input: query }) =>
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
        events,
        platformEvents,
        workers,
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
            status: { in: [...ACTIVE_SUPPORT_REQUEST_STATUSES] },
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
            questionType: true,
            category: true,
            urgency: true,
            choices: true,
            dueAt: true,
            evidence: true,
            proposedAnswer: true,
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
        db.operationalEvent.findMany({
          where: {
            state: { in: ['OPEN', 'ACKNOWLEDGED'] },
            ...after(query.eventsCursor),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            eventType: true,
            sourceSubsystem: true,
            severity: true,
            title: true,
            summary: true,
            actionRequired: true,
            linkedObjectType: true,
            linkedObjectId: true,
            recommendedAction: true,
            state: true,
            occurrenceCount: true,
            lastOccurredAt: true,
            createdAt: true,
          },
        }),
        db.platformOperationalEvent.findMany({
          where: {
            state: { in: ['OPEN', 'ACKNOWLEDGED'] },
            ...after(query.platformEventsCursor),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          select: {
            id: true,
            eventType: true,
            sourceSubsystem: true,
            severity: true,
            title: true,
            summary: true,
            actionRequired: true,
            linkedObjectType: true,
            linkedObjectId: true,
            recommendedAction: true,
            state: true,
            occurrenceCount: true,
            lastOccurredAt: true,
            createdAt: true,
          },
        }),
        db.agentWorker.findMany({
          orderBy: [{ lastHeartbeatAt: 'desc' }, { id: 'desc' }],
          take: 25,
          select: {
            id: true,
            workerKey: true,
            runtimeType: true,
            status: true,
            capabilities: true,
            protocolVersion: true,
            softwareVersion: true,
            modelProvider: true,
            modelName: true,
            lastHeartbeatAt: true,
            leaseExpiresAt: true,
            tenantId: true,
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
        events: page(events, query.limit),
        platformEvents: page(platformEvents, query.limit),
        workers: workers.map((worker) => ({
          ...worker,
          effectiveStatus:
            worker.status === 'ONLINE' && worker.leaseExpiresAt <= now ? 'OFFLINE' : worker.status,
        })),
      }
    }),
  ),

  acknowledgeOperationalEvent: adminProcedure
    .input(
      z
        .object({
          eventId: z.string().uuid(),
          scope: z.enum(['tenant', 'platform']).default('tenant'),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        const now = new Date()
        const change = {
          state: 'ACKNOWLEDGED' as const,
          readAt: now,
          readBy: ctx.session.userId,
          acknowledgedAt: now,
          acknowledgedBy: ctx.session.userId,
        }
        const updated =
          input.scope === 'platform'
            ? await db.platformOperationalEvent.updateMany({
                where: { id: input.eventId, state: 'OPEN' },
                data: change,
              })
            : await db.operationalEvent.updateMany({
                where: { id: input.eventId, state: 'OPEN' },
                data: change,
              })
        return { acknowledged: updated.count === 1 }
      }),
    ),

  resolveOperationalEvent: adminProcedure
    .input(
      z
        .object({
          eventId: z.string().uuid(),
          scope: z.enum(['tenant', 'platform']).default('tenant'),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        const now = new Date()
        const change = {
          state: 'RESOLVED' as const,
          readAt: now,
          readBy: ctx.session.userId,
          resolvedAt: now,
          resolvedBy: ctx.session.userId,
        }
        const updated =
          input.scope === 'platform'
            ? await db.platformOperationalEvent.updateMany({
                where: { id: input.eventId, state: { in: ['OPEN', 'ACKNOWLEDGED'] } },
                data: change,
              })
            : await db.operationalEvent.updateMany({
                where: { id: input.eventId, state: { in: ['OPEN', 'ACKNOWLEDGED'] } },
                data: change,
              })
        return { resolved: updated.count === 1 }
      }),
    ),
})
