// Read-only CRM snapshot for AI drafting agents. The platform admin downloads it
// while signed in; agents read the saved file locally. It carries only what a
// drafter needs: identity, fit, contact routes and outreach history summaries.
// Email bodies, provenance, actor identities and provider IDs never enter it, and
// suppressed contacts keep their flags but lose their email address.

export const PROSPECT_AGENT_SNAPSHOT_SCHEMA_VERSION = 1
export const PROSPECT_AGENT_SNAPSHOT_PAGE_SIZE = 200
const NOTES_MAX_CHARS = 500
const FIT_ATTRIBUTE_MAX_CHARS = 2000
const FIT_ATTRIBUTE_KEYS = ['torchikoTriageV1', 'torchikoFounderPriorityV1'] as const

// Stages at or past first contact. PARKED is excluded because it can precede contact.
const CONTACTED_STAGES = new Set([
  'CONTACTED',
  'FOLLOW_UP_DUE',
  'REPLIED',
  'CONVERSATION',
  'QUALIFIED',
  'PROPOSAL_DECISION',
  'WON',
  'LOST',
])
const CONTACTED_MEMBER_STATUSES = new Set(['QUEUED', 'SENT', 'REPLIED', 'BOUNCED'])
const CONTACTED_DRAFT_STATUSES = new Set(['QUEUED', 'SENT'])
const SUPPRESSING_PERMISSION_STATES = new Set(['OPTED_OUT', 'PROHIBITED'])

type Timestamp = Date | null

export type SnapshotContactInput = {
  id: string
  venueId: string | null
  fullName: string | null
  title: string | null
  email: string | null
  phone: string | null
  emailReadiness: string
  permissionState: string
  doNotContact: boolean
  suppressionReason: string | null
  suppressedAt: Timestamp
  unsubscribedAt: Timestamp
  complainedAt: Timestamp
  lastHardBounceAt: Timestamp
}

export type SnapshotVenueInput = {
  id: string
  name: string
  website: string | null
  venueType: string | null
  city: string | null
  region: string | null
  country: string | null
  estimatedSize: string | null
  fitAttributes: unknown
}

export type SnapshotOrganizationInput = {
  id: string
  canonicalName: string
  website: string | null
  organizationType: string | null
  headquartersCity: string | null
  headquartersRegion: string | null
  headquartersCountry: string | null
  relationshipTier: string
  notes: string | null
  updatedAt: Date
  opportunity: {
    stage: string
    priority: string
    nextAction: string | null
    nextActionAt: Timestamp
    lastActivityAt: Timestamp
  } | null
  venues: SnapshotVenueInput[]
  contacts: SnapshotContactInput[]
  tagAssignments: { tag: { slug: string; label: string; archivedAt: Timestamp } }[]
}

export type SnapshotOutreachInput = {
  outbound: { count: number; last: Timestamp }
  inbound: { count: number; last: Timestamp }
  threadCount: number
  draftsByStatus: Record<string, number>
  campaigns: { name: string; campaignStatus: string; memberStatus: string }[]
  activity: { lastOutreachSentAt: Timestamp; lastReplyReceivedAt: Timestamp }
  duplicateReview: 'OPEN' | 'CONFIRMED_DUPLICATE' | null
}

export function emptySnapshotOutreach(): SnapshotOutreachInput {
  return {
    outbound: { count: 0, last: null },
    inbound: { count: 0, last: null },
    threadCount: 0,
    draftsByStatus: {},
    campaigns: [],
    activity: { lastOutreachSentAt: null, lastReplyReceivedAt: null },
    duplicateReview: null,
  }
}

export function isSnapshotContactSuppressed(contact: SnapshotContactInput): boolean {
  return (
    contact.doNotContact ||
    contact.suppressedAt !== null ||
    contact.unsubscribedAt !== null ||
    contact.complainedAt !== null ||
    SUPPRESSING_PERMISSION_STATES.has(contact.permissionState)
  )
}

function iso(value: Timestamp): string | null {
  return value ? value.toISOString() : null
}

function latest(...values: Timestamp[]): string | null {
  const times = values.filter((value): value is Date => value !== null).map((v) => v.getTime())
  return times.length ? new Date(Math.max(...times)).toISOString() : null
}

