import { z } from 'zod'

import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import { buildOperatorReadScope, OperatorNotFoundError } from '../grants'
import type { OperatorReadTool } from '../registry'

const PAGE_SIZE = 25
/** The existing venue list service returns at most this many venues per call and has no cursor. */
const SERVICE_LIMIT = 100

// The service has no cursor, so a page position is an offset into its (creation-ordered) list.
const OffsetCursor = z
  .string()
  .regex(/^o:\d{1,3}$/u, 'Invalid cursor')
  .transform((value) => Number(value.slice(2)))

type ServiceVenue = {
  id: string
  name: string
  slug: string
  isActive: boolean
  updatedAt: string
}

const venuesList: OperatorReadTool = {
  name: 'venues.list',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['venues.list'].parse(raw)
    const offset = input.cursor === undefined ? 0 : OffsetCursor.parse(input.cursor)
    const scope = await buildOperatorReadScope(
      context.grant,
      input.tenantId,
      ['venues:read'],
      context.database,
    )
    // The existing service is client-scoped: it refuses a credential that names venues.
    const read = await context.venueRead(
      'torchiko.venues.list',
      { clientId: input.tenantId, limit: SERVICE_LIMIT },
      { ...scope, venueIds: [] },
    )
    const venues = (read.data as { venues?: ServiceVenue[] }).venues ?? []
    const page = venues.slice(offset, offset + PAGE_SIZE)
    return {
      items: page.map((venue) => ({
        venueId: venue.id,
        tenantId: input.tenantId,
        name: venue.name.slice(0, 120),
        slug: venue.slug.slice(0, 200),
        status: venue.isActive ? 'active' : 'inactive',
        updatedAt: venue.updatedAt,
      })),
      nextCursor: offset + PAGE_SIZE < venues.length ? `o:${offset + PAGE_SIZE}` : null,
    }
  },
}

type ReadinessData = {
  venueActive?: boolean
  activePlaceCount?: number
  enabledKnowledgeCount?: number
  reportingEnabled?: boolean
  readyForPreview?: boolean
  contentConvergence?: { available?: boolean; phase?: string }
  nativeGuestRead?: { readyForConfiguredMode?: boolean; path?: string }
}

const venuesGetReadiness: OperatorReadTool = {
  name: 'venues.get_readiness',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['venues.get_readiness'].parse(raw)
    const scope = await buildOperatorReadScope(
      context.grant,
      input.tenantId,
      ['resources:read', 'readiness:read'],
      context.database,
    )
    if (!scope.venueIds.includes(input.venueId)) throw new OperatorNotFoundError()
    // The existing readiness read service, called directly with the per-call read-only scope.
    const { readMcpResource } = await import('../../mcp/read-actions')
    const read = await readMcpResource(
      context.database as unknown as Parameters<typeof readMcpResource>[0],
      { clientId: input.tenantId, venueId: input.venueId, resource: 'readiness', limit: 25 },
      { credential: scope },
    )
    const data = read.data as ReadinessData | null
    if (!data) throw new OperatorNotFoundError()

    const places = data.activePlaceCount ?? 0
    const knowledge = data.enabledKnowledgeCount ?? 0
    const converged =
      data.contentConvergence?.available === true &&
      data.contentConvergence.phase === 'NATIVE_HEAD_IN_SYNC'
    const checks = [
      {
        key: 'venue_active',
        passed: data.venueActive === true,
        detail: data.venueActive === true ? 'Venue is active.' : 'Venue is not active.',
      },
      {
        key: 'has_content',
        passed: places + knowledge > 0,
        detail: `${places} active places and ${knowledge} enabled knowledge entries.`,
      },
      {
        key: 'preview_ready',
        passed: data.readyForPreview === true,
        detail: data.readyForPreview === true ? 'Ready for preview.' : 'Not ready for preview.',
      },
      {
        key: 'content_converged',
        passed: converged,
        detail: data.contentConvergence?.available
          ? `Content phase ${String(data.contentConvergence.phase ?? 'unknown').slice(0, 60)}.`
          : 'Content convergence could not be measured.',
      },
      {
        key: 'guest_read_ready',
        passed: data.nativeGuestRead?.readyForConfiguredMode === true,
        detail: `Guest read path ${String(data.nativeGuestRead?.path ?? 'unknown').slice(0, 60)}.`,
      },
      {
        key: 'reporting_enabled',
        passed: data.reportingEnabled === true,
        detail: data.reportingEnabled === true ? 'Reporting is on.' : 'Reporting is off.',
      },
    ]
    // Launch-ready means the first five hold. Reporting is informational.
    const ready = checks.slice(0, 5).every((check) => check.passed)
    return { venueId: input.venueId, ready, checks }
  },
}

export const venueReadTools: readonly OperatorReadTool[] = [venuesList, venuesGetReadiness]
