import type { Prisma } from '@prisma/client'

import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import {
  blockedAddressSet,
  evaluateCanContact,
  isUncontactedOrganization,
  operatorContactView,
  operatorOrganizationView,
  operatorUntrustedText,
  redactAddresses,
  type SnapshotContactInput,
} from '../crm-projection'
import { OperatorNotFoundError } from '../grants'
import type { OperatorCallContext, OperatorReadTool } from '../registry'
import {
  loadActivityCounts,
  loadOutreach,
  organizationSelect,
  projectOrganization,
  type LoadedOrganization,
} from './crm-data'

const MAX_CONTACTS = 50
const MAX_NOTES = 20
const MAX_HISTORY_EVENTS = 200
const UNCONTACTED_BATCH = 100
/** Bounds the work of one uncontacted scan; the caller continues from `nextCursor`. */
const UNCONTACTED_SCAN_CAP = 1_000

type OrganizationFilters = {
  city?: string | undefined
  region?: string | undefined
  type?: string | undefined
  size?: string | undefined
}

function organizationWhere(
  filters: OrganizationFilters,
  query?: string,
): Prisma.ProspectOrganizationWhereInput {
  const and: Prisma.ProspectOrganizationWhereInput[] = [{ archivedAt: null }]
  const contains = (value: string) => ({ contains: value, mode: 'insensitive' as const })
  const equals = (value: string) => ({ equals: value, mode: 'insensitive' as const })
  if (query) {
    and.push({
      OR: [
        { canonicalName: contains(query) },
        { normalizedDomain: contains(query) },
        { website: contains(query) },
      ],
    })
  }
  if (filters.city) {
    and.push({
      OR: [
        { headquartersCity: contains(filters.city) },
        { venues: { some: { archivedAt: null, city: contains(filters.city) } } },
      ],
    })
  }
  if (filters.region) {
    and.push({
      OR: [
        { headquartersRegion: equals(filters.region) },
        { venues: { some: { archivedAt: null, region: equals(filters.region) } } },
      ],
    })
  }
  if (filters.type) {
    and.push({
      OR: [
        { organizationType: contains(filters.type) },
        { venues: { some: { archivedAt: null, venueType: contains(filters.type) } } },
      ],
    })
  }
  if (filters.size) {
    and.push({ venues: { some: { archivedAt: null, estimatedSize: equals(filters.size) } } })
  }
  return { AND: and }
}

type Database = Parameters<typeof loadOutreach>[0]

async function viewsFor(database: Database, rows: LoadedOrganization[]) {
  const ids = rows.map((row) => row.id)
  const [outreach, counts] = await Promise.all([
    loadOutreach(database, ids),
    loadActivityCounts(database, ids),
  ])
  return rows.map((row) => {
    const { record, version } = projectOrganization(
      row,
      outreach.get(row.id),
      counts.get(row.id) ?? 0,
    )
    return { record, view: operatorOrganizationView(record, version) }
  })
}

async function pageOrganizations(
  database: Database,
  input: {
    where: Prisma.ProspectOrganizationWhereInput
    orderBy: Prisma.ProspectOrganizationOrderByWithRelationInput[]
    limit: number
    cursor: string | undefined
  },
) {
  const rows = await database.prospectOrganization.findMany({
    where: input.where,
    orderBy: input.orderBy,
    take: input.limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: organizationSelect,
  })
  const page = rows.slice(0, input.limit)
  const items = (await viewsFor(database, page)).map((entry) => entry.view)
  return { items, nextCursor: rows.length > input.limit ? page.at(-1)!.id : null }
}

