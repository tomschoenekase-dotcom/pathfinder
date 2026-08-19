import { env } from '@pathfinder/config'
import { askAgentQuestionAction, delegateAgentTaskAction } from '@pathfinder/db'
import type { AgentDelegationClient, AgentQuestionClient } from '@pathfinder/db'
import { enqueueAgentRun } from '@pathfinder/jobs'

import type { PathfinderMcpDomainActions } from './registry'

/** Adds the first durable agent-to-operator interaction without adding transport or execution. */
export function createPathfinderMcpAgentActions(
  db: AgentQuestionClient & AgentDelegationClient,
  remainingActions: Omit<PathfinderMcpDomainActions, 'askOperator' | 'delegateSpecialist'>,
): PathfinderMcpDomainActions {
  return {
    ...remainingActions,
    async delegateSpecialist(input, context) {
      const result = await delegateAgentTaskAction(
        {
          operationId: input.operationId,
          tenantId: context.credential.tenantId,
          venueId: input.venueId!,
          parentAgentRunId: input.parentAgentRunId,
          requestingAgentIdentityId: input.requestingAgentIdentityId,
          specialistAgentIdentityId: input.specialistAgentIdentityId,
          instructions: input.instructions,
          reason: input.reason,
        },
        db,
      )
      const dispatch = await enqueueAgentRun(
        { tenantId: context.credential.tenantId, runId: result.run.id },
        { enabled: env.AGENT_RUNNER_ENABLED },
      )
      return {
        kind: 'pathfinder.agent-delegation',
        summary: result.replayed
          ? 'Existing specialist delegation returned.'
          : dispatch.enqueued
            ? 'Specialist task queued for execution.'
            : 'Specialist task recorded; the agent runtime is paused.',
        data: {
          id: result.run.id,
          parentAgentRunId: result.run.parentAgentRunId,
          specialistAgentIdentityId: result.run.agentIdentityId,
          status: result.run.status,
          replayed: result.replayed,
          executionTriggered: dispatch.enqueued,
        },
      }
    },
    async askOperator(input, context) {
      const result = await askAgentQuestionAction(
        {
          operationId: input.operationId,
          tenantId: context.credential.tenantId,
          venueId: input.venueId!,
          agentIdentityId: input.agentIdentityId,
          ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
          question: input.question,
          ...(input.context ? { context: input.context } : {}),
          choices: input.choices,
          blocking: input.blocking,
        },
        db,
      )
      return {
        kind: 'pathfinder.agent-question',
        summary: result.replayed
          ? 'Existing operator question returned.'
          : input.blocking
            ? 'Agent run is waiting for an operator answer.'
            : 'Operator question was recorded.',
        data: {
          id: result.question.id,
          agentRunId: result.question.agentRunId,
          status: result.question.status,
          blocking: result.question.blocking,
          replayed: result.replayed,
          updatedAt: result.question.updatedAt.toISOString(),
        },
      }
    },
  }
}
