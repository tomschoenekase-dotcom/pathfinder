import { withTenantIsolationBypass } from '@pathfinder/db'
import { deriveFounderBriefing } from './attention-briefing'
import { deriveAgentTrustEvidence } from './attention-agent-evidence'
import { projectAttentionJobs } from './attention-job-recovery'
import { page, type AttentionConsoleInput } from './attention-pagination'
import { readFounderAbsenceReadinessWithHistory } from './attention-founder-absence-query'
import { mergePriorityQuestions } from './attention-priority-questions'
import { mergePriorityEvents } from './attention-priority-events'
import { readAttentionConsoleRows } from './attention-console-read-rows'

export { mergePriorityQuestions } from './attention-priority-questions'

export async function readAttentionConsole(operatorUserId: string, query: AttentionConsoleInput) {
  return withTenantIsolationBypass(async () => {
    const now = new Date()
    const take = query.limit + 1
    const {
      jobs,
      evaluations,
      approvals,
      support,
      agents,
      questions,
      priorityQuestions,
      workingAgents,
      blockedAgents,
      completedAgents,
      outcomes,
      agentEvidenceRows,
      events,
      criticalEvents,
      errorEvents,
      platformEvents,
      criticalPlatformEvents,
      errorPlatformEvents,
      workers,
      reviewState,
      unitEconomics,
      founderConversation,
    } = await readAttentionConsoleRows(operatorUserId, query, now, take)
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
      questions: mergePriorityQuestions(questions, priorityQuestions, query.limit),
      workingAgents: page(workingAgents, query.limit),
      blockedAgents: page(blockedAgents, query.limit),
      completedAgents: page(completedAgents, query.limit),
      outcomes: page(outcomes, query.limit),
      events: mergePriorityEvents(events, [...criticalEvents, ...errorEvents], query.limit),
      platformEvents: mergePriorityEvents(
        platformEvents,
        [...criticalPlatformEvents, ...errorPlatformEvents],
        query.limit,
      ),
      workers,
      unitEconomics,
      founderConversation,
    }
    const agentTrustEvidence = deriveAgentTrustEvidence({
      outcomes: result.outcomes,
      runs: result.agents,
      completedAgents: result.completedAgents,
      actions: page(agentEvidenceRows.actions, query.limit),
      approvalDecisions: page(agentEvidenceRows.approvalDecisions, query.limit),
    })
    const founderAbsenceReadiness = await readFounderAbsenceReadinessWithHistory(
      {
        generatedAt: result.generatedAt,
        jobs: result.jobs,
        evaluations: result.evaluations,
        approvals: result.approvals,
        support: result.support,
        questions: result.questions,
        blockedAgents: result.blockedAgents,
        events: result.events,
        platformEvents: result.platformEvents,
        agentTrustEvidence,
      },
      now,
    )
    return {
      ...result,
      agentTrustEvidence,
      founderAbsenceReadiness,
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
