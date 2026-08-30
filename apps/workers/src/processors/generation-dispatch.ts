import { logger } from '@pathfinder/config'
import {
  adoptLegacyNullLeaseGenerationDispatches,
  deferGenerationRequestDispatch,
  failGenerationRequestDispatch,
  leaseGenerationRequestDispatches,
  settleProgressedGenerationRequestDispatch,
  type ExactGenerationRequestDispatch,
  type LeasedGenerationRequestDispatch,
} from '@pathfinder/db'
import { enqueueAnswerAnalysisDispatch, enqueueWeeklyReportDispatch } from '@pathfinder/jobs'

const SAFE_DISPATCH_ERROR = 'Generation dispatch attempt failed.'

export type GenerationDispatchResult = {
  adopted: number
  leased: number
  progressed: number
  enqueueRequestsAccepted: number
  deferred: number
  failed: number
  superseded: number
}

function exactDispatch(
  dispatch: LeasedGenerationRequestDispatch,
  leaseToken: string,
): ExactGenerationRequestDispatch {
  return {
    id: dispatch.id,
    tenantId: dispatch.tenantId,
    venueId: dispatch.venueId,
    kind: dispatch.kind,
    recordId: dispatch.recordId,
    leaseToken,
  }
}

async function enqueueDispatch(dispatch: LeasedGenerationRequestDispatch): Promise<void> {
  if (dispatch.kind === 'ANSWER_ANALYSIS') {
    if (
      dispatch.answerAnalysisSnapshotId !== dispatch.recordId ||
      dispatch.weeklyReportId !== null
    ) {
      throw new Error('Answer-analysis generation dispatch target did not match.')
    }

    await enqueueAnswerAnalysisDispatch(
      {
        tenantId: dispatch.tenantId,
        venueId: dispatch.venueId,
        snapshotId: dispatch.recordId,
        rangeStart: dispatch.rangeStart.toISOString(),
        rangeEnd: dispatch.rangeEnd.toISOString(),
      },
      dispatch.id,
    )
    return
  }

  if (dispatch.weeklyReportId !== dispatch.recordId || dispatch.answerAnalysisSnapshotId !== null) {
    throw new Error('Weekly-report generation dispatch target did not match.')
  }

  await enqueueWeeklyReportDispatch(
    {
      tenantId: dispatch.tenantId,
      venueId: dispatch.venueId,
      reportId: dispatch.recordId,
      weekStart: dispatch.rangeStart.toISOString(),
      weekEnd: dispatch.rangeEnd.toISOString(),
    },
    dispatch.id,
  )
}

export async function processGenerationDispatches(): Promise<GenerationDispatchResult> {
  const adoptedLegacy = await adoptLegacyNullLeaseGenerationDispatches()
  const adopted = adoptedLegacy.answerAnalysis + adoptedLegacy.weeklyReports
  const { dispatches, leaseToken } = await leaseGenerationRequestDispatches()
  const result: GenerationDispatchResult = {
    adopted,
    leased: dispatches.length,
    progressed: 0,
    enqueueRequestsAccepted: 0,
    deferred: 0,
    failed: 0,
    superseded: 0,
  }
  let failurePersistenceErrors = 0

  for (const dispatch of dispatches) {
    const exact = exactDispatch(dispatch, leaseToken)

    try {
      if (await settleProgressedGenerationRequestDispatch(exact)) {
        result.progressed += 1
        continue
      }

      await enqueueDispatch(dispatch)
      result.enqueueRequestsAccepted += 1

      if (await deferGenerationRequestDispatch(exact)) result.deferred += 1
      else result.superseded += 1
    } catch {
      result.failed += 1
      try {
        const retained = await failGenerationRequestDispatch(exact)
        if (!retained) result.superseded += 1
      } catch {
        failurePersistenceErrors += 1
        logger.error({
          action: 'workers.generation-dispatch.failure-persistence-failed',
          generationType: dispatch.kind,
          tenantId: dispatch.tenantId,
          venueId: dispatch.venueId,
          recordId: dispatch.recordId,
          reason: 'dispatch-failure-persistence-failed',
          error: 'Generation dispatch failure could not be recorded.',
        })
      }

      logger.error({
        action: 'workers.generation-dispatch.item-failed',
        generationType: dispatch.kind,
        tenantId: dispatch.tenantId,
        venueId: dispatch.venueId,
        recordId: dispatch.recordId,
        reason: 'generation-dispatch-failed',
        error: SAFE_DISPATCH_ERROR,
      })
    }
  }

  if (failurePersistenceErrors > 0) {
    logger.error({
      action: 'workers.generation-dispatch.failed',
      reason: 'dispatch-failure-persistence-failed',
      error: 'Generation dispatch failure state could not be persisted.',
      failurePersistenceErrors,
    })
    throw new Error('Generation dispatch failure state could not be persisted.')
  }

  logger.info({ action: 'workers.generation-dispatch.completed', ...result })
  return result
}
