import type { Prisma } from '@prisma/client'

import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  normalizeProspectDomain,
  normalizeProspectEmail,
  normalizeProspectName,
} from '@pathfinder/db'

import {
  operatorContactView,
  operatorOrganizationVersion,
  operatorUntrustedText,
  redactAddresses,
  type SnapshotContactInput,
} from '../crm-projection'
import { grantCoversTenant, OperatorNotFoundError } from '../grants'
import type { OperatorCallContext, OperatorReadTool } from '../registry'
import { blockedAddressesAnywhere } from './crm'
import { loadOutreach, organizationSelect, projectOrganization } from './crm-data'
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  OperatorInvalidCursorError,
  pageResult,
  requireCursorInScope,
} from './page'

type Database = OperatorCallContext['database']

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null)
const cut = (value: string | null, max: number) =>
  value === null ? null : value.length > max ? value.slice(0, max) : value

// ---------------------------------------------------------------------------
// crm.resolve_account
// ---------------------------------------------------------------------------

type Strength = 'exact' | 'contains' | 'partial'
const STRENGTH_RANK: Record<Strength, number> = { exact: 0, contains: 1, partial: 2 }
type MatchedOn = 'name' | 'alias' | 'domain' | 'email' | 'venue_name' | 'venue_domain'

type Evidence = { matchedOn: Set<MatchedOn>; strength: Strength; alias: string | null }

/** Candidates beyond this are not loaded; the answer then says it is not complete. */
const RESOLVE_CANDIDATE_CAP = 100
const ALIAS_SCAN_BATCH = 500
/** Only organizations that actually carry aliases are scanned, so this is a generous ceiling. */
const ALIAS_SCAN_CAP = 20_000

function note(
  into: Map<string, Evidence>,
  id: string,
  on: MatchedOn,
  strength: Strength,
  alias?: string,
) {
  const current = into.get(id)
  if (!current) {
    into.set(id, { matchedOn: new Set([on]), strength, alias: alias ?? null })
    return
  }
  current.matchedOn.add(on)
  if (STRENGTH_RANK[strength] < STRENGTH_RANK[current.strength]) current.strength = strength
  if (alias && current.alias === null) current.alias = alias
}

/** Aliases live in a JSON array, so organizations that have any are compared in code. */
async function scanAliases(
  database: Database,
  normalized: string,
  into: Map<string, Evidence>,
): Promise<boolean> {
  let cursor: string | undefined
  let scanned = 0
  for (;;) {
    const rows = await database.prospectOrganization.findMany({
      where: { NOT: { aliases: { equals: [] } } },
      orderBy: { id: 'asc' },
      take: ALIAS_SCAN_BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, aliases: true },
    })
    for (const row of rows) {
      const aliases = Array.isArray(row.aliases) ? row.aliases : []
      for (const alias of aliases) {
        if (typeof alias !== 'string') continue
        const candidate = normalizeProspectName(alias)
        if (!candidate) continue
        if (candidate === normalized) note(into, row.id, 'alias', 'exact', alias)
        else if (candidate.includes(normalized) || normalized.includes(candidate)) {
          note(into, row.id, 'alias', 'contains', alias)
        }
      }
    }
    scanned += rows.length
    if (rows.length < ALIAS_SCAN_BATCH) return true
    if (scanned >= ALIAS_SCAN_CAP) return false
    cursor = rows.at(-1)!.id
  }
}