/** Follows the P17 CLI rules (see `isUncontactedOrganization`) over bounded scan windows. */
async function pageUncontacted(
  database: Database,
  input: {
    where: Prisma.ProspectOrganizationWhereInput
    limit: number
    cursor: string | undefined
  },
) {
  const items: ReturnType<typeof operatorOrganizationView>[] = []
  let scanned = 0
  let cursor = input.cursor
  let lastScannedId: string | null = null
  let exhausted = false
  outer: while (scanned < UNCONTACTED_SCAN_CAP) {
    const rows = await database.prospectOrganization.findMany({
      where: input.where,
      orderBy: [{ id: 'asc' }],
      take: UNCONTACTED_BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: organizationSelect,
    })
    if (rows.length === 0) {
      exhausted = true
      break
    }
    const views = await viewsFor(database, rows)
    for (const { record, view } of views) {
      scanned += 1
      lastScannedId = record.id
      if (isUncontactedOrganization(record)) items.push(view)
      if (items.length >= input.limit) {
        exhausted = false
        break outer
      }
    }
    if (rows.length < UNCONTACTED_BATCH) {
      exhausted = true
      break
    }
    cursor = rows.at(-1)!.id
  }
  return { items, nextCursor: exhausted ? null : lastScannedId }
}

function toContactInput(contact: LoadedOrganization['contacts'][number]): SnapshotContactInput {
  return contact
}

const searchOrganizations: OperatorReadTool = {
  name: 'crm.search_organizations',
  capability: 'crm:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['crm.search_organizations'].parse(raw)
    return pageOrganizations(context.database, {
      where: organizationWhere(input, input.query),
      orderBy: [{ canonicalName: 'asc' }, { id: 'asc' }],
      limit: input.limit,
      cursor: input.cursor,
    })
  },
}

const listCandidates: OperatorReadTool = {
  name: 'crm.list_candidates',
  capability: 'crm:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['crm.list_candidates'].parse(raw)
    const where = organizationWhere(input)
    if (input.uncontacted) {
      return pageUncontacted(context.database, { where, limit: input.limit, cursor: input.cursor })
    }
    return pageOrganizations(context.database, {
      where,
      orderBy: [{ id: 'asc' }],
      limit: input.limit,
      cursor: input.cursor,
    })
  },
}

const CONTACT_RULE_SELECT = {
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
} as const

/** Normalized addresses from `emails` that are blocked on at least one contact row anywhere. */
async function blockedAddressesAnywhere(
  database: OperatorCallContext['database'],
  emails: readonly string[],
): Promise<Set<string>> {
  const normalized = [...new Set(emails.map((email) => email.trim().toLowerCase()))]
  if (normalized.length === 0) return new Set()
  const rows = await database.prospectContact.findMany({
    where: {
      OR: [
        { normalizedEmail: { in: normalized } },
        ...normalized.map((email) => ({ email: { equals: email, mode: 'insensitive' as const } })),
      ],
    },
    select: CONTACT_RULE_SELECT,
  })
  return blockedAddressSet(rows as unknown as SnapshotContactInput[])
}

const getOrganization: OperatorReadTool = {
  name: 'crm.get_organization',
  capability: 'crm:read',
  async handler(raw, context) {
    const { organizationId } = OPERATOR_MCP_INPUTS['crm.get_organization'].parse(raw)
    const row = await context.database.prospectOrganization.findFirst({
      where: { id: organizationId, archivedAt: null },
      select: organizationSelect,
    })
    if (!row) throw new OperatorNotFoundError()
    const { view } = (await viewsFor(context.database, [row]))[0]!
    const contacts = row.contacts.map(toContactInput)
    // An address blocked on any row anywhere in the CRM (archived rows included) is withheld here.
    const blocked = await blockedAddressesAnywhere(
      context.database,
      contacts.map((contact) => contact.email).filter((email): email is string => Boolean(email)),
    )
    const notes: ReturnType<typeof operatorUntrustedText>[] = []
    const addNote = (value: string | null) => {
      if (value && value.trim() && notes.length < MAX_NOTES) {
        notes.push(operatorUntrustedText(redactAddresses(value)))
      }
    }
    addNote(row.notes)
    for (const contact of row.contacts) {
      // A suppressed contact's free text stays private along with its address.
      if (operatorContactView(toContactInput(contact), blocked).contactable) addNote(contact.notes)
    }
    return {
      organization: view,
      contacts: contacts
        .slice(0, MAX_CONTACTS)
        .map((contact) => operatorContactView(contact, blocked)),
      notes,
    }
  },
}

