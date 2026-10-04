import { TRPCError } from '@trpc/server'

import {
  SOURCE_CONNECTION_PROVIDER,
  SourceConnectionConfigSchema,
  type SourceConnectionConfig,
} from '@pathfinder/contracts/source-connections'
import { sourceConnectionConfigHash } from '@pathfinder/contracts/source-connections-node'
import {
  approveSourceConnectionPreviewAction,
  createSourceConnectionDraftAction,
  db,
  setSourceConnectionStateAction,
  updateSourceConnectionDraftAction,
  writeAuditLogStrict,
} from '@pathfinder/db'
import { enqueueLiveDataPoll } from '@pathfinder/jobs'
import {
  checkLiveDataEndpoint,
  isLiveDataHostAllowed,
  parseLiveDataHostAllowlist,
  LIVE_DATA_LIMITS,
} from '@pathfinder/contracts/live-data'

type Database = typeof db
type Scope = { tenantId: string; venueId: string; connectorId: string; database?: Database }
type ActorRole = 'MANAGER' | 'OWNER' | 'PLATFORM_ADMIN'
type ActorScope = Scope & { actorId: string; actorRole: ActorRole }

const sourceSelect = {
  id: true,
  name: true,
  venueId: true,
  endpointHost: true,
  mapping: true,
  state: true,
  updatedAt: true,
  lastAttemptAt: true,
  lastSuccessAt: true,
  lastErrorAt: true,
  lastErrorCategory: true,
  consecutiveFailures: true,
  lastTestAt: true,
  lastTestOutcome: true,
  lastTestErrorCategory: true,
  lastTestPreview: true,
  observation: { select: { values: true, fetchedAt: true, observedAt: true } },
} as const

function actionError(error: unknown): never {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null
  if (code === 'NOT_FOUND' || code === 'CONFLICT' || code === 'INVALID_INPUT') {
    throw new TRPCError({
      code: code === 'INVALID_INPUT' ? 'BAD_REQUEST' : code,
      message: error instanceof Error ? error.message : 'Source connection action failed.',
    })
  }
  throw error
}

function assertConfig(input: SourceConnectionConfig): SourceConnectionConfig {
  const parsed = SourceConnectionConfigSchema.safeParse(input)
  if (!parsed.success || parsed.data.approval) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'A valid unapproved source configuration is required.',
    })
  }
  const hosts = parseLiveDataHostAllowlist(process.env.LIVE_DATA_ALLOWED_HOSTS)
  for (const url of parsed.data.allowedUrls) {
    const check = checkLiveDataEndpoint(url)
    if (
      !check.ok ||
      !isLiveDataHostAllowed(check.host, hosts, {
        production: process.env.NODE_ENV === 'production',
      })
    ) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'A source URL host is not approved for live data.',
      })
    }
  }
  return parsed.data
}

async function findSource(input: Scope) {
  const database = input.database ?? db
  const row = await database.liveDataConnector.findFirst({
    where: {
      id: input.connectorId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      provider: SOURCE_CONNECTION_PROVIDER,
    },
    select: sourceSelect,
  })
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Source connection not found.' })
  return row
}

type SourceRow = Awaited<ReturnType<typeof findSource>>

function project(row: SourceRow) {
  const config = SourceConnectionConfigSchema.safeParse(row.mapping)
  if (!config.success) {
    return {
      id: row.id,
      name: row.name,
      venueId: row.venueId,
      updatedAt: row.updatedAt,
      state: 'INVALID_CONFIG' as const,
      config: null,
      preview: null,
      snapshot: null,
      lastAttemptAt: row.lastAttemptAt,
      lastSuccessAt: row.lastSuccessAt,
      lastErrorAt: row.lastErrorAt,
      lastErrorCategory: row.lastErrorCategory,
      consecutiveFailures: row.consecutiveFailures,
    }
  }
  const approved =
    config.data.approval?.approvedConfigHash === sourceConnectionConfigHash(config.data)
  return {
    id: row.id,
    name: row.name,
    venueId: row.venueId,
    endpointHost: row.endpointHost,
    updatedAt: row.updatedAt,
    state: row.state,
    config: config.data,
    approved,
    preview: row.lastTestPreview,
    previewAt: row.lastTestAt,
    previewOutcome: row.lastTestOutcome,
    previewErrorCategory: row.lastTestErrorCategory,
    snapshot: row.observation?.values ?? null,
    snapshotFetchedAt: row.observation?.fetchedAt ?? null,
    lastAttemptAt: row.lastAttemptAt,
    lastSuccessAt: row.lastSuccessAt,
    lastErrorAt: row.lastErrorAt,
    lastErrorCategory: row.lastErrorCategory,
    consecutiveFailures: row.consecutiveFailures,
  }
}

export async function listSourceConnections(input: {
  tenantId: string
  venueId: string
  database?: Database
}) {
  const rows = await (input.database ?? db).liveDataConnector.findMany({
    where: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      provider: SOURCE_CONNECTION_PROVIDER,
    },
    select: sourceSelect,
    orderBy: { createdAt: 'desc' },
    take: LIVE_DATA_LIMITS.maxConnectorsPerVenue,
  })
  return rows.map(project)
}

