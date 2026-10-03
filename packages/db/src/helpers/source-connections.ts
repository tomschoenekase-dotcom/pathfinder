import { randomUUID } from 'node:crypto'

import { Prisma } from '@prisma/client'
import {
  SOURCE_CONNECTION_PROVIDER,
  SOURCE_CONNECTION_LIMITS,
  SourceConnectionConfigSchema,
  SourceConnectionRecordSchema,
  type SourceConnectionConfig,
  type SourceConnectionRecord,
} from '@pathfinder/contracts/source-connections'
import {
  sourceConnectionConfigHash,
  sourceConnectionSnapshotHash,
} from '@pathfinder/contracts/source-connections-node'
import {
  LIVE_DATA_LIMITS,
  isLiveDataHostAllowed,
  parseLiveDataHostAllowlist,
} from '@pathfinder/contracts/live-data'

import { db } from '../client'
import { readAuthorizedSourceHostsAction } from './venue-source-actions'
import { writeAuditLogStrict } from './audit'
import { lockVenueContentMutation } from './venue-content-lock'

export class SourceConnectionActionError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message)
  }
}

type Client = typeof db
type Scope = { tenantId: string; venueId: string; connectorId: string }
type HumanActor = { actorId: string; actorRole: 'MANAGER' | 'OWNER' | 'PLATFORM_ADMIN' }
const opaque = /^[A-Za-z0-9_-]{1,191}$/u

function nextVersion(previous: Date): Date {
  return new Date(Math.max(Date.now(), previous.getTime() + 1))
}

function assertActor(actor: HumanActor): void {
  if (
    !opaque.test(actor.actorId) ||
    !['MANAGER', 'OWNER', 'PLATFORM_ADMIN'].includes(actor.actorRole)
  ) {
    throw new SourceConnectionActionError(
      'INVALID_INPUT',
      'Verified manager or owner authority is required.',
    )
  }
}

async function auditAction(
  input: { tenantId: string; venueId: string } & HumanActor,
  targetId: string,
  action: string,
  client: Pick<Client, 'auditLog'>,
) {
  await writeAuditLogStrict(
    {
      tenantId: input.tenantId,
      actorId: input.actorId,
      actorRole: input.actorRole,
      action,
      targetType: 'LiveDataConnector',
      targetId,
      afterState: { venueId: input.venueId },
    },
    client,
  )
}

/** Immutable, bounded extraction/check evidence in the existing source-intake store. */
export async function recordSourceConnectionEvidence(
  input: Scope & {
    sourceUrl: string
    now: Date
    disposition: 'SUCCEEDED' | 'FAILED'
    evidence: Prisma.InputJsonValue
    bytes?: number
  },
  client: Pick<Client, 'venueSource' | 'venueSourceInput'>,
): Promise<string> {
  const text = JSON.stringify(input.evidence)
  if (Buffer.byteLength(text, 'utf8') > 512_000)
    throw new SourceConnectionActionError('INVALID_INPUT', 'Source evidence exceeds its bound.')
  const source = await client.venueSource.create({
    data: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      requestUrl: input.sourceUrl,
      host: new URL(input.sourceUrl).hostname,
      note: `Source connection ${input.connectorId}`,
      status: input.disposition,
      maxPages: 1,
      maxBytesPerPage: 1_000_000,
      parserVersion: SOURCE_CONNECTION_PROVIDER,
      operationId: randomUUID(),
      requestedBy: `source-connection:${input.connectorId}`,
      attempts: 1,
      requestedAt: input.now,
      startedAt: input.now,
      completedAt: input.now,
    },
    select: { id: true },
  })
  await client.venueSourceInput.create({
    data: {
      sourceId: source.id,
      tenantId: input.tenantId,
      venueId: input.venueId,
      ordinal: 0,
      requestedUrl: input.sourceUrl,
      finalUrl: input.sourceUrl,
      redirectChain: [],
      disposition: input.disposition,
      byteSize: input.bytes ?? 0,
      contentHash: sourceConnectionSnapshotHash(input.evidence),
      retrievedAt: input.now,
      parserVersion: SOURCE_CONNECTION_PROVIDER,
      contentType: 'application/json',
      extractedText: text,
      textTruncated: false,
    },
  })
  return source.id
}