const resolveAccount: OperatorReadTool = {
  name: 'crm.resolve_account',
  capability: 'crm:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['crm.resolve_account'].parse(raw)
    const database = context.database
    const evidence = new Map<string, Evidence>()
    let complete = true

    const normalizedName = input.name ? normalizeProspectName(input.name) : null
    const normalizedDomain = normalizeProspectDomain(input.domain)
    const normalizedEmail = normalizeProspectEmail(input.email)
    if (input.name && !normalizedName) complete = false

    if (normalizedName) {
      const tokens = normalizedName.split(' ').filter((token) => token.length >= 3)
      const [exact, contains, partial, venueExact, venueContains] = await Promise.all([
        database.prospectOrganization.findMany({
          where: { normalizedName },
          take: RESOLVE_CANDIDATE_CAP,
          select: { id: true },
        }),
        database.prospectOrganization.findMany({
          where: { canonicalName: { contains: input.name!, mode: 'insensitive' } },
          take: RESOLVE_CANDIDATE_CAP,
          select: { id: true },
        }),
        tokens.length > 1
          ? database.prospectOrganization.findMany({
              where: {
                AND: tokens.map((token) => ({
                  canonicalName: { contains: token, mode: 'insensitive' as const },
                })),
              },
              take: RESOLVE_CANDIDATE_CAP,
              select: { id: true },
            })
          : Promise.resolve([] as { id: string }[]),
        database.prospectVenue.findMany({
          where: { normalizedName },
          take: RESOLVE_CANDIDATE_CAP,
          select: { organizationId: true },
        }),
        database.prospectVenue.findMany({
          where: { name: { contains: input.name!, mode: 'insensitive' } },
          take: RESOLVE_CANDIDATE_CAP,
          select: { organizationId: true },
        }),
      ])
      for (const row of exact) note(evidence, row.id, 'name', 'exact')
      for (const row of contains) note(evidence, row.id, 'name', 'contains')
      for (const row of partial) note(evidence, row.id, 'name', 'partial')
      for (const row of venueExact) note(evidence, row.organizationId, 'venue_name', 'exact')
      for (const row of venueContains) note(evidence, row.organizationId, 'venue_name', 'contains')
      if (
        [exact, contains, partial, venueExact, venueContains].some(
          (rows) => rows.length >= RESOLVE_CANDIDATE_CAP,
        )
      ) {
        complete = false
      }
      if (!(await scanAliases(database, normalizedName, evidence))) complete = false
    }
    if (normalizedDomain) {
      const [orgs, venues] = await Promise.all([
        database.prospectOrganization.findMany({
          where: { normalizedDomain },
          take: RESOLVE_CANDIDATE_CAP,
          select: { id: true },
        }),
        database.prospectVenue.findMany({
          where: { normalizedDomain },
          take: RESOLVE_CANDIDATE_CAP,
          select: { organizationId: true },
        }),
      ])
      for (const row of orgs) note(evidence, row.id, 'domain', 'exact')
      for (const row of venues) note(evidence, row.organizationId, 'venue_domain', 'exact')
      if (orgs.length >= RESOLVE_CANDIDATE_CAP || venues.length >= RESOLVE_CANDIDATE_CAP) {
        complete = false
      }
    }
    if (normalizedEmail) {
      // Archived contact rows count: an old address is still how that account is known.
      const contacts = await database.prospectContact.findMany({
        where: { normalizedEmail },
        take: RESOLVE_CANDIDATE_CAP,
        select: { organizationId: true },
      })
      for (const row of contacts) note(evidence, row.organizationId, 'email', 'exact')
      if (contacts.length >= RESOLVE_CANDIDATE_CAP) complete = false
    }

    const ids = [...evidence.keys()]
    if (ids.length === 0) {
      return {
        resolution: 'none' as const,
        candidates: [],
        complete,
        nextAction:
          'No account matched. Try a domain or an email address, check the spelling, or ask the user.',
      }
    }

    const [orgs, loaded] = await Promise.all([
      database.prospectOrganization.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          archivedAt: true,
          conversion: { select: { tenantId: true, venueId: true, convertedAt: true } },
          customerRelationships: {
            where: { status: 'ACTIVE' },
            orderBy: { startedAt: 'desc' },
            take: 1,
            select: { tenantId: true, startedAt: true },
          },
        },
      }),
      database.prospectOrganization.findMany({
        where: { id: { in: ids } },
        select: organizationSelect,
      }),
    ])
    const [outreach, counts] = await Promise.all([
      loadOutreach(database, ids),
      database.prospectActivity.groupBy({
        by: ['organizationId'],
        where: { organizationId: { in: ids } },
        _count: { _all: true },
      }),
    ])
    const activityCounts = new Map(counts.map((row) => [row.organizationId, row._count._all]))
    const meta = new Map(orgs.map((row) => [row.id, row]))

    const wantCity = input.city?.toLowerCase()
    const wantRegion = input.region?.toLowerCase()
    const candidates = loaded.flatMap((row) => {
      const info = meta.get(row.id)
      if (!info) return []
      const archived = info.archivedAt !== null
      if (archived && !input.includeArchived) return []
      const { record } = projectOrganization(
        row,
        outreach.get(row.id),
        activityCounts.get(row.id) ?? 0,
      )
      const cities = [row.headquartersCity, ...row.venues.map((venue) => venue.city)]
      const regions = [row.headquartersRegion, ...row.venues.map((venue) => venue.region)]
      if (wantCity && !cities.some((city) => city?.toLowerCase().includes(wantCity))) return []
      if (wantRegion && !regions.some((region) => region?.toLowerCase() === wantRegion)) return []
      const found = evidence.get(row.id)!
      const conversion = info.conversion
      const relationship = info.customerRelationships[0]
      const customerTenant = conversion?.tenantId ?? relationship?.tenantId ?? null
      return [
        {
          organizationId: row.id,
          name: cut(redactAddresses(row.canonicalName), 200)!,
          matchedOn: [...found.matchedOn],
          strength: found.strength,
          matchedAlias: cut(found.alias, 200),
          archived,
          type: cut(row.organizationType, 80),
          city: cut(row.headquartersCity ?? row.venues[0]?.city ?? null, 120),
          region: cut(row.headquartersRegion ?? row.venues[0]?.region ?? null, 120),
          stage: (row.opportunity?.stage ?? null) as never,
          contacted: record.outreach.everContacted,
          customer:
            conversion || relationship
              ? {
                  // A customer outside this connection's tenants is shown as linked, not named.
                  tenantId:
                    customerTenant !== null && grantCoversTenant(context.grant, customerTenant)
                      ? customerTenant
                      : null,
                  venueId:
                    conversion?.venueId &&
                    customerTenant !== null &&
                    grantCoversTenant(context.grant, customerTenant)
                      ? conversion.venueId
                      : null,
                  convertedAt: (conversion?.convertedAt ?? relationship!.startedAt).toISOString(),
                }
              : null,
          duplicateReview: record.outreach.duplicateReview,
          venues: row.venues.slice(0, 3).map((venue) => ({
            venueId: venue.id,
            name: cut(redactAddresses(venue.name), 200)!,
            city: cut(venue.city, 120),
            region: cut(venue.region, 120),
          })),
        },
      ]
    })
    candidates.sort(
      (a, b) =>
        STRENGTH_RANK[a.strength] - STRENGTH_RANK[b.strength] ||
        a.name.localeCompare(b.name) ||
        a.organizationId.localeCompare(b.organizationId),
    )
    const exact = candidates.filter((candidate) => candidate.strength === 'exact')
    const page = candidates.slice(0, input.limit)
    const truncated = candidates.length > page.length
    const resolution =
      candidates.length === 0
        ? ('none' as const)
        : exact.length === 1
          ? ('unique' as const)
          : ('ambiguous' as const)
    return {
      resolution,
      candidates: page,
      complete: complete && !truncated,
      nextAction:
        resolution === 'unique'
          ? 'One exact match. Open it with crm.get_account_context before acting on it.'
          : resolution === 'none'
            ? 'No account matched the location filter or the input. Widen it, or ask the user.'
            : 'More than one account could be meant. Ask the user which one (compare city, region, type and venues). Do not guess.',
    }
  },
}

