import { env, logger } from '@pathfinder/config'
import { dispatchDueAgentRoutinesAction, updateJobRecord, writeJobRecord } from '@pathfinder/db'
import {
  AGENT_ROUTINE_DISPATCH_SCHEDULER_JOB,
  AGENT_ROUTINE_MAINTENANCE_QUEUE,
} from '@pathfinder/jobs'

import {
  normalizeJobExecutionMetadata,
  recordJobFailure,
  toQueueSafeJobError,
  type JobExecutionInput,
} from '../lib/job-execution'

/**
 * Materializes due routine slots from the durable database. The scheduler is
 * default-dark in the worker entrypoint; this processor never enables it,
 * reaches a provider, or enqueues the managed AgentRun worker. A connected
 * bridge with the recorded roles/capabilities claims the queued AgentRun.
 *
 * Every due routine is checked before anything is created: reminder stop rules
 * (a reply or resolution, suppression, offboarding, churn, a count or end date)
 * stop the routine with the reason recorded, and a run that would exceed the
 * routine's dollar budget is refused as BUDGET_EXCEEDED. The decisions live in
 * `@pathfinder/db`; this processor only runs the batch and reports the outcome.
 */
export async function processAgentRoutineDispatch(executionInput?: JobExecutionInput) {
  if (!env.AGENT_ROUTINES_ENABLED || !env.WORKER_SCHEDULERS_ENABLED) {
    throw new Error(
      'Agent routine dispatch is disabled unless AGENT_ROUTINES_ENABLED and WORKER_SCHEDULERS_ENABLED are true',
    )
  }
  const execution = normalizeJobExecutionMetadata(executionInput)
  const jobRecordId = await writeJobRecord({
    queue: AGENT_ROUTINE_MAINTENANCE_QUEUE,
    jobName: AGENT_ROUTINE_DISPATCH_SCHEDULER_JOB,
    bullJobId: execution.bullJobId ?? null,
    tenantId: null,
    status: 'RUNNING',
    payload: {},
    startedAt: new Date(),
    attemptNumber: execution.attemptNumber,
    maxAttempts: execution.maxAttempts,
  })
  try {
    const outcomes = await dispatchDueAgentRoutinesAction()
    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
    logger.info({
      action: 'workers.agent-routine-dispatch.completed',
      examined: outcomes.length,
      dispatched: outcomes.filter((outcome) => outcome.status === 'DISPATCHED').length,
      stopped: outcomes.filter((outcome) => outcome.status === 'STOPPED').length,
      budgetRefused: outcomes.filter(
        (outcome) => outcome.status === 'SKIPPED' && outcome.reason === 'BUDGET_EXCEEDED',
      ).length,
      delivery: 'bridge-only',
    })
    return { outcomes }
  } catch (error) {
    await recordJobFailure({ jobRecordId, error, execution })
    logger.error({
      action: 'workers.agent-routine-dispatch.failed',
      attemptNumber: execution.attemptNumber,
      maxAttempts: execution.maxAttempts,
      error: 'Agent routine dispatch run failed.',
    })
    throw toQueueSafeJobError(error, 'AGENT_ROUTINE_DISPATCH_FAILED')
  }
}