function assertScope(scope: { tenantId: string; venueId: string }) {
  if (!opaque.test(scope.tenantId) || !opaque.test(scope.venueId)) {
    throw new SourceConnectionActionError(
      'INVALID_INPUT',
      'Exact tenant and venue scope is required.',
    )
  }
}

export async function validateSourceConnectionConfig(
  input: { tenantId: string; venueId: string; config: unknown },
  client: Client = db,
): Promise<SourceConnectionConfig> {
  assertScope(input)
  const parsed = SourceConnectionConfigSchema.safeParse(input.config)
  if (!parsed.success)
    throw new SourceConnectionActionError('INVALID_INPUT', 'Source config is invalid.')
  const config = parsed.data
  const venueHosts = await readAuthorizedSourceHostsAction(input, client)
  const allowed = parseLiveDataHostAllowlist(process.env.LIVE_DATA_ALLOWED_HOSTS)
  for (const rawUrl of config.allowedUrls) {
    const host = new URL(rawUrl).hostname.toLowerCase()
    if (
      !venueHosts.includes(host) ||
      !isLiveDataHostAllowed(host, allowed, { production: process.env.NODE_ENV === 'production' })
    ) {
      throw new SourceConnectionActionError(
        'INVALID_INPUT',
        'Source host is not authorized for this venue.',
      )
    }
  }
  return config
}

export type SourceConnectionPreview = {
  previewId: string
  configHash: string
  contentHash: string
  previewHash: string
  records: SourceConnectionRecord[]
  issues: string[]
  status: 'VALID' | 'REVIEW_REQUIRED'
  observedAt: string
  cost: { fetches: number; bytes: number }
}

export function sourceConnectionPreviewHash(
  preview: Omit<SourceConnectionPreview, 'previewId' | 'previewHash'>,
): string {
  return sourceConnectionSnapshotHash(preview)
}

export function readSourceConnectionPreview(raw: unknown): SourceConnectionPreview | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (
    typeof value.previewId !== 'string' ||
    typeof value.configHash !== 'string' ||
    typeof value.contentHash !== 'string' ||
    typeof value.previewHash !== 'string' ||
    !Array.isArray(value.records) ||
    !Array.isArray(value.issues) ||
    (value.status !== 'VALID' && value.status !== 'REVIEW_REQUIRED') ||
    typeof value.observedAt !== 'string'
  )
    return null
  if (!value.records.every((record) => SourceConnectionRecordSchema.safeParse(record).success))
    return null
  if (!value.issues.every((issue) => typeof issue === 'string')) return null
  const cost = value.cost
  if (
    !cost ||
    typeof cost !== 'object' ||
    Array.isArray(cost) ||
    typeof (cost as Record<string, unknown>).fetches !== 'number' ||
    typeof (cost as Record<string, unknown>).bytes !== 'number'
  )
    return null
  const preview = value as SourceConnectionPreview
  if (
    !/^[a-f0-9]{64}$/u.test(preview.configHash) ||
    !/^[a-f0-9]{64}$/u.test(preview.contentHash) ||
    !Number.isFinite(new Date(preview.observedAt).getTime()) ||
    preview.records.length > SOURCE_CONNECTION_LIMITS.maxRecords ||
    !Number.isSafeInteger(preview.cost.fetches) ||
    preview.cost.fetches < 0 ||
    preview.cost.fetches >
      SOURCE_CONNECTION_LIMITS.maxAttempts * (SOURCE_CONNECTION_LIMITS.maxRedirects + 1) ||
    !Number.isSafeInteger(preview.cost.bytes) ||
    preview.cost.bytes < 0 ||
    preview.cost.bytes >
      SOURCE_CONNECTION_LIMITS.maxBodyBytes *
        SOURCE_CONNECTION_LIMITS.maxAttempts *
        (SOURCE_CONNECTION_LIMITS.maxRedirects + 1) ||
    sourceConnectionSnapshotHash(preview.records) !== preview.contentHash
  )
    return null
  const body = {
    configHash: preview.configHash,
    contentHash: preview.contentHash,
    records: preview.records,
    issues: preview.issues,
    status: preview.status,
    observedAt: preview.observedAt,
    cost: preview.cost,
  }
  return sourceConnectionPreviewHash(body) === preview.previewHash ? preview : null
}

type Usage = {
  day: string
  requests: number
  bytes: number
  llmTokens: 0
  llmCostUsd: 0
  networkCost: 'unpriced'
}

