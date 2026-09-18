import { env, logger } from '@pathfinder/config'
import { dispatchDueAgentRoutinesAction } from '@pathfinder/db'

/**
 * Materializes due routine slots from the durable database. The scheduler is
 * default-dark in the worker entrypoint; this processor never enables it,
 * reaches a provider, or enqueues the managed AgentRun worker. A connected
 * bridge with the recorded roles/capabilities claims the queued AgentRun.
 */
export async function processAgentRoutineDispatch() {
  if (!env.AGENT_ROUTINES_ENABLED || !env.WORKER_SCHEDULERS_ENABLED) {
    throw new Error(
      'Agent routine dispatch is disabled unless AGENT_ROUTINES_ENABLED and WORKER_SCHEDULERS_ENABLED are true',
    )
  }
  const outcomes = await dispatchDueAgentRoutinesAction()
  logger.info({
    action: 'workers.agent-routine-dispatch.completed',
    examined: outcomes.length,
    dispatched: outcomes.filter((outcome) => outcome.status === 'DISPATCHED').length,
    delivery: 'bridge-only',
  })
  return { outcomes }
}
