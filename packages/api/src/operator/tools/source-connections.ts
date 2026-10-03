import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { SOURCE_CONNECTION_PROVIDER } from '@pathfinder/contracts/source-connections'

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
} as const

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
}) {
  return {
    connectorId: row.id,
    name: row.name,
    state: row.state,
    updatedAt: row.updatedAt.toISOString(),
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastErrorCategory: row.lastErrorCategory,
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
        orderBy: { id: 'asc' },
        take: 20,
      })
      return { connections: rows.map(summary) }
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
      return {
        untrusted: true,
        ...summary(row),
        configurationJson: JSON.stringify(row.mapping),
        previewJson: row.lastTestPreview === null ? null : JSON.stringify(row.lastTestPreview),
        snapshotJson: row.observation ? JSON.stringify(row.observation.values) : null,
      }
    },
  },
]