function usageFrom(raw: unknown, now: Date): Usage {
  const day = now.toISOString().slice(0, 10)
  const value =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).usage
      : null
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const usage = value as Record<string, unknown>
    if (
      usage.day === day &&
      Number.isSafeInteger(usage.requests) &&
      Number.isSafeInteger(usage.bytes) &&
      (usage.requests as number) >= 0 &&
      (usage.bytes as number) >= 0
    ) {
      return {
        day,
        requests: usage.requests as number,
        bytes: usage.bytes as number,
        llmTokens: 0,
        llmCostUsd: 0,
        networkCost: 'unpriced',
      }
    }
  }
  return { day, requests: 0, bytes: 0, llmTokens: 0, llmCostUsd: 0, networkCost: 'unpriced' }
}

function previewWithUsage(raw: unknown, usage: Usage): Prisma.InputJsonValue {
  const base =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return { ...base, usage } as Prisma.InputJsonValue
}

/** Count each HTTP attempt before it leaves the worker, including redirects and retries. */
export async function claimSourceConnectionRequest(
  input: Scope & { expectedConfigHash: string; now: Date; previewOnly?: boolean },
  client: Client = db,
): Promise<boolean> {
  for (let retry = 0; retry < 4; retry += 1) {
    const row = await client.liveDataConnector.findFirst({
      where: {
        id: input.connectorId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        provider: SOURCE_CONNECTION_PROVIDER,
        ...(!input.previewOnly ? { state: 'ACTIVE' as const } : {}),
      },
      select: { mapping: true, lastTestPreview: true, updatedAt: true },
    })
    if (!row) return false
    const parsed = SourceConnectionConfigSchema.safeParse(row.mapping)
    if (!parsed.success || sourceConnectionConfigHash(parsed.data) !== input.expectedConfigHash)
      return false
    const usage = usageFrom(row.lastTestPreview, input.now)
    if (usage.requests >= parsed.data.validation.maxRequestsPerDay) return false
    const updated = await client.liveDataConnector.updateMany({
      where: {
        id: input.connectorId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        updatedAt: row.updatedAt,
        ...(!input.previewOnly ? { state: 'ACTIVE' as const } : {}),
      },
      data: {
        updatedAt: nextVersion(row.updatedAt),
        lastTestPreview: previewWithUsage(row.lastTestPreview, {
          ...usage,
          requests: usage.requests + 1,
        }),
      },
    })
    if (updated.count === 1) return true
  }
  return false
}

export async function recordSourceConnectionBytes(
  input: Scope & { bytes: number; now: Date },
  client: Client = db,
): Promise<void> {
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 0) return
  for (let retry = 0; retry < 4; retry += 1) {
    const row = await client.liveDataConnector.findFirst({
      where: {
        id: input.connectorId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        provider: SOURCE_CONNECTION_PROVIDER,
      },
      select: { lastTestPreview: true, updatedAt: true },
    })
    if (!row) return
    const usage = usageFrom(row.lastTestPreview, input.now)
    const updated = await client.liveDataConnector.updateMany({
      where: {
        id: input.connectorId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        updatedAt: row.updatedAt,
      },
      data: {
        updatedAt: nextVersion(row.updatedAt),
        lastTestPreview: previewWithUsage(row.lastTestPreview, {
          ...usage,
          bytes: usage.bytes + input.bytes,
        }),
      },
    })
    if (updated.count === 1) return
  }
}

export async function recordSourceConnectionCache(
  input: Scope & {
    etag?: string
    lastModified?: string
    expectedConfigHash: string
    contentHash: string
  },
  client: Client = db,
): Promise<void> {
  for (let retry = 0; retry < 4; retry += 1) {
    const row = await client.liveDataConnector.findFirst({
      where: {
        id: input.connectorId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        provider: SOURCE_CONNECTION_PROVIDER,
      },
      select: { mapping: true, lastTestPreview: true, updatedAt: true },
    })
    if (!row) return
    const parsed = SourceConnectionConfigSchema.safeParse(row.mapping)
    if (!parsed.success || sourceConnectionConfigHash(parsed.data) !== input.expectedConfigHash)
      return
    const base =
      row.lastTestPreview &&
      typeof row.lastTestPreview === 'object' &&
      !Array.isArray(row.lastTestPreview)
        ? (row.lastTestPreview as Record<string, unknown>)
        : {}
    const cache = {
      configHash: input.expectedConfigHash,
      contentHash: input.contentHash,
      ...(input.etag !== undefined ? { etag: input.etag } : {}),
      ...(input.lastModified !== undefined ? { lastModified: input.lastModified } : {}),
    }
    const updated = await client.liveDataConnector.updateMany({
      where: {
        id: input.connectorId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        updatedAt: row.updatedAt,
      },
      data: {
        updatedAt: nextVersion(row.updatedAt),
        lastTestPreview: { ...base, cache } as Prisma.InputJsonValue,
      },
    })
    if (updated.count === 1) return
  }
}

