import { env, isFeatureEnabled } from '@pathfinder/config'
import {
  dispatchIntakeSourceAgentTask,
  listPendingIntakeSourceAgentDispatches,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { enqueueAgentRun } from '@pathfinder/jobs'

type PendingDispatch = { id: string; tenantId: string; venueId: string }
type DispatchResult = {
  status: 'COMPLETED' | 'HELD' | 'CANCELLED'
  runId?: string
  replayed?: boolean
}

export type IntakeSourceAgentDispatchDependencies = {
  listPending(limit: number): Promise<PendingDispatch[]>
  dispatch(input: PendingDispatch): Promise<DispatchResult>
  enqueue(tenantId: string, runId: string): Promise<{ enqueued: boolean }>
}

export type IntakeSourceAgentDispatchOptions = { enabled?: boolean }

export type IntakeSourceAgentDispatchReconcileResult = {
  discovered: number
  completed: number
  held: number
  cancelled: number
  enqueued: number
  failed: number
}

const dependencies: IntakeSourceAgentDispatchDependencies = {
  listPending: (limit) =>
    withTenantIsolationBypass(() => listPendingIntakeSourceAgentDispatches({ limit })),
  dispatch: (input) => dispatchIntakeSourceAgentTask(input),
  enqueue: (tenantId, runId) =>
    enqueueAgentRun({ tenantId, runId }, { enabled: env.AGENT_RUNNER_ENABLED }),
}

export async function reconcileIntakeSourceAgentDispatches(
  injected: IntakeSourceAgentDispatchDependencies = dependencies,
  options: IntakeSourceAgentDispatchOptions = {},
): Promise<IntakeSourceAgentDispatchReconcileResult> {
  const counts: IntakeSourceAgentDispatchReconcileResult = {
    discovered: 0,
    completed: 0,
    held: 0,
    cancelled: 0,
    enqueued: 0,
    failed: 0,
  }
  if (!(options.enabled ?? isFeatureEnabled('intakeV1FileExtractionWorker'))) return counts

  const pending = await injected.listPending(25)
  counts.discovered = pending.length
  for (const candidate of pending) {
    try {
      const result = await injected.dispatch({
        id: candidate.id,
        tenantId: candidate.tenantId,
        venueId: candidate.venueId,
      })
      if (result.status === 'HELD') {
        counts.held += 1
        continue
      }
      if (result.status === 'CANCELLED') {
        counts.cancelled += 1
        continue
      }
      if (!result.runId)
        throw new Error('Completed source dispatch did not return an agent run ID.')

      counts.completed += 1
      const publication = await injected.enqueue(candidate.tenantId, result.runId)
      if (publication.enqueued) counts.enqueued += 1
    } catch {
      // A completed dispatch and its queued SYSTEM AgentRun remain durable.
      // This same sweep republishes them after the database retry delay.
      counts.failed += 1
    }
  }
  return counts
}
