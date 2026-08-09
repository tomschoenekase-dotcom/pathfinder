import { DelayedError, type Job } from 'bullmq'

import { logger } from '@pathfinder/config'
import {
  assertGlobalAiAvailable,
  GlobalAiAdmissionError,
  isAiAdmissionControlError,
} from '@pathfinder/db'

export const GLOBAL_AI_RECHECK_DELAY_MS = 60_000

export async function globalAiAdmissionAvailable(): Promise<boolean> {
  try {
    await assertGlobalAiAvailable()
    return true
  } catch (error) {
    logger.warn({
      action: 'workers.global-ai.admission-denied',
      cause: error instanceof GlobalAiAdmissionError ? error.code : 'control-unavailable',
    })
    return false
  }
}

export async function delayJobForGlobalAiPause(
  job: Pick<Job, 'moveToDelayed'>,
  token: string | undefined,
  now: number = Date.now(),
): Promise<never> {
  if (!token) throw new Error('BullMQ lock token is required to defer a paused AI job')
  await job.moveToDelayed(now + GLOBAL_AI_RECHECK_DELAY_MS, token)
  throw new DelayedError()
}

export async function runAiJobWithIncidentControl(
  job: Pick<Job, 'moveToDelayed'>,
  token: string | undefined,
  operation: () => Promise<void>,
): Promise<void> {
  if (!(await globalAiAdmissionAvailable())) await delayJobForGlobalAiPause(job, token)
  try {
    await operation()
  } catch (error) {
    if (isAiAdmissionControlError(error)) {
      await delayJobForGlobalAiPause(job, token)
    }
    throw error
  }
}
