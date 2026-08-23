export const dynamic = 'force-dynamic'

import { AgentRunOperationsView } from '../../../../../../../../../../components/admin/AgentRunOperationsView'
import { createAdminCaller } from '../../../../../../../../../../lib/admin-caller'

type Props = {
  params: Promise<{ tenantId: string; venueId: string; runId: string }>
  searchParams: Promise<Record<string, string | undefined>>
}
function cursor(query: Record<string, string | undefined>, prefix: string) {
  const createdAt = query[`${prefix}CreatedAt`]
  const id = query[`${prefix}Id`]
  return createdAt && id ? { createdAt, id } : undefined
}
function traceCursor(query: Record<string, string | undefined>) {
  const createdAt = query.traceCursorCreatedAt
  const kind = query.traceCursorKind
  const id = query.traceCursorId
  return createdAt && id && ['ACTION', 'EVENT', 'APPROVAL', 'OUTCOME'].includes(kind ?? '')
    ? { createdAt, kind: kind as 'ACTION' | 'EVENT' | 'APPROVAL' | 'OUTCOME', id }
    : undefined
}

export default async function AgentRunPage({ params, searchParams }: Props) {
  const { tenantId, venueId, runId } = await params
  const query = await searchParams
  const caller = await createAdminCaller()
  try {
    const [run, actions, timeline, approvals, outcomes, trace] = await Promise.all([
      caller.admin.getAgentRun({ tenantId, venueId, agentRunId: runId }),
      caller.admin.listAgentRunActions({
        tenantId,
        venueId,
        agentRunId: runId,
        limit: 25,
        ...(cursor(query, 'actionCursor') ? { cursor: cursor(query, 'actionCursor') } : {}),
      }),
      caller.admin.listAgentRunTimeline({
        tenantId,
        venueId,
        agentRunId: runId,
        limit: 25,
        ...(cursor(query, 'timelineCursor') ? { cursor: cursor(query, 'timelineCursor') } : {}),
      }),
      caller.admin.listApprovalRequests({
        tenantId,
        venueId,
        agentRunId: runId,
        state: 'ALL',
        limit: 25,
        ...(cursor(query, 'approvalCursor') ? { cursor: cursor(query, 'approvalCursor') } : {}),
      }),
      caller.admin.listAgentOutcomeObservations({
        tenantId,
        venueId,
        agentRunId: runId,
        limit: 25,
        ...(cursor(query, 'outcomeCursor') ? { cursor: cursor(query, 'outcomeCursor') } : {}),
      }),
      caller.admin.listAgentRunTrace({
        tenantId,
        venueId,
        agentRunId: runId,
        limit: 50,
        ...(traceCursor(query) ? { cursor: traceCursor(query) } : {}),
      }),
    ])
    return (
      <AgentRunOperationsView
        tenantId={tenantId}
        venueId={venueId}
        run={run}
        actions={actions}
        timeline={timeline}
        approvals={approvals}
        outcomes={outcomes}
        trace={trace}
      />
    )
  } catch {
    return (
      <section className="rounded-3xl border border-rose-200 bg-white p-8 shadow-sm" role="alert">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-rose-700">Agent run</p>
        <h2 className="mt-2 text-2xl font-semibold text-pf-deep">
          Run evidence could not be loaded
        </h2>
        <p className="mt-2 text-sm leading-6 text-pf-deep/65">
          The run may not exist in this venue or its evidence is unavailable. No operation was
          performed.
        </p>
      </section>
    )
  }
}