export async function claimSourceConnectionPollSlot(
  input: Scope & { mode: 'scheduled' | 'manual'; expectedConfigHash: string; now: Date },
  client: Client = db,
): Promise<boolean> {
  const row = await client.liveDataConnector.findFirst({
    where: {
      id: input.connectorId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      provider: SOURCE_CONNECTION_PROVIDER,
      state: 'ACTIVE',
    },
    select: {
      mapping: true,
      pollIntervalSeconds: true,
      nextPollAt: true,
      lastAttemptAt: true,
      updatedAt: true,
    },
  })
  if (!row) return false
  const parsed = SourceConnectionConfigSchema.safeParse(row.mapping)
  if (
    !parsed.success ||
    !parsed.data.approval ||
    parsed.data.approval.approvedConfigHash !== input.expectedConfigHash ||
    sourceConnectionConfigHash(parsed.data) !== input.expectedConfigHash
  )
    return false
  if (input.mode === 'scheduled' && row.nextPollAt && row.nextPollAt > input.now) return false
  // Manual refreshes share a five-minute cooldown with scheduled work.
  if (row.lastAttemptAt && input.now.getTime() - row.lastAttemptAt.getTime() < 300_000) return false
  const updated = await client.liveDataConnector.updateMany({
    where: {
      id: input.connectorId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      provider: SOURCE_CONNECTION_PROVIDER,
      state: 'ACTIVE',
      updatedAt: row.updatedAt,
    },
    data: {
      updatedAt: nextVersion(row.updatedAt),
      lastAttemptAt: input.now,
      nextPollAt: new Date(input.now.getTime() + row.pollIntervalSeconds * 1000),
    },
  })
  return updated.count === 1
}

export async function createSourceConnectionDraftAction(
  input: {
    tenantId: string
    venueId: string
    name: string
    config: unknown
    operationId?: string
  } & HumanActor,
  client: Client = db,
) {
  assertActor(input)
  return client.$transaction(async (rawTx) => {
    const client = rawTx as unknown as Client
    assertScope(input)
    if (!input.name.trim() || input.name.length > 120 || !opaque.test(input.actorId))
      throw new SourceConnectionActionError('INVALID_INPUT', 'Invalid source name or actor.')
    const config = await validateSourceConnectionConfig(input, client)
    const { approval: _approval, ...draft } = config
    void _approval
    const resourceId = input.operationId ? `source_${input.operationId}` : `source_${randomUUID()}`
    if (!/^source_[0-9a-f-]{36}$/iu.test(resourceId))
      throw new SourceConnectionActionError('INVALID_INPUT', 'Operation ID must be a UUID.')
    // Shared tenant-wide lock: the venue and tenant capacities cannot be raced by two creations.
    await lockVenueContentMutation(client, {
      tenantId: input.tenantId,
      venueId: 'live-data-connector-capacity',
    })
    const existing = await client.liveDataConnector.findFirst({
      where: { tenantId: input.tenantId, venueId: input.venueId, resourceId },
      select: { id: true, updatedAt: true, mapping: true, name: true },
    })
    if (existing) {
      if (
        existing.name !== input.name ||
        sourceConnectionConfigHash(SourceConnectionConfigSchema.parse(existing.mapping)) !==
          sourceConnectionConfigHash(config)
      )
        throw new SourceConnectionActionError(
          'CONFLICT',
          'Operation ID belongs to a different source.',
        )
      return { id: existing.id, updatedAt: existing.updatedAt }
    }
    const [venueCount, tenantCount] = await Promise.all([
      client.liveDataConnector.count({
        where: { tenantId: input.tenantId, venueId: input.venueId },
      }),
      client.liveDataConnector.count({ where: { tenantId: input.tenantId } }),
    ])
    if (
      venueCount >= LIVE_DATA_LIMITS.maxConnectorsPerVenue ||
      tenantCount >= LIVE_DATA_LIMITS.maxConnectorsPerTenant
    )
      throw new SourceConnectionActionError('INVALID_INPUT', 'Live data connector limit reached.')
    const url = new URL(config.sourceUrl)
    const venue = await client.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: { id: true },
    })
    if (!venue) throw new SourceConnectionActionError('NOT_FOUND', 'Venue not found.')
    const row = await client.liveDataConnector.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        name: input.name,
        kind: 'GENERIC_JSON',
        provider: SOURCE_CONNECTION_PROVIDER,
        resourceId,
        resourceLabel: input.name,
        endpointUrl: config.sourceUrl,
        endpointHost: url.hostname,
        mapping: draft as Prisma.InputJsonValue,
        pollIntervalSeconds: config.refreshIntervalSeconds,
        freshnessBudgetSeconds: config.freshnessSeconds,
        timezone: config.timezone,
        state: 'DISABLED',
        createdBy: input.actorId,
        updatedBy: input.actorId,
      },
      select: { id: true, updatedAt: true },
    })
    await auditAction(input, row.id, 'source_connection.created', client)
    return row
  })
}

