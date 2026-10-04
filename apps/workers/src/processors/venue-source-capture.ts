import {
  captureVenueSource,
  VENUE_SOURCE_LIMITS,
  type VenueSourceCapture,
  type VenueSourceDependencies,
} from '@pathfinder/api/venue-source-capture'
import { createWebsiteIntakeRuntimeDependencies } from '@pathfinder/api/website-intake-runtime'
import { logger } from '@pathfinder/config'
import {
  claimVenueSourceForCaptureAction,
  completeVenueSourceCaptureAction,
  failVenueSourceAction,
  readAuthorizedSourceHostsAction,
  releaseVenueSourceClaimAction,
  updateJobRecord,
  VENUE_SOURCE_MAX_ATTEMPTS,
  writeJobRecord,
} from '@pathfinder/db'
import {
  INTAKE_V1_SOURCE_PROCESSING_QUEUE,
  VENUE_SOURCE_CAPTURE_PROCESS_JOB,
  type VenueSourceCaptureJobPayload,
} from '@pathfinder/jobs'
import { z } from 'zod'

import {
  normalizeJobExecutionMetadata,
  recordJobFailure,
  toQueueSafeJobError,
  type JobExecutionInput,
} from '../lib/job-execution'

const payloadSchema = z
  .object({
    tenantId: z.string().regex(/^[A-Za-z0-9_-]{1,191}$/u),
    venueId: z.string().regex(/^[A-Za-z0-9_-]{1,191}$/u),
    sourceId: z.string().regex(/^[A-Za-z0-9_-]{1,191}$/u),
  })
  .strict()

export const VENUE_SOURCE_CAPTURE_USER_AGENT = 'TorchikoSourceCapture/1.0 (+https://torchiko.com)'

type ClaimedSource = NonNullable<Awaited<ReturnType<typeof claimVenueSourceForCaptureAction>>>

export type VenueSourceCaptureProcessorDependencies = {
  claim(scope: VenueSourceCaptureJobPayload): Promise<ClaimedSource | null>
  authorizedHosts(scope: { tenantId: string; venueId: string }): Promise<string[]>
  capture(input: {
    startUrl: string
    authorizedHosts: string[]
    maxPages: number
    maxBytesPerPage: number
  }): Promise<VenueSourceCapture>
  complete(
    scope: VenueSourceCaptureJobPayload,
    capture: VenueSourceCapture,
  ): Promise<{ written: boolean }>
  release(scope: VenueSourceCaptureJobPayload): Promise<void>
  fail(scope: VenueSourceCaptureJobPayload, errorCode: string): Promise<void>
}

// Every query below carries tenant_id and venue_id from the job's scope, so the tenant isolation
// middleware is satisfied without a bypass: the worker never lists sources across tenants.
const defaults: VenueSourceCaptureProcessorDependencies = {
  claim: (scope) => claimVenueSourceForCaptureAction(scope),
  authorizedHosts: (scope) => readAuthorizedSourceHostsAction(scope),
  capture: (input) =>
    captureVenueSource(
      { ...input, userAgent: VENUE_SOURCE_CAPTURE_USER_AGENT },
      createWebsiteIntakeRuntimeDependencies({
        userAgent: VENUE_SOURCE_CAPTURE_USER_AGENT,
      }) as VenueSourceDependencies,
    ),
  complete: (scope, capture) =>
    completeVenueSourceCaptureAction({
      ...scope,
      status: capture.status,
      errorCode: capture.errorCode,
      inputs: capture.inputs,
    }),
  release: (scope) => releaseVenueSourceClaimAction(scope),
  fail: (scope, errorCode) => failVenueSourceAction({ ...scope, errorCode }),
}

export type VenueSourceCaptureOutcome = 'captured' | 'not-claimed' | 'no-authorized-hosts'

/**
 * Captures one requested source. It reloads the source, re-reads the venue's authorized hosts
 * (a revoked origin stops a queued capture), fetches within the stored bounds, and writes the
 * frozen inputs and the terminal status in one transaction. Retrying is safe: a finished or
 * claimed source is a no-op, and a failed attempt gives its claim back until attempts run out.
 */
export async function processVenueSourceCaptureJob(
  rawPayload: VenueSourceCaptureJobPayload,
  executionInput?: JobExecutionInput,
  dependencies: VenueSourceCaptureProcessorDependencies = defaults,
): Promise<VenueSourceCaptureOutcome> {
  const scope = payloadSchema.parse(rawPayload)
  const execution = normalizeJobExecutionMetadata(executionInput)
  const jobRecordId = await writeJobRecord({
    queue: INTAKE_V1_SOURCE_PROCESSING_QUEUE,
    jobName: VENUE_SOURCE_CAPTURE_PROCESS_JOB,
    bullJobId: execution.bullJobId ?? null,
    tenantId: scope.tenantId,
    status: 'RUNNING',
    payload: { venueId: scope.venueId, sourceId: scope.sourceId },
    startedAt: new Date(),
    attemptNumber: execution.attemptNumber,
    maxAttempts: execution.maxAttempts,
  })
  let claimed = false
  try {
    const source = await dependencies.claim(scope)
    if (!source) {
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      return 'not-claimed'
    }
    claimed = true
    const authorizedHosts = await dependencies.authorizedHosts(scope)
    if (!authorizedHosts.includes(source.host)) {
      // The venue revoked the origin after the request: capture nothing and say why.
      await dependencies.complete(scope, {
        status: 'FAILED',
        errorCode: 'HOST_NOT_AUTHORIZED',
        inputs: [],
      })
      claimed = false
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      return 'no-authorized-hosts'
    }
    const capture = await dependencies.capture({
      startUrl: source.requestUrl,
      authorizedHosts,
      maxPages: Math.min(source.maxPages, VENUE_SOURCE_LIMITS.maxPagesCeiling),
      maxBytesPerPage: Math.min(source.maxBytesPerPage, VENUE_SOURCE_LIMITS.maxBytesPerPageCeiling),
    })
    await dependencies.complete(scope, capture)
    claimed = false
    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
    logger.info({
      action: 'workers.venue-source-capture.completed',
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      sourceId: scope.sourceId,
      status: capture.status,
      inputs: capture.inputs.length,
    })
    return 'captured'
  } catch (error) {
    await recordJobFailure({ jobRecordId, error, execution })
    if (claimed) {
      try {
        if (execution.attemptNumber >= Math.min(execution.maxAttempts, VENUE_SOURCE_MAX_ATTEMPTS)) {
          await dependencies.fail(scope, 'CAPTURE_FAILED')
        } else {
          await dependencies.release(scope)
        }
      } catch {
        // The stale-claim takeover recovers a source whose claim could not be released.
      }
    }
    logger.error({
      action: 'workers.venue-source-capture.failed',
      tenantId: scope.tenantId,
      sourceId: scope.sourceId,
      attemptNumber: execution.attemptNumber,
      maxAttempts: execution.maxAttempts,
      error: 'Venue source capture failed.',
    })
    throw toQueueSafeJobError(error, 'VENUE_SOURCE_CAPTURE_FAILED')
  }
}