function truncate(value: string | null, max: number): string | null {
  if (value === null) return null
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function fitSummary(fitAttributes: unknown): Record<string, unknown> {
  if (!fitAttributes || typeof fitAttributes !== 'object' || Array.isArray(fitAttributes)) return {}
  const source = fitAttributes as Record<string, unknown>
  const summary: Record<string, unknown> = {}
  for (const key of FIT_ATTRIBUTE_KEYS) {
    if (!(key in source)) continue
    const serialized = JSON.stringify(source[key])
    if (serialized !== undefined && serialized.length <= FIT_ATTRIBUTE_MAX_CHARS) {
      summary[key] = source[key]
    }
  }
  return summary
}

export function buildProspectAgentSnapshotOrganization(
  organization: SnapshotOrganizationInput,
  outreach: SnapshotOutreachInput,
) {
  const stage = organization.opportunity?.stage ?? null
  const draftCount = Object.values(outreach.draftsByStatus).reduce((sum, count) => sum + count, 0)
  const contacts = organization.contacts.map((contact) => {
    const suppressed = isSnapshotContactSuppressed(contact)
    return {
      id: contact.id,
      venueId: contact.venueId,
      name: contact.fullName,
      title: contact.title,
      email: suppressed ? null : contact.email,
      phone: suppressed ? null : contact.phone,
      emailReadiness: contact.emailReadiness,
      permissionState: contact.permissionState,
      suppressed,
      suppressionReason: suppressed ? contact.suppressionReason : null,
      unsubscribedAt: iso(contact.unsubscribedAt),
      complainedAt: iso(contact.complainedAt),
      lastHardBounceAt: iso(contact.lastHardBounceAt),
    }
  })
  const everContacted =
    outreach.outbound.count > 0 ||
    outreach.activity.lastOutreachSentAt !== null ||
    (stage !== null && CONTACTED_STAGES.has(stage)) ||
    outreach.campaigns.some((campaign) => CONTACTED_MEMBER_STATUSES.has(campaign.memberStatus)) ||
    Object.entries(outreach.draftsByStatus).some(
      ([status, count]) => count > 0 && CONTACTED_DRAFT_STATUSES.has(status),
    )

  return {
    id: organization.id,
    name: organization.canonicalName,
    website: organization.website,
    type: organization.organizationType,
    headquarters: {
      city: organization.headquartersCity,
      region: organization.headquartersRegion,
      country: organization.headquartersCountry,
    },
    relationshipTier: organization.relationshipTier,
    stage,
    priority: organization.opportunity?.priority ?? null,
    nextAction: organization.opportunity?.nextAction ?? null,
    nextActionAt: iso(organization.opportunity?.nextActionAt ?? null),
    tags: organization.tagAssignments
      .filter((assignment) => assignment.tag.archivedAt === null)
      .map((assignment) => assignment.tag.slug)
      .sort(),
    notes: truncate(organization.notes, NOTES_MAX_CHARS),
    updatedAt: organization.updatedAt.toISOString(),
    venues: organization.venues.map((venue) => ({
      id: venue.id,
      name: venue.name,
      website: venue.website,
      type: venue.venueType,
      city: venue.city,
      region: venue.region,
      country: venue.country,
      estimatedSize: venue.estimatedSize,
      fit: fitSummary(venue.fitAttributes),
    })),
    contacts,
    outreach: {
      everContacted,
      doNotContact: stage === 'DO_NOT_CONTACT' || contacts.some((contact) => contact.suppressed),
      lastOutboundAt: latest(outreach.outbound.last, outreach.activity.lastOutreachSentAt),
      lastInboundAt: latest(outreach.inbound.last, outreach.activity.lastReplyReceivedAt),
      lastActivityAt: iso(organization.opportunity?.lastActivityAt ?? null),
      outboundMessages: outreach.outbound.count,
      inboundMessages: outreach.inbound.count,
      threads: outreach.threadCount,
      crmDrafts: draftCount,
      crmDraftsByStatus: outreach.draftsByStatus,
      campaigns: outreach.campaigns,
      duplicateReview: outreach.duplicateReview,
    },
  }
}

export type ProspectAgentSnapshotOrganization = ReturnType<
  typeof buildProspectAgentSnapshotOrganization
>

export function prospectAgentSnapshotHeader(input: { snapshotId: string; generatedAt: Date }) {
  return {
    schemaVersion: PROSPECT_AGENT_SNAPSHOT_SCHEMA_VERSION,
    snapshotId: input.snapshotId,
    generatedAt: input.generatedAt.toISOString(),
    readOnly: true,
    notice:
      'Read-only CRM copy for drafting. It can be stale: check the mailbox for contact after generatedAt before drafting. Suppressed contacts have no email or phone.',
  }
}

export function prospectAgentSnapshotFileName(generatedAt: Date): string {
  return `torchiko-crm-snapshot-${generatedAt.toISOString().replaceAll(/[:.]/gu, '-')}.json`
}

// ---------------------------------------------------------------------------
// Operator layer (additive; nothing above this line changed when the file moved)
// ---------------------------------------------------------------------------

/**
 * `crm.log_outreach_sent` (built in a later packet) records a send as a ProspectActivity of this
 * existing type. The snapshot rules already treat it as contact (`lastOutreachSentAt`), so
 * "uncontacted" stays right without a new enum value or a migration.
 */
export const OPERATOR_OUTREACH_LOG_ACTIVITY_TYPE = 'OUTREACH_SENT' as const

export const OPERATOR_TEXT_MAX_CHARS = NOTES_MAX_CHARS

const SETTLED_STAGES = new Set(['WON', 'LOST', 'PARKED', 'DO_NOT_CONTACT'])
const EMAIL_LIKE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu

export type OperatorContactFlags = {
  doNotContact: boolean
  suppressed: boolean
  unsubscribed: boolean
  complained: boolean
}

export type OperatorContactReason =
  | 'ok'
  | 'do_not_contact'
  | 'suppressed'
  | 'unsubscribed'
  | 'complained'

/** The four flags are always present, whatever the contact's state. */
export function operatorContactFlags(contact: SnapshotContactInput): OperatorContactFlags {
  return {
    doNotContact: contact.doNotContact,
    // A hard bounce is treated as suppressed: sending again would only damage deliverability.
    suppressed:
      contact.suppressedAt !== null ||
      contact.lastHardBounceAt !== null ||
      SUPPRESSING_PERMISSION_STATES.has(contact.permissionState),
    unsubscribed: contact.unsubscribedAt !== null,
    complained: contact.complainedAt !== null,
  }
}

/** Same rule as `isSnapshotContactSuppressed`, reported as the first reason that applies. */
export function operatorContactReason(contact: SnapshotContactInput): OperatorContactReason {
  const flags = operatorContactFlags(contact)
  if (flags.doNotContact) return 'do_not_contact'
  if (flags.suppressed) return 'suppressed'
  if (flags.unsubscribed) return 'unsubscribed'
  if (flags.complained) return 'complained'
  return 'ok'
}

export function operatorContactView(
  contact: SnapshotContactInput,
  blockedAnywhere: ReadonlySet<string> = new Set(),
) {
  const blockedElsewhere =
    contact.email !== null && blockedAnywhere.has(contact.email.trim().toLowerCase())
  const contactable =
    !blockedElsewhere &&
    !isSnapshotContactSuppressed(contact) &&
    operatorContactReason(contact) === 'ok'
  return {
    contactId: contact.id,
    displayName: truncate(contact.fullName ? redactAddresses(contact.fullName) : null, 200),
    role: truncate(contact.title ? redactAddresses(contact.title) : null, 200),
    contactable,
    flags: operatorContactFlags(contact),
    // The address exists in the output only for a contactable person.
    email: contactable ? contact.email : null,
  }
}

export type OperatorUntrustedText = { untrusted: true; text: string; truncated: boolean }

/** Retrieved free text is data. Nothing that reads it may act on it. */
export function operatorUntrustedText(
  value: string,
  max: number = OPERATOR_TEXT_MAX_CHARS,
): OperatorUntrustedText {
  return value.length > max
    ? { untrusted: true, text: value.slice(0, max), truncated: true }
    : { untrusted: true, text: value, truncated: false }
}

/**
 * Withholds every email-shaped string in free text and names. Addresses reach the operator only
 * through the structured contact field, and only for people who may be contacted, so a note or a
 * duplicate row elsewhere in the CRM can never leak a blocked address.
 */
export function redactAddresses(value: string): string {
  return value.replaceAll(EMAIL_LIKE, '[address withheld]')
}

/** Normalized addresses of contacts that must not be emailed, for any reason. */
export function blockedAddressSet(contacts: readonly SnapshotContactInput[]): Set<string> {
  const blocked = new Set<string>()
  for (const contact of contacts) {
    if (
      contact.email &&
      (isSnapshotContactSuppressed(contact) || operatorContactReason(contact) !== 'ok')
    ) {
      blocked.add(contact.email.trim().toLowerCase())
    }
  }
  return blocked
}

/**
 * Optimistic-concurrency token for an organization: 1 plus the number of ProspectActivity rows
 * recorded for it. Every stage change, note and logged send adds one. This is the same definition
 * as `prospectOrganizationVersion` in operator/kinds/crm-stage-change.ts (which counts in the
 * database); reads report it so `crm.propose_stage_change.expectedVersion` matches.
 */
export function operatorOrganizationVersion(activityCount: number): number {
  return 1 + activityCount
}

/** The P17 CLI rule (`isUncontacted` in scripts/torchiko-crm-snapshot.mjs), on a built record. */
export function isUncontactedOrganization(
  organization: ProspectAgentSnapshotOrganization,
): boolean {
  const outreach = organization.outreach
  return (
    !outreach.everContacted &&
    !outreach.doNotContact &&
    outreach.crmDrafts === 0 &&
    outreach.campaigns.length === 0 &&
    outreach.duplicateReview === null &&
    !SETTLED_STAGES.has(organization.stage ?? '')
  )
}

export function operatorOrganizationView(
  organization: ProspectAgentSnapshotOrganization,
  version: number,
) {
  const firstVenue = organization.venues[0]
  return {
    organizationId: organization.id,
    name: redactAddresses(organization.name).slice(0, 200),
    type: truncate(organization.type, 80),
    city: truncate(organization.headquarters.city ?? firstVenue?.city ?? null, 120),
    region: truncate(organization.headquarters.region ?? firstVenue?.region ?? null, 120),
    stage: (organization.stage ?? 'DISCOVERED') as
      | 'DISCOVERED'
      | 'RESEARCHED'
      | 'NEEDS_REVIEW'
      | 'READY_FOR_OUTREACH'
      | 'CONTACTED'
      | 'FOLLOW_UP_DUE'
      | 'REPLIED'
      | 'CONVERSATION'
      | 'QUALIFIED'
      | 'PROPOSAL_DECISION'
      | 'WON'
      | 'LOST'
      | 'PARKED'
      | 'DO_NOT_CONTACT',
    version,
    sizeClass: truncate(firstVenue?.estimatedSize ?? null, 10),
    contacted: organization.outreach.everContacted,
  }
}

export type OperatorCanContactAnswer = {
  allowed: boolean
  reason: OperatorContactReason | 'unknown_address'
  organizationId: string | null
  contactId: string | null
}

/**
 * Decides whether an address may be emailed, from every contact row that carries it. One blocked
 * row blocks the address. An unknown address is never allowed.
 */
export function evaluateCanContact(
  matches: readonly {
    contact: SnapshotContactInput
    organizationId: string
    organizationStage: string | null
  }[],
): OperatorCanContactAnswer {
  if (matches.length === 0) {
    return { allowed: false, reason: 'unknown_address', organizationId: null, contactId: null }
  }
  for (const match of matches) {
    const reason: OperatorContactReason =
      match.organizationStage === 'DO_NOT_CONTACT'
        ? 'do_not_contact'
        : operatorContactReason(match.contact)
    if (reason !== 'ok') {
      return {
        allowed: false,
        reason,
        organizationId: match.organizationId,
        contactId: match.contact.id,
      }
    }
  }
  const first = matches[0]!
  return {
    allowed: true,
    reason: 'ok',
    organizationId: first.organizationId,
    contactId: first.contact.id,
  }
}