export async function updateSourceConnectionDraftAction(
  input: Scope & { expectedUpdatedAt: string; config: unknown } & HumanActor,
  client: Client = db,
) {
  assertActor(input)
  return client.$transaction(async (rawTx) => {
    const client = rawTx as unknown as Client
    assertScope(input)
    const config = await validateSourceConnectionConfig(input, client)
    const { approval: _approval, ...draft } = config
    void _approval
    const previous = await client.liveDataConnector.findFirst({
      where: {
        id: input.connectorId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        provider: SOURCE_CONNECTION_PROVIDER,
        updatedAt: new Date(input.expectedUpdatedAt),
        state: 'DISABLED',
      },
      select: { lastTestPreview: true, updatedAt: true },
    })
    if (!previous)
      throw new SourceConnectionActionError('CONFLICT', 'Source draft changed or is active.')
    const metadata =
      previous.lastTestPreview &&
      typeof previous.lastTestPreview === 'object' &&
      !Array.isArray(previous.lastTestPreview)
        ? (previous.lastTestPreview as Record<string, unknown>)
        : {}
    const row = await client.liveDataConnector.updateMany({
      where: {
        id: input.connectorId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        provider: SOURCE_CONNECTION_PROVIDER,
        updatedAt: new Date(input.expectedUpdatedAt),
        state: 'DISABLED',
      },
      data: {
        mapping: draft as Prisma.InputJsonValue,
        endpointUrl: config.sourceUrl,
        endpointHost: new URL(config.sourceUrl).hostname,
        pollIntervalSeconds: config.refreshIntervalSeconds,
        freshnessBudgetSeconds: config.freshnessSeconds,
        timezone: config.timezone,
        // A config edit invalidates preview and validators, but never resets the daily request budget.
        lastTestPreview: {
          ...(metadata.usage ? { usage: metadata.usage } : {}),
        } as Prisma.InputJsonValue,
        updatedAt: nextVersion(previous.updatedAt),
        lastTestAt: null,
        lastTestOutcome: null,
        lastTestErrorCategory: null,
        updatedBy: input.actorId,
      },
    })
    if (row.count !== 1)
      throw new SourceConnectionActionError('CONFLICT', 'Source draft changed or is active.')
    const updated = await client.liveDataConnector.findFirst({
      where: { id: input.connectorId, tenantId: input.tenantId, venueId: input.venueId },
      select: { id: true, updatedAt: true },
    })
    await auditAction(input, input.connectorId, 'source_connection.draft_updated', client)
    return updated!
  })
}