export async function getSourceConnection(input: Scope) {
  return project(await findSource(input))
}

export async function createSourceConnectionDraft(input: {
  tenantId: string
  venueId: string
  name: string
  config: SourceConnectionConfig
  actorId: string
  actorRole: ActorRole
  operationId?: string
  database?: Database
}) {
  const config = assertConfig(input.config)
  try {
    return await createSourceConnectionDraftAction(
      {
        tenantId: input.tenantId,
        venueId: input.venueId,
        name: input.name,
        config,
        actorId: input.actorId,
        actorRole: input.actorRole,
        ...(input.operationId ? { operationId: input.operationId } : {}),
      },
      input.database ?? db,
    )
  } catch (error) {
    actionError(error)
  }
}

export async function updateSourceConnectionDraft(
  input: ActorScope & {
    expectedUpdatedAt: string
    config: SourceConnectionConfig
  },
) {
  const config = assertConfig(input.config)
  try {
    return await updateSourceConnectionDraftAction(
      {
        tenantId: input.tenantId,
        venueId: input.venueId,
        connectorId: input.connectorId,
        expectedUpdatedAt: input.expectedUpdatedAt,
        config,
        actorId: input.actorId,
        actorRole: input.actorRole,
      },
      input.database ?? db,
    )
  } catch (error) {
    actionError(error)
  }
}

export async function requestSourceConnectionPreview(
  input: ActorScope & { expectedUpdatedAt: string },
) {
  const row = await findSource(input)
  if (row.updatedAt.toISOString() !== input.expectedUpdatedAt) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Source configuration changed. Reload before preview.',
    })
  }
  if (
    row.lastTestAt &&
    Date.now() - row.lastTestAt.getTime() < LIVE_DATA_LIMITS.testCooldownSeconds * 1000
  ) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'Wait before previewing this source again.',
    })
  }
  const config = SourceConnectionConfigSchema.safeParse(row.mapping)
  if (!config.success)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Source configuration is invalid.' })
  const configHash = sourceConnectionConfigHash(config.data)
  await writeAuditLogStrict(
    {
      tenantId: input.tenantId,
      actorId: input.actorId,
      actorRole: input.actorRole,
      action: 'source-connection.preview-requested',
      targetType: 'LiveDataConnector',
      targetId: input.connectorId,
      afterState: { venueId: input.venueId, configHash },
    },
    input.database ?? db,
  )
  await enqueueLiveDataPoll({
    tenantId: input.tenantId,
    venueId: input.venueId,
    connectorId: input.connectorId,
    mode: 'test',
  })
  return { id: row.id, queued: true, configHash }
}

export async function approveSourceConnectionPreview(
  input: ActorScope & {
    expectedUpdatedAt: string
    previewId: string
    previewHash: string
  },
) {
  try {
    return await approveSourceConnectionPreviewAction(
      {
        tenantId: input.tenantId,
        venueId: input.venueId,
        connectorId: input.connectorId,
        expectedUpdatedAt: input.expectedUpdatedAt,
        previewId: input.previewId,
        previewHash: input.previewHash,
        actorId: input.actorId,
        actorRole: input.actorRole,
        now: new Date(),
      },
      input.database ?? db,
    )
  } catch (error) {
    actionError(error)
  }
}

export async function setSourceConnectionState(
  input: ActorScope & {
    expectedUpdatedAt: string
    state: 'ACTIVE' | 'DISABLED'
  },
) {
  try {
    return await setSourceConnectionStateAction(
      {
        tenantId: input.tenantId,
        venueId: input.venueId,
        connectorId: input.connectorId,
        expectedUpdatedAt: input.expectedUpdatedAt,
        state: input.state,
        actorId: input.actorId,
        actorRole: input.actorRole,
        now: new Date(),
      },
      input.database ?? db,
    )
  } catch (error) {
    actionError(error)
  }
}

export async function requestSourceConnectionRefresh(
  input: ActorScope & { expectedUpdatedAt: string },
) {
  const row = await findSource(input)
  if (row.updatedAt.toISOString() !== input.expectedUpdatedAt) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Source configuration changed. Reload before refreshing.',
    })
  }
  const config = SourceConnectionConfigSchema.safeParse(row.mapping)
  if (
    !config.success ||
    row.state !== 'ACTIVE' ||
    config.data.approval?.approvedConfigHash !== sourceConnectionConfigHash(config.data)
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Approve and resume this source before refreshing.',
    })
  }
  await writeAuditLogStrict(
    {
      tenantId: input.tenantId,
      actorId: input.actorId,
      actorRole: input.actorRole,
      action: 'source-connection.refresh-requested',
      targetType: 'LiveDataConnector',
      targetId: input.connectorId,
      afterState: { venueId: input.venueId },
    },
    input.database ?? db,
  )
  await enqueueLiveDataPoll({
    tenantId: input.tenantId,
    venueId: input.venueId,
    connectorId: input.connectorId,
    mode: 'manual',
  })
  return { id: row.id, queued: true }
}
