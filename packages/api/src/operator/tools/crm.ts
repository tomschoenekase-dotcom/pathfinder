import type { Prisma } from '@prisma/client'

import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import {
  blockedAddressSet,
  isUncontactedOrganization,
  operatorContactView,
  operatorOrganizationView,
  operatorUntrustedText,
  redactAddresses,
  type SnapshotContactInput,
} from '../crm-projection'
import { OperatorNotFoundError } from '../grants'
import type { OperatorCallContext, OperatorReadTool } from '../registry'
import { evaluateAddress } from './crm-eligibility'
import { OperatorInvalidCursorError, pageResult } from './page'
import {
  loadActivityCounts,
  loadOutreach,
  organizationSelect,
  projectOrganization,
  type LoadedOrganization,
} from './crm-data'

const MAX_CONTACTS = 50
const MAX_NOTES = 20
const UNCONTACTED_BATCH = 100
const CAN_CONTACT_BATCH = 500
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
  return pageResult(items, rows.length > input.limit ? page.at(-1)!.id : null)
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
  return pageResult(items, exhausted ? null : lastScannedId)
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
export async function blockedAddressesAnywhere(
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

/**
 * History is two streams (CRM activity and email messages) read as one, newest first. Events can
 * share an instant, so the order is total: time (newest first), then stream (activity before
 * message), then id (newest first). The cursor names the last event returned in that order, so a
 * tie on the same millisecond is neither skipped nor repeated across pages.
 */
type HistoryEvent = {
  type: string
  occurredAt: Date
  summary: ReturnType<typeof operatorUntrustedText>
  rank: 'a' | 'm'
  id: string
}

function encodeHistoryCursor(event: Pick<HistoryEvent, 'occurredAt' | 'rank' | 'id'>) {
  return `h:${event.occurredAt.toISOString()}|${event.rank}|${event.id}`
}

function decodeHistoryCursor(cursor: string) {
  const match = /^h:([^|]{20,40})\|([am])\|(.{1,191})$/u.exec(cursor)
  const at = match ? new Date(match[1]!) : null
  if (!match || !at || Number.isNaN(at.getTime())) throw new OperatorInvalidCursorError()
  return { at, rank: match[2] as 'a' | 'm', id: match[3]! }
}

const getContactHistory: OperatorReadTool = {
  name: 'crm.get_contact_history',
  capability: 'crm:read',
  async handler(raw, context) {
    const { organizationId, cursor, limit } =
      OPERATOR_MCP_INPUTS['crm.get_contact_history'].parse(raw)
    const database = context.database
    const organization = await database.prospectOrganization.findFirst({
      where: { id: organizationId, archivedAt: null },
      select: { id: true },
    })
    if (!organization) throw new OperatorNotFoundError()
    const after = cursor === undefined ? null : decodeHistoryCursor(cursor)
    if (after) {
      // The cursor must name an event of this account, or it is refused outright.
      const anchor =
        after.rank === 'a'
          ? await database.prospectActivity.findFirst({
              where: { id: after.id, organizationId },
              select: { id: true },
            })
          : await database.prospectEmailMessage.findFirst({
              where: { id: after.id, organizationId },
              select: { id: true },
            })
      if (!anchor) throw new OperatorInvalidCursorError()
    }
    const earlier = (stream: 'a' | 'm') =>
      after
        ? {
            OR: [
              { occurredAt: { lt: after.at } },
              // Same instant: activities come before messages, then newer ids before older ones.
              ...(stream === 'a'
                ? after.rank === 'a'
                  ? [{ occurredAt: after.at, id: { lt: after.id } }]
                  : []
                : after.rank === 'a'
                  ? [{ occurredAt: after.at }]
                  : [{ occurredAt: after.at, id: { lt: after.id } }]),
            ],
          }
        : {}
    const [activities, messages] = await Promise.all([
      database.prospectActivity.findMany({
        where: { organizationId, ...earlier('a') },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: { id: true, type: true, summary: true, occurredAt: true },
      }),
      database.prospectEmailMessage.findMany({
        where: { organizationId, ...earlier('m') },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        // Bodies, addresses and provider IDs are never selected.
        select: { id: true, direction: true, status: true, subject: true, occurredAt: true },
      }),
    ])
    const events: HistoryEvent[] = [
      ...activities.map((row) => ({
        type: row.type as string,
        occurredAt: row.occurredAt,
        summary: operatorUntrustedText(redactAddresses(row.summary)),
        rank: 'a' as const,
        id: row.id,
      })),
      ...messages.map((row) => ({
        type: row.direction === 'OUTBOUND' ? 'EMAIL_OUTBOUND' : 'EMAIL_INBOUND',
        occurredAt: row.occurredAt,
        summary: operatorUntrustedText(redactAddresses(`${row.status}: ${row.subject}`)),
        rank: 'm' as const,
        id: row.id,
      })),
    ].sort(
      (a, b) =>
        b.occurredAt.getTime() - a.occurredAt.getTime() ||
        (a.rank === b.rank ? 0 : a.rank === 'a' ? -1 : 1) ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    )
    const page = events.slice(0, limit)
    return {
      organizationId,
      events: page.map((event) => ({
        type: event.type,
        occurredAt: event.occurredAt.toISOString(),
        summary: event.summary,
      })),
      nextCursor: events.length > limit ? encodeHistoryCursor(page.at(-1)!) : null,
      complete: events.length <= limit,
    }
  },
}

type ContactMatchRow = Parameters<typeof evaluateAddress>[0][number]

const checkCanContact: OperatorReadTool = {
  name: 'crm.check_can_contact',
  capability: 'crm:read',
  async handler(raw, context) {
    const { email, purpose } = OPERATOR_MCP_INPUTS['crm.check_can_contact'].parse(raw)
    const where = {
      OR: [{ normalizedEmail: email }, { email: { equals: email, mode: 'insensitive' as const } }],
    }
    // Every row carrying the address is read, a page at a time and never capped, so a block on an
    // old archived alias cannot be missed because many other rows came first.
    const rows: ContactMatchRow[] = []
    let cursor: string | undefined
    for (;;) {
      const batch = await context.database.prospectContact.findMany({
        where,
        orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
        take: CAN_CONTACT_BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          normalizedEmail: true,
          doNotContact: true,
          emailReadiness: true,
          permissionState: true,
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
      rows.push(...(batch as unknown as ContactMatchRow[]))
      if (batch.length < CAN_CONTACT_BATCH) break
      cursor = batch.at(-1)!.id
    }
    const answer = evaluateAddress(rows, purpose)
    return {
      allowed: answer.allowed,
      reason: answer.reason,
      reasons: [...answer.reasons],
      purpose: answer.purpose,
      organizationId: answer.organizationId,
      contactId: answer.contactId,
    }
  },
}

export const crmReadTools: readonly OperatorReadTool[] = [
  searchOrganizations,
  getOrganization,
  listCandidates,
  getContactHistory,
  checkCanContact,
]