export async function recordSourceConnectionPreviewAction(
  input: Scope & {
    expectedConfigHash: string
    preview: Omit<SourceConnectionPreview, 'previewId' | 'previewHash'>
    now: Date
  },
  client: Client = db,
) {
  return client.$transaction(async (rawTx) => {
    const client = rawTx as unknown as Client
    const row = await client.liveDataConnector.findFirst({
      where: {
        id: input.connectorId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        provider: SOURCE_CONNECTION_PROVIDER,
      },
      select: { mapping: true, updatedAt: true, lastTestPreview: true },
    })
    if (!row) throw new SourceConnectionActionError('NOT_FOUND', 'Source not found.')
    const config = SourceConnectionConfigSchema.parse(row.mapping)
    if (
      sourceConnectionConfigHash(config) !== input.expectedConfigHash ||
      input.preview.configHash !== input.expectedConfigHash
    )
      throw new SourceConnectionActionError('CONFLICT', 'Source config changed during preview.')
    const preview: SourceConnectionPreview = {
      ...input.preview,
      previewId: randomUUID(),
      previewHash: sourceConnectionPreviewHash(input.preview),
    }
    if (!readSourceConnectionPreview(preview))
      throw new SourceConnectionActionError('INVALID_INPUT', 'Source preview is invalid.')
    const updated = await client.liveDataConnector.updateMany({
      where: {
        id: input.connectorId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        provider: SOURCE_CONNECTION_PROVIDER,
        updatedAt: row.updatedAt,
      },
      data: {
        lastTestAt: input.now,
        lastTestOutcome: preview.status === 'VALID' ? 'OK' : 'FAILED',
        lastTestErrorCategory: preview.status === 'VALID' ? null : 'review_required',
        updatedAt: nextVersion(row.updatedAt),
        lastTestPreview: previewWithUsage(
          {
            ...preview,
            cache:
              (row.lastTestPreview &&
              typeof row.lastTestPreview === 'object' &&
              !Array.isArray(row.lastTestPreview)
                ? (row.lastTestPreview as Record<string, unknown>).cache
                : undefined) ?? {},
          },
          usageFrom(row.lastTestPreview, input.now),
        ),
      },
    })
    if (updated.count !== 1)
      throw new SourceConnectionActionError('CONFLICT', 'Source config changed during preview.')
    await recordSourceConnectionEvidence(
      {
        ...input,
        sourceUrl: config.sourceUrl,
        disposition: preview.status === 'VALID' ? 'SUCCEEDED' : 'FAILED',
        evidence: preview as unknown as Prisma.InputJsonValue,
        bytes: preview.cost.bytes,
      },
      client,
    )
    const current = await client.liveDataConnector.findFirst({
      where: { id: input.connectorId, tenantId: input.tenantId, venueId: input.venueId },
      select: { updatedAt: true },
    })
    return { previewId: preview.previewId, updatedAt: current!.updatedAt }
  })
}

export async function approveSourceConnectionPreviewAction(
  input: Scope & {
    expectedUpdatedAt: string
    previewId: string
    previewHash: string
    now: Date
  } & HumanActor,
  client: Client = db,
) {
  assertActor(input)
  return client.$transaction(async (tx) => {
    const row = await tx.liveDataConnector.findFirst({
      where: {
        id: input.connectorId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        provider: SOURCE_CONNECTION_PROVIDER,
        updatedAt: new Date(input.expectedUpdatedAt),
      },
      select: { mapping: true, lastTestPreview: true },
    })
    if (!row) throw new SourceConnectionActionError('CONFLICT', 'Source changed before approval.')
    const config = SourceConnectionConfigSchema.parse(row.mapping)
    const preview = readSourceConnectionPreview(row.lastTestPreview)
    if (
      !preview ||
      preview.status !== 'VALID' ||
      preview.issues.length ||
      preview.previewId !== input.previewId ||
      preview.previewHash !== input.previewHash ||
      preview.configHash !== sourceConnectionConfigHash(config)
    )
      throw new SourceConnectionActionError('CONFLICT', 'Exact valid preview is required.')
    if (
      new Date(preview.observedAt) > input.now ||
      input.now.getTime() - new Date(preview.observedAt).getTime() >= config.freshnessSeconds * 1000
    )
      throw new SourceConnectionActionError('CONFLICT', 'A current source preview is required.')
    const updatedConfig = {
      ...config,
      approval: {
        approvedConfigHash: preview.configHash,
        approvedPreviewHash: preview.previewHash,
        approvedAt: input.now.toISOString(),
        approvedBy: input.actorId,
      },
    }
    const updated = await tx.liveDataConnector.updateMany({
      where: {
        id: input.connectorId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        provider: SOURCE_CONNECTION_PROVIDER,
        updatedAt: new Date(input.expectedUpdatedAt),
      },
      data: {
        updatedAt: nextVersion(new Date(input.expectedUpdatedAt)),
        mapping: updatedConfig as Prisma.InputJsonValue,
        state: 'ACTIVE',
        nextPollAt: input.now,
        updatedBy: input.actorId,
      },
    })
    if (updated.count !== 1)
      throw new SourceConnectionActionError('CONFLICT', 'Source changed before approval.')
    const current = await tx.liveDataConnector.findFirst({
      where: { id: input.connectorId, tenantId: input.tenantId, venueId: input.venueId },
      select: { id: true, updatedAt: true },
    })
    await auditAction(input, input.connectorId, 'source_connection.preview_approved', tx)
    return current!
  })
}

