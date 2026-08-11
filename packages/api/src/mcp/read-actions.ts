import type { PrismaClient } from '@prisma/client'

import type { McpReadInput, McpToolResult } from '@pathfinder/contracts/mcp-v0'

import type { PathfinderMcpDomainActions, VerifiedMcpInvocationContext } from './registry'

const CURSOR_VERSION = 1 as const
const MAX_PAGE_SIZE = 100
const FORBIDDEN_EXTERNAL_FIELDS = new Set([
  'sourceUrl',
  'photoUrl',
  'chatLogoUrl',
  'chatBannerUrl',
  'redirectTo',
  'lastErrorCode',
])

type ReadResource = McpReadInput['resource']
type ReadDb = Pick<
  PrismaClient,
  | 'tenant'
  | 'venue'
  | 'place'
  | 'venueKnowledgeEntry'
  | 'contentVersion'
  | 'venuePackage'
  | 'supportRequest'
  | 'operationalUpdate'
  | 'aiUsageDailyRollup'
  | 'jobRecord'
  | 'evalRun'
  | 'venueReportConfiguration'
>

type CursorPayload = Readonly<{
  v: typeof CURSOR_VERSION
  resource: ReadResource
  sortAt: string
  id: string
}>

export class McpReadBindingError extends Error {
  constructor(
    readonly code: 'INVALID_CURSOR' | 'SCOPE_INVARIANT' | 'RESOURCE_UNAVAILABLE',
    message: string,
  ) {
    super(message)
  }
}

/**
 * Deterministic, opaque pagination token. It carries no authority: the adapter always reapplies
 * the verified credential's tenant/client/venue scope after decoding it.
 */
export function encodeMcpReadCursor(payload: Omit<CursorPayload, 'v'>): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, ...payload }), 'utf8').toString(
    'base64url',
  )
}

export function decodeMcpReadCursor(
  encoded: string | undefined,
  expectedResource: ReadResource,
): CursorPayload | undefined {
  if (encoded === undefined) return undefined
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown
    if (
      typeof value !== 'object' ||
      value === null ||
      !('v' in value) ||
      value.v !== CURSOR_VERSION ||
      !('resource' in value) ||
      value.resource !== expectedResource ||
      !('sortAt' in value) ||
      typeof value.sortAt !== 'string' ||
      !Number.isFinite(Date.parse(value.sortAt)) ||
      !('id' in value) ||
      typeof value.id !== 'string' ||
      value.id.length < 1 ||
      value.id.length > 120
    ) {
      throw new Error('invalid')
    }
    return value as CursorPayload
  } catch {
    throw new McpReadBindingError('INVALID_CURSOR', 'The pagination cursor is invalid.')
  }
}

/** Concrete read-only bindings for the injected MCP registry seam. No listener or auth is added. */
export function createPathfinderMcpReadActions(
  db: ReadDb,
  unavailableWriteActions: Omit<PathfinderMcpDomainActions, 'read'>,
): PathfinderMcpDomainActions {
  return {
    ...unavailableWriteActions,
    read: (input, context) => readMcpResource(db, input, context),
  }
}

