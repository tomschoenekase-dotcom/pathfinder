import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import type { OperatorDatabase } from '../audit'
import { grantCoversTenant, OperatorNotFoundError } from '../grants'
import type { VerifiedOperatorGrant } from '../oauth'
import {
  buildOutreachContext,
  OUTREACH_CONTEXT_CAPS,
  type OutreachContextInput,
  type OutreachContactRow,
} from '../outreach-context'
import type { OperatorReadTool } from '../registry'
import { eligibilityForContacts } from './crm-eligibility'
import { loadOutreach } from './crm-data'
import { importedMailReferences } from './crm-imports'

/** The summary the note actions write. Other NOTE_ADDED rows record field updates, not notes. */
const NOTE_SUMMARY = 'Operator note added'
/** Auto selection checks this many live contacts, venue match first, then by id. */
const CONTACT_SCAN = 30

const CONTACT_SELECT = {
  id: true,
  venueId: true,
  fullName: true,
  title: true,
  email: true,
  doNotContact: true,
  suppressionReason: true,
  suppressedAt: true,
  unsubscribedAt: true,
  complainedAt: true,
  lastHardBounceAt: true,
  permissionState: true,
  emailReadiness: true,
  updatedAt: true,
} as const

const VENUE_SELECT = {
  id: true,
  name: true,
  website: true,
  venueType: true,
  city: true,
  region: true,
  country: true,
  estimatedSize: true,
  fitAttributes: true,
  visitorOperations: true,
  researchSources: true,
  updatedAt: true,
  archivedAt: true,
} as const

const later = (a: Date | null, b: Date | null): Date | null =>
  a === null ? b : b === null ? a : a.getTime() >= b.getTime() ? a : b

/**
 * Reads every row the outreach context pack needs and shapes it with the pure builder. Read-only:
 * no model call, no mailbox access, no network, no write. A prospect already converted to a
 * customer of a tenant the grant does not cover reads as not found, like any other out-of-scope
 * target, because its correspondence is tenant-linked.
 */
