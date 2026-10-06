import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { buildVenueAccessArtifacts } from '@pathfinder/contracts/venue-access-artifacts'
import { venueSlugHeldByOtherTenant } from '@pathfinder/db'

import { parseExactOrigin } from '../config'
import {
  assertTenantInGrant,
  assertVenueInGrant,
  buildOperatorReadScope,
  OperatorNotFoundError,
} from '../grants'
import type { OperatorReadTool } from '../registry'
import { pageResult, requireCursorInScope } from './page'

const PAGE_SIZE = 25

const venuesList: OperatorReadTool = {
  name: 'venues.list',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['venues.list'].parse(raw)
    // Tenant membership in the grant is checked first; the query then carries an explicit tenant
    // predicate and an id cursor, so no venue is hidden behind a fixed service cap.
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    await requireCursorInScope(input.cursor, (id) =>
      context.database.venue.findFirst({
        where: { id, tenantId: input.tenantId },
        select: { id: true },
      }),
    )
    const rows = await context.database.venue.findMany({
      where: { tenantId: input.tenantId },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      select: { id: true, name: true, slug: true, isActive: true, updatedAt: true },
    })
    const page = rows.slice(0, PAGE_SIZE)
    return pageResult(
      page.map((venue) => ({
        venueId: venue.id,
        tenantId: input.tenantId,
        name: venue.name.slice(0, 120),
        slug: venue.slug.slice(0, 200),
        status: venue.isActive ? 'active' : 'inactive',
        updatedAt: venue.updatedAt.toISOString(),
      })),
      rows.length > PAGE_SIZE ? page.at(-1)!.id : null,
    )
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

/**
 * The public visitor chatbot link, built exactly as the dashboard's Visitor access page builds it,
 * with every reason it would not open this venue's working guide right now.
 */
const venuesGetGuestLink: OperatorReadTool = {
  name: 'venues.get_guest_link',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['venues.get_guest_link'].parse(raw)
    await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
    const venue = await context.database.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: { id: true, slug: true, isActive: true },
    })
    if (!venue) throw new OperatorNotFoundError()
    const configured = process.env.NEXT_PUBLIC_WEB_URL
    const origin = configured ? parseExactOrigin(configured) : null
    const artifacts = origin ? buildVenueAccessArtifacts(origin, venue.slug) : null
    const [knowledge, places, shared] = await Promise.all([
      context.database.venueKnowledgeEntry.count({
        where: {
          tenantId: input.tenantId,
          venueId: venue.id,
          isEnabled: true,
          visibility: 'PUBLIC',
        },
      }),
      context.database.place.count({
        where: {
          tenantId: input.tenantId,
          venueId: venue.id,
          isActive: true,
          visibility: 'PUBLIC',
        },
      }),
      venueSlugHeldByOtherTenant(context.database, input.tenantId, venue.slug),
    ])
    const blockers: Array<{ code: string; detail: string; nextAction: string }> = []
    if (!artifacts) {
      blockers.push({
        code: 'GUEST_ORIGIN_UNCONFIGURED',
        detail: 'This deployment has no exact https guest web origin (NEXT_PUBLIC_WEB_URL).',
        nextAction: 'Ask the deployment owner to set NEXT_PUBLIC_WEB_URL on the dashboard service.',
      })
    }
    if (!venue.isActive) {
      blockers.push({
        code: 'VENUE_NOT_PUBLISHED',
        detail: 'The venue is a draft, so the link shows an unavailable page.',
        nextAction: 'Call venues.propose_publish with the venue updatedAt from venues.list.',
      })
    }
    if (knowledge + places === 0) {
      blockers.push({
        code: 'NO_GUEST_CONTENT',
        detail: 'No enabled public knowledge or places, so the guide has nothing to answer from.',
        nextAction:
          'Import content with venues.propose_package_import or venues.propose_knowledge.',
      })
    }
    if (shared) {
      blockers.push({
        code: 'SLUG_SHARED',
        detail: "Another customer's venue has the same slug, so this link may open their guide.",
        nextAction: 'Ask a person to give one of the two venues a different slug in the dashboard.',
      })
    }
    return {
      venueId: venue.id,
      slug: venue.slug,
      isActive: venue.isActive,
      publicUrl: artifacts?.publicUrl ?? null,
      qrUrl: artifacts?.qrUrl ?? null,
      usable: blockers.length === 0,
      blockers,
    }
  },
}

export const venueReadTools: readonly OperatorReadTool[] = [
  venuesList,
  venuesGetReadiness,
  venuesGetGuestLink,
]