export async function readMcpResource(
  db: ReadDb,
  input: McpReadInput,
  context: VerifiedMcpInvocationContext,
): Promise<McpToolResult> {
  assertExactScope(input, context)
  const limit = Math.min(input.limit, MAX_PAGE_SIZE)
  const cursor = decodeMcpReadCursor(input.cursor, input.resource)

  switch (input.resource) {
    case 'clients':
      rejectCursor(cursor, input.resource)
      return readClient(db, context.credential.tenantId)
    case 'venues':
      return readVenues(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'configuration':
      rejectCursor(cursor, input.resource)
      return readConfiguration(db, context.credential.tenantId, input.venueId!)
    case 'content':
      return readApprovedContent(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'history':
      return readHistory(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'packages':
      return readPackages(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'support':
      return readSupport(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'updates':
      return readUpdates(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'ai-usage':
      return readAiUsage(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'jobs':
      return readJobs(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'evaluations':
      return readEvaluations(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'readiness':
      rejectCursor(cursor, input.resource)
      return readReadiness(db, context.credential.tenantId, input.venueId!)
    default:
      throw new McpReadBindingError(
        'RESOURCE_UNAVAILABLE',
        'The requested resource is unavailable.',
      )
  }
}

function assertExactScope(input: McpReadInput, context: VerifiedMcpInvocationContext): void {
  const { credential } = context
  if (credential.clientId !== credential.tenantId || input.clientId !== credential.tenantId) {
    throw new McpReadBindingError(
      'SCOPE_INVARIANT',
      'Verified tenant and client scope do not match.',
    )
  }
  if (input.resource !== 'clients' && !input.venueId) {
    throw new McpReadBindingError('SCOPE_INVARIANT', 'This resource requires exact venue scope.')
  }
  if (input.venueId && !credential.venueIds.includes(input.venueId)) {
    throw new McpReadBindingError('SCOPE_INVARIANT', 'Verified venue scope does not match.')
  }
}

function rejectCursor(cursor: CursorPayload | undefined, resource: ReadResource): void {
  if (cursor) {
    throw new McpReadBindingError('INVALID_CURSOR', `${resource} does not accept a cursor.`)
  }
}

function cursorWhere(cursor: CursorPayload | undefined, field: 'createdAt' | 'updatedAt' | 'date') {
  if (!cursor) return {}
  const sortAt = new Date(cursor.sortAt)
  return { OR: [{ [field]: { lt: sortAt } }, { [field]: sortAt, id: { lt: cursor.id } }] }
}

function page<T extends { id: string }>(
  resource: ReadResource,
  rows: readonly T[],
  limit: number,
  sortAt: (row: T) => Date,
) {
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeMcpReadCursor({ resource, sortAt: sortAt(last).toISOString(), id: last.id })
        : null,
  }
}

async function readClient(db: ReadDb, tenantId: string): Promise<McpToolResult> {
  const client = await db.tenant.findFirst({
    where: { id: tenantId },
    select: {
      id: true,
      name: true,
      slug: true,
      planTier: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  return result(
    'clients',
    client
      ? {
          ...client,
          createdAt: client.createdAt.toISOString(),
          updatedAt: client.updatedAt.toISOString(),
        }
      : null,
  )
}

async function readVenues(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.venue.findMany({
    where: { tenantId, id: venueId, ...cursorWhere(cursor, 'createdAt') },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      name: true,
      slug: true,
      category: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  return result('venues', mapPage(page('venues', rows, limit, (row) => row.createdAt)))
}

async function readConfiguration(
  db: ReadDb,
  tenantId: string,
  venueId: string,
): Promise<McpToolResult> {
  const venue = await db.venue.findFirst({
    where: { id: venueId, tenantId },
    select: {
      id: true,
      aiTone: true,
      tonePreset: true,
      tonePresetVersion: true,
      aiGuideName: true,
      chatTheme: true,
      chatAccentColor: true,
      chatFont: true,
      guideMode: true,
      defaultCenterLat: true,
      defaultCenterLng: true,
      isActive: true,
      updatedAt: true,
    },
  })
  return result(
    'configuration',
    venue ? normalizeRecord({ ...venue, updatedAt: venue.updatedAt.toISOString() }) : null,
  )
}

async function readApprovedContent(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const where = { tenantId, venueId, ...cursorWhere(cursor, 'createdAt') }
  const [places, knowledge] = await Promise.all([
    db.place.findMany({
      where: { ...where, isActive: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        name: true,
        type: true,
        itemType: true,
        shortDescription: true,
        longDescription: true,
        lat: true,
        lng: true,
        tags: true,
        areaName: true,
        hours: true,
        sourceType: true,
        authorship: true,
        sourceName: true,
        lastReviewedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    db.venueKnowledgeEntry.findMany({
      where: { ...where, isEnabled: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        title: true,
        category: true,
        content: true,
        sourceType: true,
        authorship: true,
        sourceName: true,
        lastReviewedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ])
  const merged = [
    ...places.map((row) => ({ ...row, contentKind: 'place' as const })),
    ...knowledge.map((row) => ({ ...row, contentKind: 'knowledge' as const })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
  return result('content', mapPage(page('content', merged, limit, (row) => row.createdAt)))
}

async function readHistory(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.contentVersion.findMany({
    where: { tenantId, venueId, ...cursorWhere(cursor, 'createdAt') },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      entityType: true,
      entityId: true,
      operation: true,
      venuePackageId: true,
      venuePackageAction: true,
      snapshotSchemaVersion: true,
      createdAt: true,
    },
  })
  return result('history', mapPage(page('history', rows, limit, (row) => row.createdAt)))
}

async function readPackages(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.venuePackage.findMany({
    where: { tenantId, venueId, ...cursorWhere(cursor, 'createdAt') },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      schemaVersion: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      approvedAt: true,
      appliedAt: true,
      revertedAt: true,
    },
  })
  return result('packages', mapPage(page('packages', rows, limit, (row) => row.createdAt)))
}

async function readSupport(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.supportRequest.findMany({
    where: { tenantId, venueId, ...cursorWhere(cursor, 'updatedAt') },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      category: true,
      status: true,
      subject: true,
      version: true,
      statusChangedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  return result('support', mapPage(page('support', rows, limit, (row) => row.updatedAt)))
}

async function readUpdates(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.operationalUpdate.findMany({
    where: { tenantId, venueId, ...cursorWhere(cursor, 'createdAt') },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      placeId: true,
      updateType: true,
      severity: true,
      priority: true,
      title: true,
      body: true,
      startsAt: true,
      expiresAt: true,
      status: true,
      isActive: true,
      publishedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  return result('updates', mapPage(page('updates', rows, limit, (row) => row.createdAt)))
}

async function readAiUsage(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.aiUsageDailyRollup.findMany({
    where: { tenantId, venueId, ...cursorWhere(cursor, 'date') },
    orderBy: [{ date: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      date: true,
      feature: true,
      requestCount: true,
      successfulRequestCount: true,
      failedRequestCount: true,
      inputTokens: true,
      outputTokens: true,
      cacheCreationInputTokens: true,
      cacheReadInputTokens: true,
      totalTokens: true,
      estimatedCostUsd: true,
    },
  })
  const paged = page('ai-usage', rows, limit, (row) => row.date)
  return result('ai-usage', {
    ...paged,
    items: paged.items.map((row) => ({
      ...row,
      date: row.date.toISOString(),
      estimatedCostUsd: row.estimatedCostUsd.toString(),
    })),
  })
}

async function readJobs(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.jobRecord.findMany({
    where: {
      tenantId,
      payload: { path: ['venueId'], equals: venueId },
      ...cursorWhere(cursor, 'createdAt'),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      queue: true,
      jobName: true,
      status: true,
      attemptNumber: true,
      maxAttempts: true,
      failureDisposition: true,
      terminalAt: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
    },
  })
  return result('jobs', mapPage(page('jobs', rows, limit, (row) => row.createdAt)))
}

async function readEvaluations(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.evalRun.findMany({
    where: { tenantId, venueId, ...cursorWhere(cursor, 'createdAt') },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      promptContractVersion: true,
      modelProvider: true,
      modelName: true,
      declaredBudgetCeilingE8Usd: true,
      triggerType: true,
      status: true,
      attemptNumber: true,
      maxAttempts: true,
      startedAt: true,
      completedAt: true,
      cancellationRequestedAt: true,
      createdAt: true,
    },
  })
  const paged = page('evaluations', rows, limit, (row) => row.createdAt)
  return result('evaluations', {
    ...paged,
    items: paged.items.map((row) =>
      normalizeRecord({
        ...row,
        declaredBudgetCeilingE8Usd: row.declaredBudgetCeilingE8Usd.toString(),
      }),
    ),
  })
}

async function readReadiness(
  db: ReadDb,
  tenantId: string,
  venueId: string,
): Promise<McpToolResult> {
  const [venue, activePlaces, enabledKnowledge, reporting] = await Promise.all([
    db.venue.findFirst({
      where: { id: venueId, tenantId },
      select: { id: true, isActive: true, name: true, slug: true, updatedAt: true },
    }),
    db.place.count({ where: { tenantId, venueId, isActive: true } }),
    db.venueKnowledgeEntry.count({ where: { tenantId, venueId, isEnabled: true } }),
    db.venueReportConfiguration.findFirst({
      where: { tenantId, venueId },
      select: { enabled: true, updatedAt: true },
    }),
  ])
  return result(
    'readiness',
    venue
      ? {
          venueId: venue.id,
          venueActive: venue.isActive,
          activePlaceCount: activePlaces,
          enabledKnowledgeCount: enabledKnowledge,
          reportingEnabled: reporting?.enabled ?? false,
          readyForPreview: venue.isActive && activePlaces + enabledKnowledge > 0,
          updatedAt: venue.updatedAt.toISOString(),
        }
      : null,
  )
}

function mapPage<T extends Record<string, unknown>>(value: {
  items: readonly T[]
  nextCursor: string | null
}) {
  return {
    ...value,
    items: value.items.map(normalizeRecord),
  }
}

function normalizeRecord(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([key]) => !FORBIDDEN_EXTERNAL_FIELDS.has(key))
      .map(([key, item]) => [
        key,
        item instanceof Date
          ? item.toISOString()
          : typeof item === 'bigint'
            ? item.toString()
            : item,
      ]),
  )
}

function result(resource: ReadResource, data: unknown): McpToolResult {
  return {
    kind: `pathfinder.${resource}`,
    summary: `Authorized ${resource} read completed.`,
    data: data as McpToolResult['data'],
  }
}
