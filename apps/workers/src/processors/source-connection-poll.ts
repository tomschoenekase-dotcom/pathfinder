import {
  SourceConnectionConfigSchema,
  SourceConnectionSnapshotSchema,
} from '@pathfinder/contracts/source-connections'
import {
  sourceConnectionConfigHash,
  sourceConnectionSnapshotHash,
} from '@pathfinder/contracts/source-connections-node'
import {
  claimSourceConnectionPollSlot,
  claimSourceConnectionRequest,
  db,
  publishSourceConnectionSnapshot,
  recordSourceConnectionPollFailure,
  recordSourceConnectionBytes,
  recordSourceConnectionDiagnostic,
  recordSourceConnectionCache,
  recordSourceConnectionPreviewAction,
  SourceConnectionActionError,
  validateSourceConnectionConfig,
} from '@pathfinder/db'
import type { LiveDataPollJobPayload } from '@pathfinder/jobs'

import { extractSourceConnection } from '../lib/source-connection-extract'
import {
  fetchSourceConnection,
  type SourceConnectionFetchDependencies,
  type SourceConnectionFetchOutcome,
} from '../lib/source-connection-fetch'

type Connector = NonNullable<
  Awaited<ReturnType<typeof import('@pathfinder/db').loadLiveDataConnectorForPoll>>
>

export type SourceConnectionPollDependencies = {
  now?: () => Date
  fetch?: (
    config: ReturnType<typeof SourceConnectionConfigSchema.parse>,
    validators: { etag?: string; lastModified?: string },
    deps: SourceConnectionFetchDependencies,
  ) => Promise<SourceConnectionFetchOutcome>
}

type SourceCost = { fetches: number; bytes: number }

function isValidationRefusal(error: unknown): boolean {
  return error instanceof SourceConnectionActionError && error.code === 'INVALID_INPUT'
}

function readCache(
  raw: unknown,
  configHash: string,
  contentHash: string,
): { etag?: string; lastModified?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const cache = (raw as Record<string, unknown>).cache
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return {}
  const values = cache as Record<string, unknown>
  if (values.configHash !== configHash || values.contentHash !== contentHash) return {}
  return {
    ...(typeof values.etag === 'string' ? { etag: values.etag } : {}),
    ...(typeof values.lastModified === 'string' ? { lastModified: values.lastModified } : {}),
  }
}

