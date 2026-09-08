export const dynamic = 'force-dynamic'

import {
  AgentOperationsOverview,
  agentQuestionStatusFilters,
  type AgentQuestionStatusFilter,
} from '../../../../../../../../components/admin/AgentOperationsOverview'
import { createAdminCaller } from '../../../../../../../../lib/admin-caller'
import { env } from '@pathfinder/config'
import { auth } from '@clerk/nextjs/server'

type Props = {
  params: Promise<{ tenantId: string; venueId: string }>
  searchParams: Promise<Record<string, string | undefined>>
}
function cursor(query: Record<string, string | undefined>, prefix: string) {
  const createdAt = query[`${prefix}CreatedAt`]
  const id = query[`${prefix}Id`]
  return createdAt && id ? { createdAt, id } : undefined
}

function questionStatus(query: Record<string, string | undefined>): AgentQuestionStatusFilter {
  const candidate = query.questionStatus
  return agentQuestionStatusFilters.find((status) => status === candidate) ?? 'PENDING'
}

export default async function AgentOperationsPage({ params, searchParams }: Props) {
  const { tenantId, venueId } = await params
  const query = await searchParams
  const selectedQuestionStatus = questionStatus(query)
  const { userId } = await auth()
  const caller = await createAdminCaller()
  try {
    const [
      identities,
      runs,
      approvals,
      questions,
      approvalPolicies,
      outcomeObservations,
      bridgeSessions,
      questionRecipients,
      workflowActivations,
      workflowActivationReview,
    ] = await Promise.all([
      caller.admin.listAgentIdentities({
        tenantId,
        venueId,
        limit: 20,
        ...(cursor(query, 'identityCursor') ? { cursor: cursor(query, 'identityCursor') } : {}),
      }),
      caller.admin.listAgentRuns({
        tenantId,
        venueId,
        limit: 20,
        ...(cursor(query, 'runCursor') ? { cursor: cursor(query, 'runCursor') } : {}),
      }),
      caller.admin.listApprovalRequests({
        tenantId,
        venueId,
        state: 'ALL',
        limit: 20,
        ...(cursor(query, 'approvalCursor') ? { cursor: cursor(query, 'approvalCursor') } : {}),
      }),
      caller.admin.listAgentQuestions({
        tenantId,
        venueId,
        status: selectedQuestionStatus,
        limit: 20,
        ...(cursor(query, 'questionCursor') ? { cursor: cursor(query, 'questionCursor') } : {}),
      }),
      caller.admin.listAgentApprovalPolicies({ tenantId, venueId, limit: 100 }),
      caller.admin.listAgentOutcomeObservations({ tenantId, venueId, limit: 100 }),
      caller.admin.listAgentBridgeSessions({ tenantId, venueId }),
      caller.admin.listOnboardingQuestionRecipients({ tenantId, venueId }),
      caller.admin.listAgentWorkflowActivations({ tenantId, venueId, limit: 20 }),
      caller.admin.getAgentWorkflowActivationReview({ tenantId, venueId, limit: 20 }),
    ])
    return (
      <AgentOperationsOverview
        actorId={userId}
        tenantId={tenantId}
        venueId={venueId}
        identities={identities}
        runs={runs}
        approvals={approvals}
        questions={questions}
        questionStatus={selectedQuestionStatus}
        approvalPolicies={approvalPolicies}
        outcomeObservations={outcomeObservations.items}
        questionRecipients={questionRecipients}
        runtime={{ agentRunnerEnabled: env.AGENT_RUNNER_ENABLED }}
        bridgeSessions={bridgeSessions}
        workflowActivations={workflowActivations}
        workflowActivationReview={workflowActivationReview}
      />
    )
  } catch {
    return <ErrorState />
  }
}

function ErrorState() {
  return (
    <section className="rounded-3xl border border-rose-200 bg-white p-8 shadow-sm" role="alert">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-rose-700">
        Agent operations
      </p>
      <h2 className="mt-2 text-2xl font-semibold text-pf-deep">
        Control-plane evidence could not be loaded
      </h2>
      <p className="mt-2 text-sm leading-6 text-pf-deep/65">
        Refresh the page or return later. No agent was run, retried, cancelled, enabled, or
        approved.
      </p>
    </section>
  )
}