// ---------------------------------------------------------------------------
// crm.get_account_context
// ---------------------------------------------------------------------------

/** The summary the note actions write. Other NOTE_ADDED rows record field updates, not notes. */
const NOTE_SUMMARY = 'Operator note added'

const CONTEXT_VENUES = 25
const CONTEXT_CAMPAIGNS = 10
const CONTEXT_DUPLICATES = 10
const CONTACT_SCAN_CAP = 5_000

const SUPPRESSED_CONTACT: Prisma.ProspectContactWhereInput = {
  OR: [
    { doNotContact: true },
    { suppressedAt: { not: null } },
    { unsubscribedAt: { not: null } },
    { complainedAt: { not: null } },
    { lastHardBounceAt: { not: null } },
    { permissionState: { in: ['OPTED_OUT', 'PROHIBITED'] } },
  ],
}

const getAccountContext: OperatorReadTool = {
  name: 'crm.get_account_context',
  capability: 'crm:read',
  async handler(raw, context) {
    const { organizationId } = OPERATOR_MCP_INPUTS['crm.get_account_context'].parse(raw)
    const database = context.database
    const row = await database.prospectOrganization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        canonicalName: true,
        aliases: true,
        website: true,
        normalizedDomain: true,
        organizationType: true,
        headquartersCity: true,
        headquartersRegion: true,
        relationshipTier: true,
        notes: true,
        archivedAt: true,
        updatedAt: true,
        opportunity: {
          select: {
            stage: true,
            priority: true,
            ownerId: true,
            nextAction: true,
            nextActionAt: true,
            lastActivityAt: true,
            updatedAt: true,
          },
        },
        conversion: { select: { tenantId: true, venueId: true, convertedAt: true } },
        customerRelationships: {
          where: { status: 'ACTIVE' },
          orderBy: { startedAt: 'desc' },
          take: 1,
          select: { tenantId: true, startedAt: true },
        },
        venues: {
          orderBy: { id: 'asc' },
          take: CONTEXT_VENUES + 1,
          select: {
            id: true,
            name: true,
            venueType: true,
            city: true,
            region: true,
            country: true,
            estimatedSize: true,
            archivedAt: true,
            updatedAt: true,
          },
        },
      },
    })
    if (!row) throw new OperatorNotFoundError()

    const [
      venueCount,
      activityCount,
      noteCount,
      outreach,
      contactRows,
      archivedContacts,
      memberRows,
      memberCount,
      duplicateRows,
    ] = await Promise.all([
      database.prospectVenue.count({ where: { organizationId } }),
      database.prospectActivity.count({ where: { organizationId } }),
      database.prospectActivity.count({
        where: { organizationId, type: 'NOTE_ADDED', summary: NOTE_SUMMARY },
      }),
      loadOutreach(database, [organizationId]),
      database.prospectContact.findMany({
        where: { organizationId, archivedAt: null },
        orderBy: { id: 'asc' },
        take: CONTACT_SCAN_CAP,
        select: {
          id: true,
          venueId: true,
          fullName: true,
          title: true,
          email: true,
          phone: true,
          emailReadiness: true,
          permissionState: true,
          doNotContact: true,
          suppressionReason: true,
          suppressedAt: true,
          unsubscribedAt: true,
          complainedAt: true,
          lastHardBounceAt: true,
        },
      }),
      database.prospectContact.count({ where: { organizationId, archivedAt: { not: null } } }),
      database.prospectCampaignMember.findMany({
        where: { organizationId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: CONTEXT_CAMPAIGNS + 1,
        select: {
          id: true,
          campaignId: true,
          status: true,
          campaign: { select: { name: true, status: true } },
        },
      }),
      database.prospectCampaignMember.count({ where: { organizationId } }),
      database.prospectDuplicateCandidate.findMany({
        where: {
          status: { in: ['OPEN', 'CONFIRMED_DUPLICATE'] },
          OR: [{ organizationAId: organizationId }, { organizationBId: organizationId }],
        },
        orderBy: [{ confidence: 'desc' }, { id: 'asc' }],
        take: CONTEXT_DUPLICATES + 1,
        select: {
          status: true,
          confidence: true,
          organizationAId: true,
          organizationBId: true,
          organizationA: { select: { canonicalName: true } },
          organizationB: { select: { canonicalName: true } },
        },
      }),
    ])
    const suppressedCount = await database.prospectContact.count({
      where: { organizationId, archivedAt: null, ...SUPPRESSED_CONTACT },
    })
    const blocked = await blockedAddressesAnywhere(
      database,
      contactRows
        .map((contact) => contact.email)
        .filter((email): email is string => Boolean(email)),
    )
    const contactable = contactRows.filter(
      (contact) => operatorContactView(contact as SnapshotContactInput, blocked).contactable,
    ).length
    const thread = outreach.get(organizationId)!
    const conversion = row.conversion
    const relationship = row.customerRelationships[0]
    const customerTenant = conversion?.tenantId ?? relationship?.tenantId ?? null
    const covered = customerTenant !== null && grantCoversTenant(context.grant, customerTenant)
    const aliases = (Array.isArray(row.aliases) ? row.aliases : [])
      .filter((alias): alias is string => typeof alias === 'string')
      .slice(0, 25)
      .map((alias) => cut(redactAddresses(alias), 200)!)
    const observed = [
      row.updatedAt,
      row.opportunity?.updatedAt,
      ...row.venues.map((venue) => venue.updatedAt),
    ]
      .filter((value): value is Date => value instanceof Date)
      .map((value) => value.getTime())

    return {
      organization: {
        organizationId: row.id,
        name: cut(redactAddresses(row.canonicalName), 200)!,
        aliases,
        website: cut(row.website, 500),
        domain: cut(row.normalizedDomain, 253),
        type: cut(row.organizationType, 80),
        city: cut(row.headquartersCity, 120),
        region: cut(row.headquartersRegion, 120),
        relationshipTier: row.relationshipTier,
        archived: row.archivedAt !== null,
        version: operatorOrganizationVersion(activityCount),
        note: row.notes ? operatorUntrustedText(redactAddresses(row.notes)) : null,
      },
      opportunity: {
        stage: (row.opportunity?.stage ?? null) as never,
        priority: row.opportunity?.priority ?? null,
        ownerId: cut(row.opportunity?.ownerId ?? null, 191),
        nextAction: row.opportunity?.nextAction
          ? operatorUntrustedText(redactAddresses(row.opportunity.nextAction))
          : null,
        nextActionAt: iso(row.opportunity?.nextActionAt),
        lastActivityAt: iso(row.opportunity?.lastActivityAt),
      },
      customer:
        conversion || relationship
          ? {
              tenantId: covered ? customerTenant : null,
              venueId: covered ? (conversion?.venueId ?? null) : null,
              convertedAt: (conversion?.convertedAt ?? relationship!.startedAt).toISOString(),
            }
          : null,
      venues: row.venues.slice(0, CONTEXT_VENUES).map((venue) => ({
        venueId: venue.id,
        name: cut(redactAddresses(venue.name), 200)!,
        type: cut(venue.venueType, 80),
        city: cut(venue.city, 120),
        region: cut(venue.region, 120),
        country: cut(venue.country, 80),
        estimatedSize: cut(venue.estimatedSize, 10),
        archived: venue.archivedAt !== null,
      })),
      venueCount,
      contacts: {
        total: contactRows.length,
        contactable,
        suppressed: suppressedCount,
        archived: archivedContacts,
      },
      campaigns: memberRows.slice(0, CONTEXT_CAMPAIGNS).map((member) => ({
        campaignId: member.campaignId,
        campaignMemberId: member.id,
        name: cut(member.campaign.name, 191)!,
        campaignStatus: member.campaign.status,
        memberStatus: member.status,
      })),
      campaignCount: memberCount,
      duplicates: duplicateRows.slice(0, CONTEXT_DUPLICATES).map((candidate) => {
        const otherIsB = candidate.organizationAId === organizationId
        return {
          organizationId: otherIsB ? candidate.organizationBId : candidate.organizationAId,
          name: cut(
            redactAddresses(
              (otherIsB ? candidate.organizationB : candidate.organizationA).canonicalName,
            ),
            200,
          )!,
          status: candidate.status,
          confidence: candidate.confidence,
        }
      }),
      history: {
        activityCount,
        noteCount,
        inboundMessages: thread.inbound.count,
        outboundMessages: thread.outbound.count,
        threads: thread.threadCount,
        lastOutboundAt: iso(thread.outbound.last ?? thread.activity.lastOutreachSentAt),
        lastInboundAt: iso(thread.inbound.last ?? thread.activity.lastReplyReceivedAt),
      },
      truncated: {
        venues: venueCount > CONTEXT_VENUES,
        campaigns: memberCount > CONTEXT_CAMPAIGNS,
        duplicates: duplicateRows.length > CONTEXT_DUPLICATES,
      },
      observedAt: new Date(Math.max(...observed, row.updatedAt.getTime())).toISOString(),
    }
  },
}

