import { logger } from '@pathfinder/config'
import {
  LIVE_DATA_LIMITS,
  evaluateLiveDataState,
  liveDataBackoffSeconds,
  liveDataMappingSchema,
  normalizeLiveDataPayload,
  parseLiveDataHostAllowlist,
  selectLiveDataPollBatch,
  type LiveDataErrorCategory,
  type LiveDataKind,
} from '@pathfinder/contracts/live-data'
import {
  claimLiveDataPoll,
  listDueLiveDataConnectors,
  loadLiveDataConnectorForPoll,
  recordLiveDataPollFailure,
  recordLiveDataPollSuccess,
  recordLiveDataTestResult,
  updateJobRecord,
  writeJobRecord,
} from '@pathfinder/db'
import {
  LIVE_DATA_POLL_PROCESS_JOB,
  LIVE_DATA_POLL_QUEUE,
  LIVE_DATA_POLL_SCHEDULER_JOB,
  enqueueLiveDataPoll,
  type LiveDataPollJobPayload,
} from '@pathfinder/jobs'
import { SOURCE_CONNECTION_PROVIDER } from '@pathfinder/contracts/source-connections'

import {
  normalizeJobExecutionMetadata,
  recordJobFailure,
  toQueueSafeJobError,
  type JobExecutionInput,
} from '../lib/job-execution'
import {
  fetchLiveDataJson,
  type LiveDataFetchDependencies,
  type LiveDataFetchOutcome,
} from '../lib/live-data-fetch'
import { processSourceConnectionPoll } from './source-connection-poll'

const ID = /^[A-Za-z0-9_-]{1,191}$/u
const MAX_FETCH_ATTEMPTS = 2
const RETRY_DELAY_MS = 500

export type LiveDataPollDependencies = {
  now?: () => Date
  fetchJson?: (url: string) => Promise<LiveDataFetchOutcome>
  sleep?: (milliseconds: number) => Promise<void>
}

const KIND_BY_ENUM: Record<string, LiveDataKind> = {
  SPORTS_SCORE: 'sports_score',
  RIDE_STATUS: 'ride_status',
  GENERIC_JSON: 'generic_json',
}

function defaultFetchDependencies(): LiveDataFetchDependencies {
  return {
    allowlist: parseLiveDataHostAllowlist(process.env.LIVE_DATA_ALLOWED_HOSTS),
    production: process.env.NODE_ENV === 'production',
  }
}

function parsePayload(payload: LiveDataPollJobPayload): LiveDataPollJobPayload {
  if (
    !ID.test(payload.tenantId) ||
    !ID.test(payload.venueId) ||
    !ID.test(payload.connectorId) ||
    (payload.mode !== 'scheduled' && payload.mode !== 'test' && payload.mode !== 'manual')
  ) {
    throw new Error('Live data poll payload is invalid.')
  }
  return payload
}

/**
 * Scheduler tick: discovers a bounded, rate-limited set of due connectors and enqueues one poll
 * job each. It never calls a provider itself.
 */
export async function processLiveDataPollScheduler(
  executionInput?: JobExecutionInput,
  dependencies: { now?: () => Date } = {},
) {
  const execution = normalizeJobExecutionMetadata(executionInput)
  const now = dependencies.now?.() ?? new Date()
  const jobRecordId = await writeJobRecord({
    queue: LIVE_DATA_POLL_QUEUE,
    jobName: LIVE_DATA_POLL_SCHEDULER_JOB,
    bullJobId: execution.bullJobId ?? null,
    tenantId: null,
    status: 'RUNNING',
    payload: {},
    startedAt: now,
    attemptNumber: execution.attemptNumber,
    maxAttempts: execution.maxAttempts,
  })
  try {
    const due = await listDueLiveDataConnectors({
      now,
      limit: LIVE_DATA_LIMITS.maxDuePerTick * 4,
    })
    const batch = selectLiveDataPollBatch(due)
    for (const connector of batch) {
      await enqueueLiveDataPoll(
        {
          tenantId: connector.tenantId,
          venueId: connector.venueId,
          connectorId: connector.id,
          mode: 'scheduled',
        },
        now,
      )
    }
    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
    return { dueCount: due.length, enqueuedCount: batch.length }
  } catch (error) {
    await recordJobFailure({ jobRecordId, error, execution })
    logger.error({
      action: 'workers.live-data-poll.scheduler-failed',
      error: 'Live data scheduler failed.',
    })
    throw toQueueSafeJobError(error, 'LIVE_DATA_SCHEDULER_FAILED')
  }
}

async function fetchWithBoundedRetry(
  url: string,
  fetchJson: (url: string) => Promise<LiveDataFetchOutcome>,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<LiveDataFetchOutcome> {
  let outcome: LiveDataFetchOutcome = { ok: false, errorCategory: 'network_error', retryable: true }
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    outcome = await fetchJson(url)
    if (outcome.ok || !outcome.retryable || attempt === MAX_FETCH_ATTEMPTS) return outcome
    await sleep(RETRY_DELAY_MS * attempt)
  }
  return outcome
}

