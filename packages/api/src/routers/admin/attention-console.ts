import { db, listFounderOperatingExchanges, withTenantIsolationBypass } from '@pathfinder/db'
import { deriveFounderBriefing } from './attention-briefing'
import { deriveAgentTrustEvidence } from './attention-agent-evidence'
import { readAgentEvidenceRows } from './attention-agent-evidence-query'
import { projectAttentionJobs } from './attention-job-recovery'
import { readFounderBriefingReview } from './attention-review-actions'
import {
  ACTIVE_SUPPORT_REQUEST_STATUSES,
  after,
  afterCondition,
  page,
  type AttentionConsoleInput,
} from './attention-pagination'
import { listAttentionWorkers } from './attention-worker-health'
import { readFounderUnitEconomics } from './unit-economics'
import { customerAccessApprovalSelect } from './customer-access-approval-select'
export async function readAttentionConsole(operatorUserId: string, query: AttentionConsoleInput) {
  return withTenantIsolationBypass(async () => {
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
      agentEvidenceRows,
      events,
      platformEvents,
      workers,
      reviewState,
      unitEconomics,
      founderConversation,
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
          bullJobId: true,
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
          customerAccessRequest: {
            select: customerAccessApprovalSelect,
          },
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
          agentIdentityId: true,
          tenantId: true,
          venueId: true,
          runType: true,
          requestedOperation: true,
          status: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
          agentIdentity: { select: { id: true, name: true } },
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
          updatedAt: true,
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
          agentIdentityId: true,
          tenantId: true,
          venueId: true,
          runType: true,
          requestedOperation: true,
          status: true,
          completedAt: true,
          createdAt: true,
          agentIdentity: { select: { id: true, name: true } },
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
          agentIdentityId: true,
          signalKind: true,
          verdict: true,
          summary: true,
          relatedAgentActionId: true,
          policyCode: true,
          severity: true,
          predictionRef: true,
          predictedConfidenceBps: true,
          actualCorrect: true,
          taskClass: true,
          modelProvider: true,
          modelName: true,
          createdAt: true,
          agentIdentity: { select: { id: true, name: true } },
        },
      }),
      readAgentEvidenceRows(db, take),
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
      listAttentionWorkers(now),
      readFounderBriefingReview(operatorUserId),
      readFounderUnitEconomics(now),
      listFounderOperatingExchanges(20),
    ])

    const result = {
      generatedAt: now,
      jobs: projectAttentionJobs(jobs, query.limit),
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
      workers,
      unitEconomics,
      founderConversation,
    }
    return {
      ...result,
      agentTrustEvidence: deriveAgentTrustEvidence({
        outcomes: result.outcomes,
        runs: result.agents,
        completedAgents: result.completedAgents,
        actions: page(agentEvidenceRows.actions, query.limit),
        approvalDecisions: page(agentEvidenceRows.approvalDecisions, query.limit),
      }),
      briefing: deriveFounderBriefing({
        limit: query.limit,
        events: result.events,
        platformEvents: result.platformEvents,
        questions: result.questions,
        approvals: result.approvals,
        blockedAgents: result.blockedAgents,
        support: result.support,
        workingAgents: result.workingAgents,
        completedAgents: result.completedAgents,
        outcomes: result.outcomes,
        lastReviewedThrough: reviewState?.reviewedThrough ?? null,
      }),
    }
  })
}

export { adminAttentionConsoleRouter } from './attention-console-router'
