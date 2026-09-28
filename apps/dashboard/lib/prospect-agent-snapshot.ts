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