export async function loadOutreachContext(
  database: OperatorDatabase,
  grant: VerifiedOperatorGrant,
  args: { organizationId: string; contactId?: string | undefined; venueId?: string | undefined },
  now: Date,
) {
  const { organizationId } = args
  const org = await database.prospectOrganization.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      canonicalName: true,
      website: true,
      organizationType: true,
      headquartersCity: true,
      headquartersRegion: true,
      headquartersCountry: true,
      notes: true,
      archivedAt: true,
      updatedAt: true,
      researchProvenance: true,
      opportunity: { select: { stage: true } },
      conversion: { select: { tenantId: true } },
      // Authorization must inspect every active relationship, never a truncated display page.
      customerRelationships: { where: { status: 'ACTIVE' }, select: { tenantId: true } },
    },
  })
  if (!org) throw new OperatorNotFoundError()
  const tenants = [
    ...(org.conversion ? [org.conversion.tenantId] : []),
    ...org.customerRelationships.map((relationship) => relationship.tenantId),
  ]
  if (tenants.some((tenantId) => !grantCoversTenant(grant, tenantId))) {
    throw new OperatorNotFoundError()
  }

  // ---- contact ------------------------------------------------------------------------------
  const liveWhere = { organizationId, archivedAt: null }
  let chosenRow: OutreachContactRow | null = null
  let selection: 'requested' | 'auto' | 'none' = 'none'
  let scanned: OutreachContactRow[] = []
  const liveTotal = await database.prospectContact.count({ where: liveWhere })
  if (args.contactId !== undefined) {
    const requested = await database.prospectContact.findFirst({
      where: { id: args.contactId, organizationId },
      select: CONTACT_SELECT,
    })
    if (!requested) throw new OperatorNotFoundError()
    chosenRow = requested
    selection = 'requested'
  }
  const scanRows = await database.prospectContact.findMany({
    where: liveWhere,
    orderBy: { id: 'asc' },
    take: CONTACT_SCAN + 1,
    select: CONTACT_SELECT,
  })
  scanned = scanRows.slice(0, CONTACT_SCAN)
  if (args.venueId !== undefined) {
    // A contact of the asked-for venue comes first.
    scanned = [
      ...scanned.filter((row) => row.venueId === args.venueId),
      ...scanned.filter((row) => row.venueId !== args.venueId),
    ]
  }
  const contactEligibility = await eligibilityForContacts(database, [
    ...scanned.map((row) => row.id),
    ...(chosenRow ? [chosenRow.id] : []),
  ])
  if (chosenRow === null) {
    const pick = scanned.find((row) => contactEligibility.get(row.id)?.draft.eligible)
    if (pick) {
      chosenRow = pick
      selection = 'auto'
    }
  }
  const chosenEligibility = chosenRow ? contactEligibility.get(chosenRow.id)! : null
  const lastSuppressionEvent = chosenRow
    ? await database.prospectContactSuppressionEvent.findFirst({
        where: { contactId: chosenRow.id },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        select: { eventType: true, reasonCode: true, occurredAt: true },
      })
    : null

  // ---- venue --------------------------------------------------------------------------------
  const venueCount = await database.prospectVenue.count({
    where: { organizationId, archivedAt: null },
  })
  type VenueRow = NonNullable<Awaited<ReturnType<typeof findVenue>>>
  const findVenue = (id: string) =>
    database.prospectVenue.findFirst({
      where: { id, organizationId },
      select: VENUE_SELECT,
    })
  let venueRow: VenueRow | null = null
  let venueSelection: 'requested' | 'contact' | 'only' | 'first' = 'first'
  if (args.venueId !== undefined) {
    venueRow = await findVenue(args.venueId)
    if (!venueRow) throw new OperatorNotFoundError()
    venueSelection = 'requested'
  } else if (chosenRow?.venueId) {
    venueRow = await findVenue(chosenRow.venueId)
    venueSelection = 'contact'
  }
  if (venueRow === null) {
    venueRow = await database.prospectVenue.findFirst({
      where: { organizationId, archivedAt: null },
      orderBy: { id: 'asc' },
      select: VENUE_SELECT,
    })
    venueSelection = venueCount === 1 ? 'only' : 'first'
  }

  // ---- correspondence, notes, evidence ------------------------------------------------------
  const evidenceWhere = {
    organizationId,
    AND: [
      { OR: [{ venueId: null }, ...(venueRow ? [{ venueId: venueRow.id }] : [])] },
      { OR: [{ contactId: null }, ...(chosenRow ? [{ contactId: chosenRow.id }] : [])] },
    ],
  }
  const noteWhere = { organizationId, type: 'NOTE_ADDED' as const, summary: NOTE_SUMMARY }
  const [
    outreach,
    messageTotal,
    messages,
    draftTotal,
    drafts,
    noteTotal,
    notes,
    evidenceTotal,
    evidence,
  ] = await Promise.all([
    loadOutreach(database, [organizationId]),
    database.prospectEmailMessage.count({ where: { organizationId } }),
    database.prospectEmailMessage.findMany({
      where: { organizationId },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: OUTREACH_CONTEXT_CAPS.messages,
      select: {
        id: true,
        threadId: true,
        contactId: true,
        direction: true,
        status: true,
        occurredAt: true,
        subject: true,
        bodyPreview: true,
      },
    }),
    database.prospectOutreachDraft.count({ where: { organizationId } }),
    database.prospectOutreachDraft.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: OUTREACH_CONTEXT_CAPS.drafts,
      select: {
        id: true,
        version: true,
        status: true,
        createdAt: true,
        subject: true,
        escalationFlags: true,
      },
    }),
    database.prospectActivity.count({ where: noteWhere }),
    database.prospectActivity.findMany({
      where: noteWhere,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: OUTREACH_CONTEXT_CAPS.notes,
      select: { id: true, occurredAt: true, summary: true, detail: true },
    }),
    database.prospectSourceEvidence.count({ where: evidenceWhere }),
    database.prospectSourceEvidence.findMany({
      where: evidenceWhere,
      orderBy: [
        { researchedAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: OUTREACH_CONTEXT_CAPS.evidence,
      select: {
        id: true,
        venueId: true,
        contactId: true,
        sourceType: true,
        sourceLabel: true,
        sourceUrl: true,
        capturedValue: true,
        researchedAt: true,
      },
    }),
  ])
  const thread = outreach.get(organizationId)!
  // A message tied to a person who may not be contacted keeps its metadata and loses its text.
  const messageContacts = await eligibilityForContacts(
    database,
    messages.map((message) => message.contactId),
  )

  const input: OutreachContextInput = {
    now,
    organization: {
      id: org.id,
      name: org.canonicalName,
      website: org.website,
      type: org.organizationType,
      city: org.headquartersCity,
      region: org.headquartersRegion,
      country: org.headquartersCountry,
      stage: org.opportunity?.stage ?? null,
      archived: org.archivedAt !== null,
      updatedAt: org.updatedAt,
      notes: org.notes,
      customerLinked: tenants.length > 0,
      researchProvenance: org.researchProvenance,
      duplicateReview: thread.duplicateReview,
    },
    venueCount,
    venue: venueRow
      ? {
          selection: venueSelection,
          archived: venueRow.archivedAt !== null,
          row: venueRow,
        }
      : null,
    contact: {
      selection,
      liveTotal,
      scanned: scanned.length,
      chosen:
        chosenRow && chosenEligibility
          ? {
              row: chosenRow,
              draft: chosenEligibility.draft,
              release: chosenEligibility.send,
              lastSuppressionEvent,
            }
          : null,
      others: scanned
        .filter((row) => row.id !== chosenRow?.id)
        .slice(0, OUTREACH_CONTEXT_CAPS.others)
        .map((row) => ({
          id: row.id,
          fullName: row.fullName,
          title: row.title,
          draftEligible: contactEligibility.get(row.id)?.draft.eligible ?? false,
        })),
    },
    correspondence: {
      inboundMessages: thread.inbound.count,
      outboundMessages: thread.outbound.count,
      threads: thread.threadCount,
      lastInboundAt: later(thread.inbound.last, thread.activity.lastReplyReceivedAt),
      lastOutboundAt: later(thread.outbound.last, thread.activity.lastOutreachSentAt),
      messageTotal,
      messages: messages.map((message) => ({
        id: message.id,
        threadId: message.threadId,
        contactId: message.contactId,
        direction: message.direction,
        status: message.status,
        occurredAt: message.occurredAt,
        subject: message.subject,
        bodyPreview: message.bodyPreview,
        previewReadable:
          message.contactId === null ||
          (messageContacts.get(message.contactId)?.draft.eligible ?? false),
      })),
      draftTotal,
      drafts,
    },
    noteTotal,
    notes: notes.map((note) => ({
      id: note.id,
      occurredAt: note.occurredAt,
      text: note.detail ?? note.summary,
    })),
    evidenceTotal,
    evidence,
  }
  const context = buildOutreachContext(input)
  // Import evidence is a source claim, never a verified Gmail message or delivery receipt.
  const importedEvidence = await database.prospectSourceEvidence.findMany({
    where: { organizationId, importRowId: { not: null } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 21,
    select: { id: true, importRowId: true, importRow: { select: { normalizedValues: true } } },
  })
  return {
    ...context,
    correspondence: {
      ...context.correspondence,
      importedReferences: {
        items: importedEvidence.slice(0, 20).flatMap((row) => {
          const references = importedMailReferences(row.importRow?.normalizedValues)
          return row.importRowId && references
            ? [{ evidenceId: row.id, importRowId: row.importRowId, references }]
            : []
        }),
        recordsScanned: Math.min(importedEvidence.length, 20),
        moreRecordsUnscanned: importedEvidence.length > 20,
      },
    },
  }
}

const getOutreachContext: OperatorReadTool = {
  name: 'crm.get_outreach_context',
  capability: 'crm:read',
  async handler(raw, context) {
    const args = OPERATOR_MCP_INPUTS['crm.get_outreach_context'].parse(raw)
    return loadOutreachContext(context.database, context.grant, args, context.now)
  },
}

export const crmOutreachContextReadTools: readonly OperatorReadTool[] = [getOutreachContext]