// ---------------------------------------------------------------------------
// crm.list_contacts / crm.list_notes
// ---------------------------------------------------------------------------

const listContacts: OperatorReadTool = {
  name: 'crm.list_contacts',
  capability: 'crm:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['crm.list_contacts'].parse(raw)
    const database = context.database
    const org = await database.prospectOrganization.findUnique({
      where: { id: input.organizationId },
      select: { id: true },
    })
    if (!org) throw new OperatorNotFoundError()
    const where: Prisma.ProspectContactWhereInput = {
      organizationId: input.organizationId,
      ...(input.includeArchived ? {} : { archivedAt: null }),
    }
    await requireCursorInScope(input.cursor, (id) =>
      database.prospectContact.findFirst({ where: { AND: [where, { id }] }, select: { id: true } }),
    )
    const rows = await database.prospectContact.findMany({
      where,
      orderBy: { id: 'asc' },
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        venueId: true,
        fullName: true,
        title: true,
        email: true,
        phone: true,
        emailReadiness: true,
        permissionState: true,
        doNotContact: true,
        suppressionReason: true,
        suppressedAt: true,
        unsubscribedAt: true,
        complainedAt: true,
        lastHardBounceAt: true,
        archivedAt: true,
        updatedAt: true,
        notes: true,
      },
    })
    const page = rows.slice(0, input.limit)
    const blocked = await blockedAddressesAnywhere(
      database,
      page.map((contact) => contact.email).filter((email): email is string => Boolean(email)),
    )
    return pageResult(
      page.map((contact) => {
        const view = operatorContactView(contact as SnapshotContactInput, blocked)
        return {
          ...view,
          venueId: contact.venueId,
          archived: contact.archivedAt !== null,
          updatedAt: contact.updatedAt.toISOString(),
          addressBlockedElsewhere:
            contact.email !== null && blocked.has(contact.email.trim().toLowerCase()),
          // A suppressed contact's free text stays private along with its address.
          notes:
            view.contactable && contact.notes
              ? operatorUntrustedText(redactAddresses(contact.notes))
              : null,
        }
      }),
      rows.length > input.limit ? page.at(-1)!.id : null,
    )
  },
}