export async function setSourceConnectionStateAction(
  input: Scope & {
    expectedUpdatedAt: string
    state: 'ACTIVE' | 'DISABLED'
    now: Date
  } & HumanActor,
  client: Client = db,
) {
  assertActor(input)
  return client.$transaction(async (rawTx) => {
    const client = rawTx as unknown as Client
    const row = await client.liveDataConnector.findFirst({
      where: {
        id: input.connectorId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        provider: SOURCE_CONNECTION_PROVIDER,
        updatedAt: new Date(input.expectedUpdatedAt),
      },
      select: { mapping: true },
    })
    if (!row)
      throw new SourceConnectionActionError('CONFLICT', 'Source changed before state transition.')
    const config = SourceConnectionConfigSchema.parse(row.mapping)
    if (
      input.state === 'ACTIVE' &&
      (!config.approval ||
        config.approval.approvedConfigHash !== sourceConnectionConfigHash(config))
    )
      throw new SourceConnectionActionError('CONFLICT', 'Current config has no matching approval.')
    const updated = await client.liveDataConnector.updateMany({
      where: {
        id: input.connectorId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        provider: SOURCE_CONNECTION_PROVIDER,
        updatedAt: new Date(input.expectedUpdatedAt),
      },
      data: {
        updatedAt: nextVersion(new Date(input.expectedUpdatedAt)),
        state: input.state,
        nextPollAt: input.state === 'ACTIVE' ? input.now : null,
        updatedBy: input.actorId,
      },
    })
    if (updated.count !== 1)
      throw new SourceConnectionActionError('CONFLICT', 'Source changed before state transition.')
    const current = await client.liveDataConnector.findFirst({
      where: { id: input.connectorId, tenantId: input.tenantId, venueId: input.venueId },
      select: { id: true, updatedAt: true },
    })
    await auditAction(
      input,
      input.connectorId,
      input.state === 'ACTIVE' ? 'source_connection.resumed' : 'source_connection.paused',
      client,
    )
    return current!
  })
}

/** An old job cannot move the schedule or failure counters of a paused or edited connector. */
export async function recordSourceConnectionPollFailure(
  input: Scope & { expectedConfigHash: string; now: Date; nextPollAt: Date; errorCategory: string },
  client: Client = db,
): Promise<boolean> {
  return client.$transaction(async (rawTx) => {
    const client = rawTx as unknown as Client
    const row = await client.liveDataConnector.findFirst({
      where: {
        id: input.connectorId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        provider: SOURCE_CONNECTION_PROVIDER,
        state: 'ACTIVE',
      },
      select: { mapping: true, updatedAt: true },
    })
    const config = SourceConnectionConfigSchema.safeParse(row?.mapping)
    if (
      !row ||
      !config.success ||
      sourceConnectionConfigHash(config.data) !== input.expectedConfigHash
    )
      return false
    const changed = await client.liveDataConnector.updateMany({
      where: {
        id: input.connectorId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        provider: SOURCE_CONNECTION_PROVIDER,
        state: 'ACTIVE',
        updatedAt: row.updatedAt,
      },
      data: {
        updatedAt: nextVersion(row.updatedAt),
        lastErrorAt: input.now,
        lastErrorCategory: input.errorCategory.slice(0, 32),
        consecutiveFailures: { increment: 1 },
        nextPollAt: input.nextPollAt,
      },
    })
    if (changed.count === 1)
      await recordSourceConnectionEvidence(
        {
          ...input,
          sourceUrl: config.data.sourceUrl,
          disposition: 'FAILED',
          evidence: {
            configHash: input.expectedConfigHash,
            errorCategory: input.errorCategory,
            observedAt: input.now.toISOString(),
          },
        },
        client,
      )
    return changed.count === 1
  })
}