export async function processLiveDataPoll(
  rawPayload: LiveDataPollJobPayload,
  executionInput?: JobExecutionInput,
  dependencies: LiveDataPollDependencies = {},
) {
  const execution = normalizeJobExecutionMetadata(executionInput)
  const startedAt = dependencies.now?.() ?? new Date()
  const jobRecordId = await writeJobRecord({
    queue: LIVE_DATA_POLL_QUEUE,
    jobName: LIVE_DATA_POLL_PROCESS_JOB,
    bullJobId: execution.bullJobId ?? null,
    tenantId: ID.test(rawPayload.tenantId) ? rawPayload.tenantId : null,
    status: 'RUNNING',
    payload: {
      venueId: rawPayload.venueId,
      connectorId: rawPayload.connectorId,
      mode: rawPayload.mode,
    },
    startedAt,
    attemptNumber: execution.attemptNumber,
    maxAttempts: execution.maxAttempts,
  })

  try {
    const payload = parsePayload(rawPayload)
    const scope = {
      tenantId: payload.tenantId,
      venueId: payload.venueId,
      connectorId: payload.connectorId,
    }
    const connector = await loadLiveDataConnectorForPoll(scope)
    if (!connector) {
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      return { outcome: 'connector-not-found' as const }
    }
    if (connector.provider === SOURCE_CONNECTION_PROVIDER) {
      const result = await processSourceConnectionPoll(payload, connector, dependencies)
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      return result
    }
    if (payload.mode === 'manual') {
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      return { outcome: 'manual-unsupported' as const }
    }
    // A disabled connector never reaches the network on the scheduled path.
    if (payload.mode === 'scheduled') {
      if (connector.state !== 'ACTIVE') {
        await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
        return { outcome: 'disabled' as const }
      }
      const claimed = await claimLiveDataPoll({
        ...scope,
        now: startedAt,
        nextPollAt: new Date(startedAt.getTime() + connector.pollIntervalSeconds * 1000),
      })
      if (!claimed) {
        await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
        return { outcome: 'not-due' as const }
      }
    }

    const kind = KIND_BY_ENUM[connector.kind] ?? 'generic_json'
    const fetchDependencies = defaultFetchDependencies()
    const fetchJson =
      dependencies.fetchJson ?? ((url: string) => fetchLiveDataJson(url, fetchDependencies))
    const sleep =
      dependencies.sleep ??
      ((milliseconds: number) => new Promise((r) => setTimeout(r, milliseconds)))
    const fetched = await fetchWithBoundedRetry(connector.endpointUrl, fetchJson, sleep)
    const fetchedAt = dependencies.now?.() ?? new Date()

    let errorCategory: LiveDataErrorCategory | null = null
    let normalized: ReturnType<typeof normalizeLiveDataPayload> | null = null
    if (!fetched.ok) {
      errorCategory = fetched.errorCategory
    } else {
      const mapping = liveDataMappingSchema.safeParse(connector.mapping)
      if (!mapping.success) {
        errorCategory = 'schema_invalid'
      } else {
        normalized = normalizeLiveDataPayload({
          kind,
          mapping: mapping.data,
          payload: fetched.payload,
          fetchedAt,
        })
        if (!normalized.ok) errorCategory = normalized.errorCategory
      }
    }

    if (payload.mode === 'test') {
      const observation = normalized?.ok ? normalized.observation : null
      await recordLiveDataTestResult({
        ...scope,
        now: fetchedAt,
        outcome: errorCategory ? 'FAILED' : 'OK',
        errorCategory,
        preview: observation
          ? {
              values: observation.values,
              observedAt: observation.observedAt,
              timestampBasis: observation.timestampBasis,
              conflicts: observation.conflicts,
              state: evaluateLiveDataState({
                hasObservation: true,
                timestampBasis: observation.timestampBasis,
                observedAt: observation.observedAt ? new Date(observation.observedAt) : null,
                fetchedAt,
                freshnessBudgetSeconds: connector.freshnessBudgetSeconds,
                connectorFailing: false,
                now: fetchedAt,
              }),
            }
          : null,
      })
    } else if (normalized?.ok) {
      const stored = await recordLiveDataPollSuccess({
        ...scope,
        now: fetchedAt,
        nextPollAt: new Date(fetchedAt.getTime() + connector.pollIntervalSeconds * 1000),
        observation: {
          values: normalized.observation.values,
          observedAt: normalized.observation.observedAt
            ? new Date(normalized.observation.observedAt)
            : null,
          timestampBasis: normalized.observation.timestampBasis,
          conflicts: normalized.observation.conflicts,
        },
      })
      if (!stored) {
        await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
        return { outcome: 'disabled-during-fetch' as const }
      }
    } else {
      await recordLiveDataPollFailure({
        ...scope,
        now: fetchedAt,
        errorCategory: errorCategory ?? 'network_error',
        nextPollAt: new Date(
          fetchedAt.getTime() +
            liveDataBackoffSeconds(
              connector.pollIntervalSeconds,
              connector.consecutiveFailures + 1,
            ) *
              1000,
        ),
      })
    }

    // Structured, identifier-only log: never the endpoint, payload, or provider text.
    logger.info({
      action: 'workers.live-data-poll.completed',
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      connectorId: scope.connectorId,
      mode: payload.mode,
      outcome: errorCategory ? 'failed' : 'ok',
      ...(errorCategory ? { errorCategory } : {}),
    })
    // A provider outage is an expected, recorded connector state, not a worker failure; the
    // connector row carries the error category and its own backoff schedule.
    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
    return errorCategory
      ? ({ outcome: 'failed' as const, errorCategory } as const)
      : ({ outcome: 'ok' as const } as const)
  } catch (error) {
    await recordJobFailure({ jobRecordId, error, execution })
    logger.error({
      action: 'workers.live-data-poll.failed',
      attemptNumber: execution.attemptNumber,
      maxAttempts: execution.maxAttempts,
      error: 'Live data poll failed.',
    })
    throw toQueueSafeJobError(error, 'LIVE_DATA_POLL_FAILED')
  }
}
