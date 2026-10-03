import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { describeSourceConnectionProblem } from '@pathfinder/contracts/source-connection-problems'
import {
  SOURCE_CONNECTION_PROVIDER,
  SourceConnectionConfigSchema,
  SourceConnectionSnapshotSchema,
} from '@pathfinder/contracts/source-connections'
import { readSourceConnectionPreview } from '@pathfinder/db'

import { assertVenueInGrant, OperatorNotFoundError } from '../grants'
import type { OperatorReadTool } from '../registry'

const summarySelect = {
  id: true,
  name: true,
  state: true,
  updatedAt: true,
  lastSuccessAt: true,
  lastErrorCategory: true,
  lastErrorAt: true,
  consecutiveFailures: true,
  lastTestAt: true,
  lastTestOutcome: true,
  lastTestErrorCategory: true,
  mapping: true,
} as const

/** Platform cap on source connections per venue. */
const MAX_CONNECTIONS_PER_VENUE = 20
const MAX_RAW_JSON = { configuration: 65_536, preview: 500_000, snapshot: 500_000 } as const

type Health = 'draft' | 'healthy' | 'failing' | 'paused' | 'never_run'

function readApproval(mapping: unknown) {
  const parsed = SourceConnectionConfigSchema.safeParse(mapping)
  if (parsed.success && parsed.data.approval)
    return { approval: parsed.data.approval, policy: parsed.data.publicationPolicy }
  return { approval: null, policy: null }
}

function healthOf(row: {
  state: string
  consecutiveFailures: number
  lastSuccessAt: Date | null
  mapping: unknown
}): Health {
  const approved = readApproval(row.mapping).approval !== null
  if (row.state === 'DISABLED') return approved ? 'paused' : 'draft'
  if (row.consecutiveFailures > 0) return 'failing'
  return row.lastSuccessAt ? 'healthy' : 'never_run'
}

function boundedJson(value: unknown, max: number): string | null {
  const text = JSON.stringify(value)
  return text.length > max ? null : text
}

function summary(row: {
  id: string
  name: string
  state: string
  updatedAt: Date
  lastSuccessAt: Date | null
  lastErrorCategory: string | null
  lastErrorAt: Date | null
  consecutiveFailures: number
  lastTestAt: Date | null
  lastTestOutcome: string | null
  lastTestErrorCategory: string | null
  mapping: unknown
}) {
  return {
    connectorId: row.id,
    name: row.name,
    state: row.state,
    health: healthOf(row),
    updatedAt: row.updatedAt.toISOString(),
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastErrorCategory: row.lastErrorCategory,
    lastErrorMeaning: row.lastErrorCategory
      ? describeSourceConnectionProblem(row.lastErrorCategory)
      : null,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
    consecutiveFailures: row.consecutiveFailures,
    lastTestAt: row.lastTestAt?.toISOString() ?? null,
    lastTestOutcome: row.lastTestOutcome,
    lastTestErrorCategory: row.lastTestErrorCategory,
  }
}

export const sourceConnectionReadTools: readonly OperatorReadTool[] = [
  {
    name: 'venues.list_source_connections',
    capability: 'venues:read',
    async handler(raw, context) {
      const input = OPERATOR_MCP_INPUTS['venues.list_source_connections'].parse(raw)
      await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
      const rows = await context.database.liveDataConnector.findMany({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          provider: SOURCE_CONNECTION_PROVIDER,
        },
        select: summarySelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: MAX_CONNECTIONS_PER_VENUE,
      })
      return {
        connections: rows.map(summary),
        complete: rows.length < MAX_CONNECTIONS_PER_VENUE,
      }
    },
  },
  {
    name: 'venues.get_source_connection',
    capability: 'venues:read',
    async handler(raw, context) {
      const input = OPERATOR_MCP_INPUTS['venues.get_source_connection'].parse(raw)
      await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
      const row = await context.database.liveDataConnector.findFirst({
        where: {
          id: input.connectorId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          provider: SOURCE_CONNECTION_PROVIDER,
        },
        select: {
          ...summarySelect,
          mapping: true,
          lastTestPreview: true,
          observation: { select: { values: true } },
        },
      })
      if (!row) throw new OperatorNotFoundError()
      const preview = readSourceConnectionPreview(row.lastTestPreview)
      const { approval, policy } = readApproval(row.mapping)
      const snapshot = SourceConnectionSnapshotSchema.safeParse(row.observation?.values)
      const usage =
        row.lastTestPreview &&
        typeof row.lastTestPreview === 'object' &&
        !Array.isArray(row.lastTestPreview)
          ? (row.lastTestPreview as Record<string, unknown>).usage
          : null
      const usageRecord =
        usage && typeof usage === 'object' && !Array.isArray(usage)
          ? (usage as Record<string, unknown>)
          : {}
      const requestsToday =
        usageRecord.day === context.now.toISOString().slice(0, 10) &&
        typeof usageRecord.requests === 'number' &&
        Number.isSafeInteger(usageRecord.requests) &&
        usageRecord.requests >= 0
          ? usageRecord.requests
          : 0
      const configurationJson = boundedJson(row.mapping, MAX_RAW_JSON.configuration)
      const previewJson =
        row.lastTestPreview === null ? null : boundedJson(row.lastTestPreview, MAX_RAW_JSON.preview)
      const snapshotJson = row.observation
        ? boundedJson(row.observation.values, MAX_RAW_JSON.snapshot)
        : null
      return {
        untrusted: true,
        ...summary(row),
        preview: preview
          ? {
              previewId: preview.previewId,
              previewHash: preview.previewHash,
              status: preview.status,
              checkedAt: preview.observedAt,
              recordCount: preview.records.length,
              issues: preview.issues.slice(0, 50).map((code) => ({
                code: code.slice(0, 64),
                meaning: describeSourceConnectionProblem(code),
              })),
              fetches: preview.cost.fetches,
              bytes: preview.cost.bytes,
            }
          : null,
        approval:
          approval && policy
            ? {
                reviewedAt: approval.approvedAt,
                reviewedPreviewHash: approval.approvedPreviewHash,
                policy,
              }
            : null,
        snapshot: snapshot.success
          ? {
              observedAt: snapshot.data.observedAt,
              freshnessExpiresAt: snapshot.data.freshnessExpiresAt,
              recordCount: snapshot.data.records.length,
            }
          : null,
        usage: { llmTokens: 0 as const, networkCostPriced: false as const, requestsToday },
        detailOmitted:
          configurationJson === null ||
          (row.lastTestPreview !== null && previewJson === null) ||
          (row.observation !== null && snapshotJson === null),
        configurationJson,
        previewJson,
        snapshotJson,
      }
    },
  },
]