const getContactHistory: OperatorReadTool = {
  name: 'crm.get_contact_history',
  capability: 'crm:read',
  async handler(raw, context) {
    const { organizationId } = OPERATOR_MCP_INPUTS['crm.get_contact_history'].parse(raw)
    const database = context.database
    const organization = await database.prospectOrganization.findFirst({
      where: { id: organizationId, archivedAt: null },
      select: { id: true },
    })
    if (!organization) throw new OperatorNotFoundError()
    const [activities, messages] = await Promise.all([
      database.prospectActivity.findMany({
        where: { organizationId },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: MAX_HISTORY_EVENTS,
        select: { type: true, summary: true, occurredAt: true },
      }),
      database.prospectEmailMessage.findMany({
        where: { organizationId },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: MAX_HISTORY_EVENTS,
        // Bodies, addresses and provider IDs are never selected.
        select: { direction: true, status: true, subject: true, occurredAt: true },
      }),
    ])
    const events = [
      ...activities.map((row) => ({
        type: row.type as string,
        occurredAt: row.occurredAt,
        summary: operatorUntrustedText(redactAddresses(row.summary)),
      })),
      ...messages.map((row) => ({
        type: row.direction === 'OUTBOUND' ? 'EMAIL_OUTBOUND' : 'EMAIL_INBOUND',
        occurredAt: row.occurredAt,
        summary: operatorUntrustedText(redactAddresses(`${row.status}: ${row.subject}`)),
      })),
    ]
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .slice(0, MAX_HISTORY_EVENTS)
    return {
      organizationId,
      events: events.map((event) => ({
        type: event.type,
        occurredAt: event.occurredAt.toISOString(),
        summary: event.summary,
      })),
    }
  },
}

const checkCanContact: OperatorReadTool = {
  name: 'crm.check_can_contact',
  capability: 'crm:read',
  async handler(raw, context) {
    const { email } = OPERATOR_MCP_INPUTS['crm.check_can_contact'].parse(raw)
    const rows = await context.database.prospectContact.findMany({
      where: {
        OR: [{ normalizedEmail: email }, { email: { equals: email, mode: 'insensitive' } }],
      },
      orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      // Enough rows that a blocked duplicate can never be cut off by the page size.
      take: 1000,
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
        organizationId: true,
        organization: {
          select: { archivedAt: true, opportunity: { select: { stage: true } } },
        },
      },
    })
    const matches = rows
      .map((row) => ({
        contact: row as SnapshotContactInput,
        organizationId: row.organizationId,
        organizationStage: row.organization.opportunity?.stage ?? null,
        active: row.archivedAt === null && row.organization.archivedAt === null,
      }))
      .sort((a, b) => Number(b.active) - Number(a.active))
    const answer = evaluateCanContact(matches)
    // An address already known to be undeliverable is never sent to.
    const invalid = matches.find((match) => match.contact.emailReadiness === 'INVALID')
    if (answer.allowed && invalid) {
      return {
        allowed: false,
        reason: 'suppressed' as const,
        organizationId: invalid.organizationId,
        contactId: invalid.contact.id,
      }
    }
    // A blocked answer stands even for an archived row. An allow needs a live contact.
    if (answer.allowed && !matches.some((match) => match.active)) {
      return { allowed: false, reason: 'unknown_address', organizationId: null, contactId: null }
    }
    return answer
  },
}

export const crmReadTools: readonly OperatorReadTool[] = [
  searchOrganizations,
  getOrganization,
  listCandidates,
  getContactHistory,
  checkCanContact,
]