export async function processSourceConnectionPoll(
  payload: LiveDataPollJobPayload,
  connector: Connector,
  dependencies: SourceConnectionPollDependencies = {},
): Promise<{ outcome: string; errorCategory?: string }> {
  const scope = {
    tenantId: payload.tenantId,
    venueId: payload.venueId,
    connectorId: payload.connectorId,
  }
  const now = dependencies.now?.() ?? new Date()
  const parsed = SourceConnectionConfigSchema.safeParse(connector.mapping)
  if (!parsed.success || connector.endpointUrl !== parsed.data.sourceUrl) {
    // No trustworthy config hash exists, so only the connector-level diagnostic is possible.
    await recordSourceConnectionDiagnostic({
      ...scope,
      now,
      errorCategory: 'invalid_config',
      preview: payload.mode === 'test',
      nextPollAt: new Date(now.getTime() + Math.max(connector.pollIntervalSeconds, 60) * 1000),
    })
    return { outcome: 'invalid-config', errorCategory: 'invalid_config' }
  }
  const config = parsed.data
  const configHash = sourceConnectionConfigHash(config)
  const retryAt = (from: Date) => new Date(from.getTime() + config.refreshIntervalSeconds * 1000)
  // Records a hash-fenced diagnostic; falls back to the connector-level one when the fence
  // refuses it (for example the connector is not ACTIVE or the config changed).
  const recordEarlyFailure = async (errorCategory: string, at: Date, cost?: SourceCost) => {
    if (payload.mode === 'test') {
      try {
        await recordSourceConnectionPreviewAction({
          ...scope,
          expectedConfigHash: configHash,
          now: at,
          preview: {
            configHash,
            contentHash: sourceConnectionSnapshotHash([]),
            status: 'REVIEW_REQUIRED',
            records: [],
            issues: [errorCategory],
            observedAt: at.toISOString(),
            cost: cost ?? { fetches: 0, bytes: 0 },
          },
        })
        return
      } catch {
        await recordSourceConnectionDiagnostic({ ...scope, now: at, errorCategory, preview: true })
        return
      }
    }
    const recorded = await recordSourceConnectionPollFailure({
      ...scope,
      expectedConfigHash: configHash,
      now: at,
      nextPollAt: retryAt(at),
      errorCategory,
    })
    if (!recorded)
      await recordSourceConnectionDiagnostic({
        ...scope,
        now: at,
        errorCategory,
        nextPollAt: retryAt(at),
      })
  }
  try {
    await validateSourceConnectionConfig({
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      config,
    })
  } catch (error) {
    // Only a validation refusal means the origin is no longer authorised. Anything else
    // (database outage, bug) must not be reported as a revoked origin.
    if (isValidationRefusal(error)) {
      await recordEarlyFailure('origin_invalid', now)
      return { outcome: 'unauthorized-origin', errorCategory: 'origin_invalid' }
    }
    await recordSourceConnectionDiagnostic({
      ...scope,
      now,
      errorCategory: 'internal_error',
      preview: payload.mode === 'test',
      nextPollAt: retryAt(now),
    }).catch(() => false)
    throw error
  }
  if (payload.mode !== 'test') {
    if (
      connector.state !== 'ACTIVE' ||
      !config.approval ||
      config.approval.approvedConfigHash !== configHash
    )
      return { outcome: 'not-approved' }
    const claimed = await claimSourceConnectionPollSlot({
      ...scope,
      mode: payload.mode,
      expectedConfigHash: configHash,
      now,
    })
    if (!claimed) return { outcome: 'not-due' }
  }
  const prior = await db.liveDataObservation.findFirst({
    where: { connectorId: scope.connectorId, tenantId: scope.tenantId, venueId: scope.venueId },
    select: { values: true },
  })
  const previous = SourceConnectionSnapshotSchema.safeParse(prior?.values)
  const hasPublishedCache =
    previous.success &&
    previous.data.configHash === configHash &&
    previous.data.sourceUrl === config.sourceUrl &&
    sourceConnectionSnapshotHash(previous.data.records) === previous.data.contentHash
  // Preview validators alone cannot service a 304: the first publication needs the full body.
  const cache =
    payload.mode === 'test' || !hasPublishedCache
      ? {}
      : readCache(connector.lastTestPreview, configHash, previous.data.contentHash)
  const fetched = await (dependencies.fetch ?? fetchSourceConnection)(config, cache, {
    beforeRequest: () =>
      claimSourceConnectionRequest({
        ...scope,
        expectedConfigHash: configHash,
        previewOnly: payload.mode === 'test',
        now: dependencies.now?.() ?? new Date(),
      }),
  })
  const completedAt = dependencies.now?.() ?? new Date()
  await recordSourceConnectionBytes({ ...scope, bytes: fetched.bytesTransferred, now: completedAt })
  if (fetched.status === 'failed') {
    if (payload.mode === 'test') {
      await recordSourceConnectionPreviewAction({
        ...scope,
        expectedConfigHash: configHash,
        now: completedAt,
        preview: {
          configHash,
          contentHash: sourceConnectionSnapshotHash([]),
          status: 'REVIEW_REQUIRED',
          records: [],
          issues: [fetched.errorCategory],
          observedAt: completedAt.toISOString(),
          cost: { fetches: fetched.requestCount, bytes: fetched.bytesTransferred },
        },
      })
    } else {
      await recordSourceConnectionPollFailure({
        ...scope,
        expectedConfigHash: configHash,
        now: completedAt,
        nextPollAt: new Date(completedAt.getTime() + config.refreshIntervalSeconds * 1000),
        errorCategory: fetched.errorCategory.slice(0, 32),
      })
    }
    return { outcome: 'failed', errorCategory: fetched.errorCategory }
  }
  if (fetched.finalUrl !== config.sourceUrl && !config.allowedUrls.includes(fetched.finalUrl)) {
    // The final URL is deliberately not stored; the category alone says it left the approved list.
    await recordEarlyFailure('redirect_forbidden', completedAt, {
      fetches: fetched.requestCount,
      bytes: fetched.bytesTransferred,
    })
    return { outcome: 'forbidden-redirect', errorCategory: 'redirect_forbidden' }
  }
  const saveCache = (contentHash: string) =>
    recordSourceConnectionCache({
      ...scope,
      expectedConfigHash: configHash,
      contentHash,
      ...(fetched.etag ? { etag: fetched.etag } : {}),
      ...(fetched.lastModified ? { lastModified: fetched.lastModified } : {}),
    })
  if (fetched.status === 'not_modified') {
    if (
      payload.mode === 'test' ||
      !previous.success ||
      previous.data.configHash !== configHash ||
      previous.data.sourceUrl !== config.sourceUrl
    ) {
      if (payload.mode !== 'test')
        await recordSourceConnectionPollFailure({
          ...scope,
          expectedConfigHash: configHash,
          now: completedAt,
          nextPollAt: new Date(completedAt.getTime() + config.refreshIntervalSeconds * 1000),
          errorCategory: 'cache_invalid',
        })
      else
        await recordSourceConnectionPreviewAction({
          ...scope,
          expectedConfigHash: configHash,
          now: completedAt,
          preview: {
            configHash,
            contentHash: sourceConnectionSnapshotHash([]),
            status: 'REVIEW_REQUIRED',
            records: [],
            issues: ['cache_invalid'],
            observedAt: completedAt.toISOString(),
            cost: { fetches: fetched.requestCount, bytes: fetched.bytesTransferred },
          },
        })
      return { outcome: 'not-modified-without-cache', errorCategory: 'cache_invalid' }
    }
    const snapshot = {
      ...previous.data,
      observedAt: completedAt.toISOString(),
      freshnessExpiresAt: new Date(
        completedAt.getTime() + config.freshnessSeconds * 1000,
      ).toISOString(),
      cost: { fetches: fetched.requestCount, bytes: fetched.bytesTransferred },
    }
    const published = await publishSourceConnectionSnapshot({
      ...scope,
      now: completedAt,
      snapshot,
    })
    if (published.status !== 'CONFLICT') await saveCache(previous.data.contentHash)
    if (published.status === 'CONFLICT')
      await recordSourceConnectionPollFailure({
        ...scope,
        expectedConfigHash: configHash,
        now: completedAt,
        nextPollAt: new Date(completedAt.getTime() + config.refreshIntervalSeconds * 1000),
        errorCategory: 'publication_conflict',
      })
    return published.status === 'CONFLICT'
      ? { outcome: 'review-required', errorCategory: 'publication_conflict' }
      : { outcome: 'unchanged' }
  }
  const extracted = extractSourceConnection(config, fetched.body, fetched.contentType)
  const records = extracted.records
  const contentHash = sourceConnectionSnapshotHash(records)
  const preview = {
    configHash,
    contentHash,
    records,
    issues: extracted.issues,
    status: extracted.status,
    observedAt: completedAt.toISOString(),
    cost: { fetches: fetched.requestCount, bytes: fetched.bytesTransferred },
  }
  if (payload.mode === 'test') {
    await recordSourceConnectionPreviewAction({
      ...scope,
      expectedConfigHash: configHash,
      preview,
      now: completedAt,
    })
    if (extracted.status === 'VALID') await saveCache(contentHash)
    return { outcome: extracted.status === 'VALID' ? 'preview-valid' : 'preview-review-required' }
  }
  if (extracted.status !== 'VALID') {
    await recordSourceConnectionPollFailure({
      ...scope,
      expectedConfigHash: configHash,
      now: completedAt,
      nextPollAt: new Date(completedAt.getTime() + config.refreshIntervalSeconds * 1000),
      errorCategory: 'review_required',
    })
    return { outcome: 'review-required', errorCategory: 'review_required' }
  }
  const expiries = records
    .map((record) => record.effectiveUntil)
    .filter((date): date is string => Boolean(date))
  const snapshot = {
    version: 1 as const,
    configHash,
    contentHash,
    sourceUrl: config.sourceUrl,
    observedAt: completedAt.toISOString(),
    freshnessExpiresAt: new Date(
      completedAt.getTime() + config.freshnessSeconds * 1000,
    ).toISOString(),
    validUntil: expiries.length === records.length && expiries.length ? expiries.sort()[0]! : null,
    records,
    cost: { fetches: fetched.requestCount, bytes: fetched.bytesTransferred },
  }
  const published = await publishSourceConnectionSnapshot({ ...scope, snapshot, now: completedAt })
  if (published.status === 'CONFLICT') {
    await recordSourceConnectionPollFailure({
      ...scope,
      expectedConfigHash: configHash,
      now: completedAt,
      nextPollAt: new Date(completedAt.getTime() + config.refreshIntervalSeconds * 1000),
      errorCategory: 'review_required',
    })
    return { outcome: 'review-required', errorCategory: 'publication_conflict' }
  }
  await saveCache(contentHash)
  return { outcome: published.status.toLowerCase() }
}