const listNotes: OperatorReadTool = {
  name: 'crm.list_notes',
  capability: 'crm:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['crm.list_notes'].parse(raw)
    const database = context.database
    const org = await database.prospectOrganization.findUnique({
      where: { id: input.organizationId },
      select: { id: true },
    })
    if (!org) throw new OperatorNotFoundError()
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    if (after) {
      // The cursor must name a note of this account, or it is refused outright.
      const anchor = await database.prospectActivity.findFirst({
        where: {
          id: after.id,
          organizationId: input.organizationId,
          type: 'NOTE_ADDED',
          summary: NOTE_SUMMARY,
        },
        select: { id: true },
      })
      if (!anchor) throw new OperatorInvalidCursorError()
    }
    const rows = await database.prospectActivity.findMany({
      where: {
        organizationId: input.organizationId,
        type: 'NOTE_ADDED',
        summary: NOTE_SUMMARY,
        ...(after
          ? {
              OR: [
                { occurredAt: { lt: after.at } },
                { occurredAt: after.at, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: { id: true, occurredAt: true, summary: true, detail: true },
    })
    const page = rows.slice(0, input.limit)
    return pageResult(
      page.map((entry) => ({
        noteId: entry.id,
        occurredAt: entry.occurredAt.toISOString(),
        text: operatorUntrustedText(redactAddresses(entry.detail ?? entry.summary)),
      })),
      rows.length > input.limit
        ? encodeKeysetCursor(page.at(-1)!.occurredAt, page.at(-1)!.id)
        : null,
    )
  },
}

/** Activity kinds that come from an import or research, not from anything a person did. */
const MACHINE_ACTIVITY_TYPES = [
  'IMPORTED',
  'DISCOVERED',
  'RESEARCH_ADDED',
  'AI_RESEARCH_COMPLETED',
] as const

const listDuplicates: OperatorReadTool = {
  name: 'crm.list_duplicates',
  capability: 'crm:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['crm.list_duplicates'].parse(raw)
    const database = context.database
    const where: Prisma.ProspectDuplicateCandidateWhereInput = {
      ...(input.status ? { status: input.status } : {}),
      ...(input.organizationId
        ? {
            OR: [
              { organizationAId: input.organizationId },
              { organizationBId: input.organizationId },
            ],
          }
        : {}),
    }
    await requireCursorInScope(input.cursor, (id) =>
      database.prospectDuplicateCandidate.findFirst({
        where: { AND: [where, { id }] },
        select: { id: true },
      }),
    )
    const rows = await database.prospectDuplicateCandidate.findMany({
      where,
      orderBy: [{ confidence: 'desc' }, { id: 'asc' }],
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    })
    const page = rows.slice(0, input.limit)
    const ids = [...new Set(page.flatMap((row) => [row.organizationAId, row.organizationBId]))]
    const [orgs, outreach, activityCounts, humanActivity, contactCounts] = await Promise.all([
      database.prospectOrganization.findMany({
        where: { id: { in: ids } },
        select: organizationSelect,
      }),
      loadOutreach(database, ids),
      database.prospectActivity.groupBy({
        by: ['organizationId'],
        where: { organizationId: { in: ids } },
        _count: { _all: true },
      }),
      database.prospectActivity.groupBy({
        by: ['organizationId'],
        where: { organizationId: { in: ids }, type: { notIn: [...MACHINE_ACTIVITY_TYPES] } },
        _count: { _all: true },
      }),
      database.prospectContact.groupBy({
        by: ['organizationId'],
        where: { organizationId: { in: ids }, archivedAt: null },
        _count: { _all: true },
      }),
    ])
    const archivedRows = await database.prospectOrganization.findMany({
      where: { id: { in: ids } },
      select: { id: true, archivedAt: true },
    })
    const archived = new Map(archivedRows.map((row) => [row.id, row.archivedAt !== null]))
    const total = new Map(activityCounts.map((row) => [row.organizationId, row._count._all]))
    const human = new Map(humanActivity.map((row) => [row.organizationId, row._count._all]))
    const contacts = new Map(contactCounts.map((row) => [row.organizationId, row._count._all]))
    const byId = new Map(orgs.map((org) => [org.id, org]))
    const side = (id: string) => {
      const org = byId.get(id)
      if (!org) return null
      const activityCount = total.get(id) ?? 0
      const { record } = projectOrganization(org, outreach.get(id), activityCount)
      return {
        organizationId: id,
        name: cut(redactAddresses(org.canonicalName), 200)!,
        archived: archived.get(id) ?? false,
        stage: (org.opportunity?.stage ?? null) as never,
        contacted: record.outreach.everContacted,
        contactCount: contacts.get(id) ?? 0,
        activityCount,
        importOnly: (human.get(id) ?? 0) === 0,
        version: operatorOrganizationVersion(activityCount),
      }
    }
    return pageResult(
      page.flatMap((row) => {
        const a = side(row.organizationAId)
        const b = side(row.organizationBId)
        if (!a || !b) return []
        const reasons = (Array.isArray(row.reasons) ? row.reasons : [])
          .map((reason) =>
            typeof reason === 'string'
              ? reason
              : reason && typeof reason === 'object' && 'type' in reason
                ? String((reason as { type: unknown }).type)
                : '',
          )
          .filter(Boolean)
          .slice(0, 10)
          .map((reason) => reason.slice(0, 120))
        return [
          {
            candidateId: row.id,
            status: row.status,
            confidence: row.confidence,
            reasons,
            resolutionNote: row.resolutionNote
              ? operatorUntrustedText(redactAddresses(row.resolutionNote))
              : null,
            reviewedAt: iso(row.reviewedAt),
            accounts: [a, b],
          },
        ]
      }),
      rows.length > input.limit ? page.at(-1)!.id : null,
    )
  },
}

export const crmAccountReadTools: readonly OperatorReadTool[] = [
  listDuplicates,
  resolveAccount,
  getAccountContext,
  listContacts,
  listNotes,
]
