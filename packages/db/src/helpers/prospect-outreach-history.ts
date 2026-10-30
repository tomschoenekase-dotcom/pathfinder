import { createHash } from 'node:crypto'
import { z } from 'zod'
import { db } from '../client'

type Transaction = Parameters<Parameters<typeof db.$transaction>[0]>[0]
export type ProspectOutreachHistoryReader = Pick<
  Transaction,
  | 'prospectOrganization'
  | 'prospectEmailMessage'
  | 'prospectActivity'
  | 'prospectOutreachDraft'
  | 'correspondenceProviderAccount'
  | 'prospectDuplicateCandidate'
  | 'prospectInboundQuarantine'
>
export class ProspectOutreachHistoryError extends Error {}
export const OUTREACH_EVIDENCE_SCHEMA = 'prospect-outreach-history/v1'
const binding = z
  .object({
    messageId: z.string().min(1),
    providerAccountId: z.string().min(1),
    providerMessageId: z.string().min(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
const coverage = z
  .object({
    providerAccountId: z.string().min(1),
    mailboxAddress: z.string().email(),
    searchedAt: z.string().datetime(),
    throughAt: z.string().datetime(),
    query: z.string().min(1).max(2000),
    sourceReceiptId: z.string().min(1).max(512),
    resultFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    complete: z.literal(true),
  })
  .strict()
const base = {
  reviewerType: z.enum(['HUMAN', 'AGENT', 'SYSTEM']).optional(),
  schema: z.literal(OUTREACH_EVIDENCE_SCHEMA),
  reviewerId: z.string().min(1),
  reason: z.string().min(1).max(2000),
}
export const prospectOutreachEvidenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...base,
      kind: z.literal('message'),
      binding,
      observedSent: z.boolean().optional(),
      classification: z.enum([
        'cold',
        'warm',
        'human',
        'automated',
        'outOfOffice',
        'bounce',
        'policyBlocked',
        'unknown',
      ]),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('complete'),
      historyFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
      mailboxIds: z.array(z.string().min(1)).min(1),
      organizationIds: z.array(z.string().min(1)).min(1),
      contactIds: z.array(z.string().min(1)),
      coverage: z.array(coverage).min(1),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('relationship'),
      relationship: z.enum(['prospect', 'deferred', 'declined', 'closed']),
      deferUntil: z.string().datetime().nullable(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('contactHealth'),
      contactId: z.string().min(1),
      recipientAddress: z.string().email(),
      health: z.enum(['bounced', 'policyBlocked', 'healthy']),
      binding,
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('scope'),
      canonicalOrganizationId: z.string().min(1),
      organizationIds: z.array(z.string().min(1)).min(1),
    })
    .strict(),
])
export type ProspectOutreachEvidence = z.infer<typeof prospectOutreachEvidenceSchema>
export type OutreachMessage = {
  id: string
  organizationId: string
  direction: string
  status: string
  providerAccountId: string | null
  providerMessageId: string | null
  occurredAt: Date
  fromAddress: string
  toAddresses: string[]
  subject: string
  inReplyTo?: string | null
  sentEvidence?: boolean
}
export type OutreachActivity = { evidence: unknown; actorId: string; occurredAt: Date }
export type ProspectOutreachHistoryProjection = {
  canonicalOrganizationId: string
  organizationIds: string[]
  coldEmailCount: 0 | 1 | 2 | 3 | null
  lastColdEmailAt: string | null
  firstHumanReply: 'after1' | 'after2' | 'after3' | 'otherUnknown' | 'noReply'
  relationship:
    | 'prospect'
    | 'awaitingReply'
    | 'inConversation'
    | 'deferred'
    | 'declined'
    | 'customer'
    | 'closed'
  nextEligibleAt: string | null
  eligibility: 'eligible' | 'hold' | 'stopped'
  eligibilityReason: string
  reasons: string[]
  contactHealth: 'healthy' | 'unverified' | 'bounced' | 'suppressed' | 'policyBlocked' | 'unknown'
  historyComplete: boolean
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}
function hash(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}
/** Stable source metadata survives body retention. Message text never becomes agent-authored evidence. */
export function prospectOutreachMessageFingerprint(message: OutreachMessage) {
  return hash([
    message.id,
    message.organizationId,
    message.providerAccountId,
    message.providerMessageId,
    message.direction,
    message.occurredAt.toISOString(),
    message.fromAddress,
    message.toAddresses,
    message.subject,
    message.inReplyTo ?? null,
  ])
}
export function prospectOutreachHistoryFingerprint(
  messages: readonly OutreachMessage[],
  organizationIds: readonly string[],
) {
  return hash([
    [...organizationIds].sort(),
    messages.map(prospectOutreachMessageFingerprint).sort(),
  ])
}
function providerObservationFingerprint(message: OutreachMessage) {
  return hash([
    message.providerAccountId,
    message.providerMessageId,
    message.direction,
    message.occurredAt.toISOString(),
    message.fromAddress,
    message.toAddresses,
    message.subject,
    message.inReplyTo ?? null,
  ])
}
function evidenceFrom(activity: OutreachActivity) {
  const parsed = prospectOutreachEvidenceSchema.safeParse(activity.evidence)
  return parsed.success && parsed.data.reviewerId === activity.actorId ? parsed.data : null
}
function addCalendarMonth(date: Date) {
  const out = new Date(date)
  const day = out.getUTCDate()
  out.setUTCDate(1)
  out.setUTCMonth(out.getUTCMonth() + 1)
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate()
  out.setUTCDate(Math.min(day, last))
  return out
}
export function projectProspectOutreachHistory(input: {
  canonicalOrganizationId: string
  organizationIds: readonly string[]
  contactIds?: readonly string[]
  expectedMailboxIds?: readonly string[]
  messages: readonly OutreachMessage[]
  activities: readonly OutreachActivity[]
  stages: readonly string[]
  contactHealth: ProspectOutreachHistoryProjection['contactHealth']
  customer: boolean
  hasUnsentDraft: boolean
  unresolved?: boolean
  now?: Date
}): ProspectOutreachHistoryProjection {
  const now = input.now ?? new Date()
  const evidence = [...input.activities]
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
    .map(evidenceFrom)
    .filter((item): item is ProspectOutreachEvidence => item !== null)
  // Canonical provider identity, not activities, send attempts or delivery events, defines one observation.
  let contradictory = false
  const seenFingerprints = new Map<string, string>()
  const seen = new Set<string>()
  const messages = [...input.messages]
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
    .filter((message) => {
      if (!message.providerAccountId || !message.providerMessageId) return true
      const key = JSON.stringify([message.providerAccountId, message.providerMessageId])
      if (seen.has(key)) {
        if (seenFingerprints.get(key) !== providerObservationFingerprint(message))
          contradictory = true
        return false
      }
      seen.add(key)
      seenFingerprints.set(key, providerObservationFingerprint(message))
      return true
    })
  const sentEvidenceIds = new Set<string>()
  const classifications = new Map<string, string>()
  for (const item of evidence) {
    if (item.kind !== 'message') continue
    const message = messages.find((message) => message.id === item.binding.messageId)
    if (
      message &&
      message.providerAccountId === item.binding.providerAccountId &&
      message.providerMessageId === item.binding.providerMessageId &&
      prospectOutreachMessageFingerprint(message) === item.binding.fingerprint
    ) {
      classifications.set(message.id, item.classification)
      if (item.observedSent && message.direction === 'OUTBOUND') sentEvidenceIds.add(message.id)
    }
  }
  const observed = messages.filter(
    (message) =>
      message.direction === 'INBOUND' ||
      ['SENT', 'DELIVERED'].includes(message.status) ||
      message.sentEvidence === true ||
      sentEvidenceIds.has(message.id),
  )
  const complete = evidence.some(
    (item) =>
      item.kind === 'complete' &&
      item.historyFingerprint ===
        prospectOutreachHistoryFingerprint(
          observed.filter((message) => {
            const coverage = item.coverage.find(
              (coverage) => coverage.providerAccountId === message.providerAccountId,
            )
            return coverage && message.occurredAt <= new Date(coverage.throughAt)
          }),
          input.organizationIds,
        ) &&
      JSON.stringify([...item.organizationIds].sort()) ===
        JSON.stringify([...input.organizationIds].sort()) &&
      (input.expectedMailboxIds ?? []).length > 0 &&
      JSON.stringify([...item.mailboxIds].sort()) ===
        JSON.stringify([...(input.expectedMailboxIds ?? [])].sort()) &&
      item.coverage.length === item.mailboxIds.length &&
      item.mailboxIds.every((id) =>
        item.coverage.some(
          (coverage) =>
            coverage.providerAccountId === id &&
            new Date(coverage.throughAt) <= now &&
            new Date(coverage.searchedAt) >= new Date(coverage.throughAt),
        ),
      ) &&
      JSON.stringify([...item.contactIds].sort()) ===
        JSON.stringify([...(input.contactIds ?? [])].sort()) &&
      observed.every(
        (message) =>
          message.providerAccountId && item.mailboxIds.includes(message.providerAccountId),
      ),
  )
  const unknown = observed.some((message) => {
    const classification = classifications.get(message.id)
    return (
      !message.providerAccountId ||
      !message.providerMessageId ||
      !classification ||
      classification === 'unknown' ||
      (message.direction === 'OUTBOUND'
        ? !['cold', 'warm'].includes(classification)
        : ['cold', 'warm'].includes(classification))
    )
  })
  const cold = observed.filter(
    (message) => message.direction === 'OUTBOUND' && classifications.get(message.id) === 'cold',
  )
  const humans = observed.filter(
    (message) => message.direction === 'INBOUND' && classifications.get(message.id) === 'human',
  )
  const first = humans[0]
  const beforeReply = first
    ? cold.filter((message) => message.occurredAt < first.occurredAt).length
    : 0
  const last = cold.at(-1)?.occurredAt ?? null
  const historyComplete = complete && !unknown && !input.unresolved && !contradictory
  let relationship: ProspectOutreachHistoryProjection['relationship'] = first
    ? 'inConversation'
    : cold.length
      ? 'awaitingReply'
      : 'prospect'
  if (
    input.stages.some((stage) =>
      ['REPLIED', 'CONVERSATION', 'QUALIFIED', 'PROPOSAL_DECISION'].includes(stage),
    )
  )
    relationship = 'inConversation'
  if (input.stages.includes('PARKED')) relationship = 'deferred'
  if (input.stages.includes('LOST')) relationship = 'declined'
  if (input.stages.includes('DO_NOT_CONTACT')) relationship = 'closed'
  const reviewedRelationship = evidence.filter((item) => item.kind === 'relationship').at(-1)
  if (
    reviewedRelationship?.kind === 'relationship' &&
    !['declined', 'closed', 'customer'].includes(relationship) &&
    reviewedRelationship.relationship !== 'prospect'
  )
    relationship = reviewedRelationship.relationship
  if (input.customer || input.stages.includes('WON')) relationship = 'customer'
  const reasons: string[] = []
  const stopped =
    ['declined', 'customer', 'closed'].includes(relationship) ||
    ['bounced', 'suppressed', 'policyBlocked'].includes(input.contactHealth) ||
    cold.length >= 3
  if (['declined', 'customer', 'closed', 'deferred', 'inConversation'].includes(relationship))
    reasons.push(relationship)
  if (input.contactHealth !== 'healthy') reasons.push(`contact_${input.contactHealth}`)
  if (!historyComplete) reasons.push('history_incomplete')
  if (input.unresolved) reasons.push('unresolved')
  if (input.hasUnsentDraft) reasons.push('existing_unsent_draft')
  if (cold.length >= 3) reasons.push('cold_sequence_complete')
  const next =
    last && cold.length === 1
      ? new Date(last.getTime() + 21 * 86400000)
      : last && cold.length === 2
        ? addCalendarMonth(last)
        : null
  if (next && now < next) reasons.push('cooldown')
  return {
    canonicalOrganizationId: input.canonicalOrganizationId,
    organizationIds: [...input.organizationIds],
    coldEmailCount: historyComplete && cold.length <= 3 ? (cold.length as 0 | 1 | 2 | 3) : null,
    lastColdEmailAt: last?.toISOString() ?? null,
    firstHumanReply: first
      ? historyComplete && beforeReply >= 1 && beforeReply <= 3
        ? (`after${beforeReply}` as 'after1' | 'after2' | 'after3')
        : 'otherUnknown'
      : historyComplete
        ? 'noReply'
        : 'otherUnknown',
    relationship,
    nextEligibleAt:
      !stopped && !['inConversation', 'deferred'].includes(relationship) && historyComplete
        ? (next?.toISOString() ?? null)
        : null,
    eligibility: stopped ? 'stopped' : reasons.length ? 'hold' : 'eligible',
    eligibilityReason: reasons[0] ?? 'eligible',
    reasons,
    contactHealth: input.contactHealth,
    historyComplete,
  }
}

export async function loadProspectOutreachHistory(
  reader: ProspectOutreachHistoryReader,
  organizationId: string,
  options: { now?: Date; excludeDraftId?: string; contactId?: string } = {},
): Promise<ProspectOutreachHistoryProjection> {
  let canonicalOrganizationId = organizationId
  const visited = new Set<string>()
  let unresolved = false
  while (!visited.has(canonicalOrganizationId)) {
    visited.add(canonicalOrganizationId)
    const organization = await reader.prospectOrganization.findUnique({
      where: { id: canonicalOrganizationId },
      select: { mergedIntoOrganizationId: true },
    })
    if (!organization) {
      unresolved = true
      break
    }
    if (!organization.mergedIntoOrganizationId) break
    if (visited.has(organization.mergedIntoOrganizationId)) {
      unresolved = true
      break
    }
    canonicalOrganizationId = organization.mergedIntoOrganizationId
  }
  const scopeActivities = await reader.prospectActivity.findMany({
    where: {
      OR: [
        { organizationId: canonicalOrganizationId },
        { evidence: { path: ['organizationIds'], array_contains: [canonicalOrganizationId] } },
      ],
    },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: { evidence: true, actorId: true, occurredAt: true },
  })
  const scopes = scopeActivities
    .map(evidenceFrom)
    .filter(
      (item): item is Extract<ProspectOutreachEvidence, { kind: 'scope' }> =>
        item?.kind === 'scope',
    )
  const scope = scopes.at(-1)
  if (
    new Set(
      scopes.map((item) =>
        JSON.stringify([item.canonicalOrganizationId, [...item.organizationIds].sort()]),
      ),
    ).size > 1
  )
    unresolved = true
  const organizationIds = new Set([canonicalOrganizationId])
  if (scope) {
    if (
      !scope.organizationIds.includes(canonicalOrganizationId) ||
      !scope.organizationIds.includes(scope.canonicalOrganizationId)
    )
      unresolved = true
    else {
      canonicalOrganizationId = scope.canonicalOrganizationId
      for (const id of scope.organizationIds) organizationIds.add(id)
    }
  }
  // Merge redirects and explicit reviewed parent scopes are authoritative; domain similarity is not.
  let frontier = [...organizationIds]
  while (frontier.length) {
    const merged = await reader.prospectOrganization.findMany({
      where: { mergedIntoOrganizationId: { in: frontier } },
      select: { id: true },
    })
    frontier = merged.map((item) => item.id).filter((id) => !organizationIds.has(id))
    for (const id of frontier) organizationIds.add(id)
  }
  const ids = [...organizationIds].sort()
  const overlappingScopes = await reader.prospectActivity.findMany({
    where: {
      OR: [
        { organizationId: { in: ids } },
        ...ids.map((id) => ({ evidence: { path: ['organizationIds'], array_contains: [id] } })),
      ],
    },
    select: { evidence: true, actorId: true, occurredAt: true },
  })
  for (const activity of overlappingScopes) {
    const claim = evidenceFrom(activity)
    if (
      claim?.kind === 'scope' &&
      (claim.canonicalOrganizationId !== canonicalOrganizationId ||
        JSON.stringify([...claim.organizationIds].sort()) !== JSON.stringify(ids))
    )
      unresolved = true
  }
  const [organizations, messages, activities, drafts, mailboxes, duplicates] = await Promise.all([
    reader.prospectOrganization.findMany({
      where: { id: { in: ids } },
      include: {
        opportunity: true,
        contacts: true,
        customerRelationships: true,
        emailThreads: { select: { id: true } },
      },
    }),
    reader.prospectEmailMessage.findMany({
      where: { organizationId: { in: ids } },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      include: { sendItem: { select: { sentAt: true } } },
    }),
    reader.prospectActivity.findMany({
      where: { organizationId: { in: ids } },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: { evidence: true, actorId: true, occurredAt: true },
    }),
    reader.prospectOutreachDraft.findMany({
      where: {
        organizationId: { in: ids },
        status: { in: ['NEEDS_REVIEW', 'APPROVED', 'QUEUED'] },
        ...(options.excludeDraftId ? { id: { not: options.excludeDraftId } } : {}),
      },
      select: { id: true },
    }),
    reader.correspondenceProviderAccount.findMany({
      where: { provider: 'GMAIL', capabilities: { has: 'RECEIVE' } },
      select: {
        id: true,
        mailboxAddress: true,
        lastSuccessfulSyncAt: true,
        connectionStatus: true,
      },
    }),
    reader.prospectDuplicateCandidate.findMany({
      where: {
        status: 'OPEN',
        OR: [{ organizationAId: { in: ids } }, { organizationBId: { in: ids } }],
      },
      select: { id: true },
    }),
  ])
  if (
    duplicates.length ||
    mailboxes.length === 0 ||
    mailboxes.some(
      (mailbox) =>
        mailbox.connectionStatus !== 'CONNECTED' ||
        !mailbox.lastSuccessfulSyncAt ||
        (options.now ?? new Date()).getTime() - mailbox.lastSuccessfulSyncAt.getTime() >
          5 * 60_000 ||
        mailbox.lastSuccessfulSyncAt > (options.now ?? new Date()),
    )
  )
    unresolved = true
  if (organizations.length !== ids.length) unresolved = true
  if (
    messages.some((message) => {
      const mailbox = mailboxes.find((mailbox) => mailbox.id === message.providerAccountId)
      return !mailbox?.lastSuccessfulSyncAt || message.occurredAt > mailbox.lastSuccessfulSyncAt
    })
  )
    unresolved = true
  const threadIds = organizations.flatMap((item) => item.emailThreads.map((thread) => thread.id))
  const addresses = organizations.flatMap((item) =>
    item.contacts.flatMap((contact) => (contact.normalizedEmail ? [contact.normalizedEmail] : [])),
  )
  const quarantine = await reader.prospectInboundQuarantine.findFirst({
    where: {
      status: 'OPEN',
      OR: [
        { candidateThreadIds: { hasSome: threadIds } },
        ...addresses.map((address) => ({
          messageSnapshot: { path: ['from'], array_contains: [{ email: address }] },
        })),
      ],
    },
    select: { id: true },
  })
  if (quarantine) unresolved = true
  const allContacts = organizations
    .flatMap((item) => item.contacts)
    .filter((item) => !item.archivedAt)
  const contacts = options.contactId
    ? allContacts.filter((item) => item.id === options.contactId)
    : allContacts
  const healthOverrides = new Map<string, string>()
  for (const activity of activities) {
    const evidence = evidenceFrom(activity)
    if (evidence?.kind !== 'contactHealth') continue
    const message = messages.find((item) => item.id === evidence.binding.messageId)
    const contact = allContacts.find((item) => item.id === evidence.contactId)
    if (
      message &&
      contact?.normalizedEmail?.toLowerCase() === evidence.recipientAddress.toLowerCase() &&
      message.direction === 'OUTBOUND' &&
      message.toAddresses.some(
        (address) => address.toLowerCase() === evidence.recipientAddress.toLowerCase(),
      ) &&
      message.providerAccountId === evidence.binding.providerAccountId &&
      message.providerMessageId === evidence.binding.providerMessageId &&
      prospectOutreachMessageFingerprint(message) === evidence.binding.fingerprint
    )
      healthOverrides.set(evidence.contactId, evidence.health)
  }
  let health: ProspectOutreachHistoryProjection['contactHealth'] = contacts.length
    ? 'unverified'
    : 'unknown'
  const healthyContact = contacts.some(
    (item) =>
      !['bounced', 'policyBlocked'].includes(healthOverrides.get(item.id) ?? '') &&
      item.emailReadiness === 'VALID' &&
      item.normalizedEmail &&
      !item.doNotContact &&
      !item.suppressedAt &&
      !item.unsubscribedAt &&
      !item.complainedAt &&
      !item.lastHardBounceAt &&
      !['OPTED_OUT', 'PROHIBITED'].includes(item.permissionState),
  )
  if (healthyContact) health = 'healthy'
  if (
    !healthyContact &&
    contacts.some((item) => item.lastHardBounceAt || healthOverrides.get(item.id) === 'bounced')
  )
    health = 'bounced'
  if (
    !healthyContact &&
    contacts.some(
      (item) =>
        item.doNotContact ||
        item.suppressedAt ||
        item.unsubscribedAt ||
        item.complainedAt ||
        item.permissionState === 'OPTED_OUT',
    )
  )
    health = 'suppressed'
  if (
    !healthyContact &&
    contacts.some(
      (item) =>
        item.permissionState === 'PROHIBITED' ||
        item.suppressionReason === 'PROVIDER_POLICY_BLOCK' ||
        healthOverrides.get(item.id) === 'policyBlocked',
    )
  )
    health = 'policyBlocked'
  return projectProspectOutreachHistory({
    canonicalOrganizationId,
    organizationIds: ids,
    contactIds: allContacts.map((item) => item.id),
    expectedMailboxIds: mailboxes.map((item) => item.id),
    messages: messages.map((message) => ({
      ...message,
      sentEvidence: Boolean(message.sendItem?.sentAt),
    })),
    activities,
    stages: organizations.flatMap((item) => (item.opportunity ? [item.opportunity.stage] : [])),
    contactHealth: health,
    customer: organizations.some((item) =>
      item.customerRelationships.some((relationship) => relationship.status === 'ACTIVE'),
    ),
    hasUnsentDraft: drafts.length > 0,
    unresolved,
    ...(options.now ? { now: options.now } : {}),
  })
}

/** Cold intent must be explicit and frozen with the reviewed draft; unknown is never a warm bypass. */
export function prospectDraftOutreachKind(snapshot: unknown): 'cold' | 'warm' | 'unknown' {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return 'unknown'
  const intent = (snapshot as Record<string, unknown>).outreachKind
  return intent === 'cold' || intent === 'warm' ? intent : 'unknown'
}
export async function requireProspectOutreachHistory(
  reader: ProspectOutreachHistoryReader,
  organizationId: string,
  snapshot: unknown,
  options: { now?: Date; excludeDraftId?: string; contactId?: string } = {},
) {
  const projection = await loadProspectOutreachHistory(reader, organizationId, options)
  const kind = prospectDraftOutreachKind(snapshot)
  if (kind === 'unknown')
    throw new ProspectOutreachHistoryError(
      'OUTREACH_HISTORY_HOLD: Explicit cold or warm intent is required',
    )
  if (kind === 'cold' && projection.eligibility !== 'eligible')
    throw new ProspectOutreachHistoryError(`OUTREACH_HISTORY_HOLD: ${projection.eligibilityReason}`)
  // Warm correspondence still respects account refusal and contact health, while conversation/cold cadence never blocks it.
  if (kind === 'warm') {
    if (projection.reasons.includes('unresolved') || projection.contactHealth !== 'healthy')
      throw new ProspectOutreachHistoryError(
        'OUTREACH_HISTORY_HOLD: Warm account identity or contact health requires review',
      )
    const anchor = z
      .object({ messageId: z.string().min(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u) })
      .safeParse((snapshot as Record<string, unknown>).warmReplyAnchor)
    if (!anchor.success)
      throw new ProspectOutreachHistoryError(
        'OUTREACH_HISTORY_HOLD: Warm correspondence requires an actual human reply anchor',
      )
    const message = await reader.prospectEmailMessage.findUnique({
      where: { id: anchor.data.messageId },
    })
    if (!options.contactId)
      throw new ProspectOutreachHistoryError(
        'OUTREACH_HISTORY_HOLD: Warm reply requires an exact target contact',
      )
    const target = await reader.prospectOrganization.findMany({
      where: { id: { in: projection.organizationIds } },
      select: {
        contacts: {
          where: { id: options.contactId, archivedAt: null },
          select: { normalizedEmail: true },
        },
      },
    })
    const targetAddress = target.flatMap((organization) => organization.contacts)[0]
      ?.normalizedEmail
    if (
      !targetAddress ||
      !message ||
      targetAddress.toLowerCase() !== message.fromAddress.toLowerCase()
    )
      throw new ProspectOutreachHistoryError(
        'OUTREACH_HISTORY_HOLD: Human reply anchor does not authorize the selected recipient',
      )
    const reviews = await reader.prospectActivity.findMany({
      where: { organizationId: { in: projection.organizationIds } },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: { evidence: true, actorId: true, occurredAt: true },
    })
    const classification = reviews
      .map(evidenceFrom)
      .filter(
        (item) => item?.kind === 'message' && item.binding.messageId === anchor.data.messageId,
      )
      .at(-1)
    if (
      !message ||
      !projection.organizationIds.includes(message.organizationId) ||
      message.direction !== 'INBOUND' ||
      prospectOutreachMessageFingerprint(message) !== anchor.data.fingerprint ||
      classification?.kind !== 'message' ||
      classification.classification !== 'human' ||
      classification.binding.fingerprint !== anchor.data.fingerprint
    )
      throw new ProspectOutreachHistoryError(
        'OUTREACH_HISTORY_HOLD: Warm anchor is not a current verified human reply',
      )
  }
  if (
    kind === 'warm' &&
    (['declined', 'closed'].includes(projection.relationship) ||
      ['bounced', 'suppressed', 'policyBlocked'].includes(projection.contactHealth))
  )
    throw new ProspectOutreachHistoryError(`OUTREACH_HISTORY_HOLD: ${projection.eligibilityReason}`)
  return projection
}

export async function planProspectOutreachEvidence(
  reader: ProspectOutreachHistoryReader,
  organizationId: string,
) {
  const projection = await loadProspectOutreachHistory(reader, organizationId)
  const [messages, organizations, mailboxes, activities] = await Promise.all([
    reader.prospectEmailMessage.findMany({
      where: { organizationId: { in: projection.organizationIds } },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      include: { sendItem: { select: { sentAt: true } } },
    }),
    reader.prospectOrganization.findMany({
      where: { id: { in: projection.organizationIds } },
      select: { contacts: { where: { archivedAt: null }, select: { id: true } } },
    }),
    reader.correspondenceProviderAccount.findMany({
      where: { provider: 'GMAIL', capabilities: { has: 'RECEIVE' } },
      select: {
        id: true,
        mailboxAddress: true,
        lastSuccessfulSyncAt: true,
        connectionStatus: true,
      },
    }),
    reader.prospectActivity.findMany({
      where: { organizationId: { in: projection.organizationIds } },
      select: { evidence: true, actorId: true, occurredAt: true },
    }),
  ])
  if (messages.length > 2000)
    throw new Error('Outreach evidence review exceeds the bounded 2000-message limit')
  const sentProof = activities
    .map(evidenceFrom)
    .filter(
      (item): item is Extract<ProspectOutreachEvidence, { kind: 'message' }> =>
        item?.kind === 'message' && item.observedSent === true,
    )
  const observed = messages.filter(
    (message) =>
      message.direction === 'INBOUND' ||
      ['SENT', 'DELIVERED'].includes(message.status) ||
      Boolean(message.sendItem?.sentAt) ||
      sentProof.some(
        (proof) =>
          proof.binding.messageId === message.id &&
          proof.binding.providerAccountId === message.providerAccountId &&
          proof.binding.providerMessageId === message.providerMessageId &&
          proof.binding.fingerprint === prospectOutreachMessageFingerprint(message),
      ),
  )
  return {
    projection,
    organizationIds: projection.organizationIds,
    contactIds: organizations.flatMap((item) => item.contacts.map((contact) => contact.id)).sort(),
    mailboxes,
    historyFingerprint: prospectOutreachHistoryFingerprint(observed, projection.organizationIds),
    messages: observed.map((message) => ({
      messageId: message.id,
      organizationId: message.organizationId,
      providerAccountId: message.providerAccountId,
      providerMessageId: message.providerMessageId,
      fingerprint: prospectOutreachMessageFingerprint(message),
      direction: message.direction,
      status: message.status,
      occurredAt: message.occurredAt.toISOString(),
      subject: message.subject,
      fromAddress: message.fromAddress,
      toAddresses: message.toAddresses,
    })),
  }
}
/** Append-only, operation-idempotent review. No mailbox/provider mutation or send authority. */
export async function recordProspectOutreachEvidenceAction(
  input: {
    organizationId: string
    operationId: string
    evidence: unknown
    actor:
      | { type: 'HUMAN'; role: 'PLATFORM_ADMIN'; id: string }
      | { type: 'AGENT'; id: string; capabilities: readonly string[] }
  },
  client: typeof db = db,
) {
  if (
    !input.actor.id ||
    (input.actor.type === 'HUMAN'
      ? input.actor.role !== 'PLATFORM_ADMIN'
      : !input.actor.capabilities.includes('prospects:outreach-history:reconcile'))
  )
    throw new Error('Outreach history reconciliation authority is required')
  const operationId = z.string().uuid().parse(input.operationId)
  const rawEvidence =
    input.evidence && typeof input.evidence === 'object' && !Array.isArray(input.evidence)
      ? (input.evidence as Record<string, unknown>)
      : {}
  const evidence = prospectOutreachEvidenceSchema.parse({
    ...rawEvidence,
    reviewerType: input.actor.type,
  })
  if (
    input.actor.type === 'AGENT' &&
    evidence.kind === 'relationship' &&
    evidence.relationship === 'prospect'
  )
    throw new Error('Reconciliation cannot clear relationship stops')
  if (input.actor.type === 'AGENT' && evidence.kind === 'scope')
    throw new Error('Canonical parent identity requires human review')
  if (evidence.reviewerId !== input.actor.id)
    throw new Error('Review actor must match evidence reviewer')
  return client.$transaction(async (tx) => {
    const receiptKey = `outreach-history:${operationId}`
    const existing = await tx.prospectActivity.findUnique({
      where: { externalReceiptKey: receiptKey },
    })
    if (existing) {
      if (
        existing.organizationId !== input.organizationId ||
        hash(existing.evidence) !== hash(evidence)
      )
        throw new Error('Evidence operation id was already used with different content')
      return { activityId: existing.id, inserted: false }
    }
    const plan = await planProspectOutreachEvidence(tx, input.organizationId)
    if (evidence.kind === 'message' || evidence.kind === 'contactHealth') {
      const message = plan.messages.find(
        (message) => message.messageId === evidence.binding.messageId,
      )
      if (
        !message ||
        message.providerAccountId !== evidence.binding.providerAccountId ||
        message.providerMessageId !== evidence.binding.providerMessageId ||
        message.fingerprint !== evidence.binding.fingerprint
      )
        throw new Error('Evidence is not bound to a current canonical provider message')
      if (
        evidence.kind === 'message' &&
        (message.direction === 'OUTBOUND'
          ? !['cold', 'warm', 'unknown'].includes(evidence.classification)
          : ['cold', 'warm'].includes(evidence.classification))
      )
        throw new Error('Message classification conflicts with direction')
      if (evidence.kind === 'contactHealth') {
        if (!plan.contactIds.includes(evidence.contactId))
          throw new Error('Health evidence contact is outside the account scope')
        const contact = await tx.prospectContact.findUnique({
          where: { id: evidence.contactId },
          select: { normalizedEmail: true },
        })
        if (
          !contact?.normalizedEmail ||
          contact.normalizedEmail.toLowerCase() !== evidence.recipientAddress.toLowerCase() ||
          !message.toAddresses.some(
            (address) => address.toLowerCase() === evidence.recipientAddress.toLowerCase(),
          ) ||
          message.direction !== 'OUTBOUND'
        )
          throw new Error(
            'Delivery health evidence must bind the exact original outbound recipient address',
          )
      }
    }
    if (evidence.kind === 'complete') {
      if (
        evidence.historyFingerprint !== plan.historyFingerprint ||
        JSON.stringify([...evidence.organizationIds].sort()) !==
          JSON.stringify(plan.organizationIds) ||
        JSON.stringify([...evidence.contactIds].sort()) !== JSON.stringify(plan.contactIds) ||
        JSON.stringify([...evidence.mailboxIds].sort()) !==
          JSON.stringify(plan.mailboxes.map((item) => item.id).sort())
      )
        throw new Error('History, contacts or expected mailbox coverage changed; review again')
      for (const mailbox of plan.mailboxes) {
        const coverage = evidence.coverage.find((item) => item.providerAccountId === mailbox.id)
        if (
          !coverage ||
          coverage.mailboxAddress.toLowerCase() !== mailbox.mailboxAddress.toLowerCase() ||
          new Date(coverage.throughAt) > new Date() ||
          new Date(coverage.searchedAt) < new Date(coverage.throughAt)
        )
          throw new Error('Each expected mailbox requires completed full-search provenance')
      }
    }
    if (evidence.kind === 'scope') {
      if (
        input.organizationId !== evidence.canonicalOrganizationId ||
        !evidence.organizationIds.includes(input.organizationId) ||
        new Set(evidence.organizationIds).size !== evidence.organizationIds.length
      )
        throw new Error('Explicit parent scope is invalid')
      const organizations = await tx.prospectOrganization.findMany({
        where: { id: { in: evidence.organizationIds } },
        select: { id: true, mergedIntoOrganizationId: true },
      })
      if (
        organizations.length !== evidence.organizationIds.length ||
        organizations.some(
          (item) =>
            item.mergedIntoOrganizationId &&
            !evidence.organizationIds.includes(item.mergedIntoOrganizationId),
        )
      )
        throw new Error('Explicit parent scope conflicts with canonical merges')
    }
    const activity = await tx.prospectActivity.create({
      data: {
        organizationId: input.organizationId,
        type: 'NOTE_ADDED',
        summary: `Outreach history ${evidence.kind} reviewed`,
        evidence,
        actorId: input.actor.id,
        externalReceiptKey: receiptKey,
      },
    })
    return { activityId: activity.id, inserted: true }
  })
}
/** Machine evidence is limited to provider normalization and already-approved sent intent. */
export async function recordProspectOutreachMessageEvidence(
  reader: Pick<Transaction, 'prospectActivity'>,
  message: OutreachMessage,
  classification: 'cold' | 'warm' | 'automated' | 'outOfOffice' | 'unknown',
  actorId: string,
  reason: string,
) {
  if (!message.providerAccountId || !message.providerMessageId) return
  const evidence = prospectOutreachEvidenceSchema.parse({
    schema: OUTREACH_EVIDENCE_SCHEMA,
    kind: 'message',
    reviewerType: 'SYSTEM',
    reviewerId: actorId,
    reason,
    classification,
    ...(message.direction === 'OUTBOUND' && message.status === 'SENT'
      ? { observedSent: true }
      : {}),
    binding: {
      messageId: message.id,
      providerAccountId: message.providerAccountId,
      providerMessageId: message.providerMessageId,
      fingerprint: prospectOutreachMessageFingerprint(message),
    },
  })
  const externalReceiptKey = `outreach-message:${hash([message.providerAccountId, message.providerMessageId, classification, prospectOutreachMessageFingerprint(message)])}`
  await reader.prospectActivity.createMany({
    data: [
      {
        organizationId: message.organizationId,
        type: 'NOTE_ADDED',
        summary: 'Provider message outreach classification recorded',
        evidence,
        actorId,
        externalReceiptKey,
        occurredAt: message.occurredAt,
      },
    ],
    skipDuplicates: true,
  })
}

/** Imports only externally observed provider metadata. Attempts/drafts cannot enter this path. */
export async function reconcileProspectObservedMessageAction(
  input: {
    organizationId: string
    providerAccountId: string
    providerMessageId: string
    providerThreadId: string
    direction: 'INBOUND' | 'OUTBOUND'
    occurredAt: Date
    fromAddress: string
    toAddresses: string[]
    subject: string
    internetMessageId?: string | null
    inReplyTo?: string | null
    providerLabelIds: readonly string[]
    sourceReceiptId: string
    sourceReceiptSha256: string
    classification:
      | 'cold'
      | 'warm'
      | 'human'
      | 'automated'
      | 'outOfOffice'
      | 'bounce'
      | 'policyBlocked'
      | 'unknown'
    actor: { type: 'AGENT'; id: string; capabilities: readonly string[] }
    dryRun?: boolean
  },
  client: typeof db = db,
) {
  if (!input.actor.id || !input.actor.capabilities.includes('prospects:outreach-history:reconcile'))
    throw new Error('Reconciliation capability required')
  if (
    !input.sourceReceiptId.trim() ||
    !/^[a-f0-9]{64}$/u.test(input.sourceReceiptSha256) ||
    !input.providerMessageId.trim() ||
    !input.providerThreadId.trim() ||
    !Number.isFinite(input.occurredAt.getTime())
  )
    throw new Error('Verified source receipt and provider identities required')
  if (input.direction === 'OUTBOUND' && !input.providerLabelIds.includes('SENT'))
    throw new Error('Outbound history requires observed provider SENT, never a draft or attempt')
  return client.$transaction(async (tx) => {
    const account = await tx.correspondenceProviderAccount.findUnique({
      where: { id: input.providerAccountId },
      select: { provider: true, mailboxAddress: true },
    })
    const organization = await tx.prospectOrganization.findUnique({
      where: { id: input.organizationId },
      select: { id: true },
    })
    if (!account || account.provider !== 'GMAIL' || !organization)
      throw new Error('Canonical Gmail mailbox and organization required')
    if (
      input.direction === 'OUTBOUND'
        ? input.fromAddress.toLowerCase() !== account.mailboxAddress.toLowerCase()
        : !input.toAddresses.some(
            (address) => address.toLowerCase() === account.mailboxAddress.toLowerCase(),
          )
    )
      throw new Error('Provider observation mailbox scope mismatch')
    const identity = {
      providerAccountId: input.providerAccountId,
      providerMessageId: input.providerMessageId,
    }
    const existing = await tx.prospectEmailMessage.findUnique({
      where: { providerAccountId_providerMessageId: identity },
    })
    if (existing && existing.organizationId !== input.organizationId)
      throw new Error(
        'Observed message already belongs to another canonical account; resolve identity first',
      )
    if (
      existing &&
      providerObservationFingerprint(existing) !==
        providerObservationFingerprint({
          ...existing,
          direction: input.direction,
          occurredAt: input.occurredAt,
          fromAddress: input.fromAddress,
          toAddresses: input.toAddresses,
          subject: input.subject,
          inReplyTo: input.inReplyTo ?? null,
        })
    )
      throw new Error(
        'Observed provider identity has conflicting source metadata; reconcile before classifying',
      )
    if (
      input.direction === 'OUTBOUND'
        ? !['cold', 'warm', 'unknown'].includes(input.classification)
        : ['cold', 'warm'].includes(input.classification)
    )
      throw new Error('Message classification conflicts with observed direction')
    if (input.dryRun !== false)
      return { inserted: false, dryRun: true, messageId: existing?.id ?? null }
    const threadIdentity = hash([
      input.providerAccountId,
      input.providerThreadId,
      input.organizationId,
    ])
    const mapping = await tx.prospectEmailThreadProvider.findUnique({
      where: {
        providerAccountId_providerThreadId: {
          providerAccountId: input.providerAccountId,
          providerThreadId: input.providerThreadId,
        },
      },
      include: { thread: true },
    })
    if (mapping && mapping.thread.organizationId !== input.organizationId)
      throw new Error('Provider thread already belongs to another canonical account')
    const thread =
      mapping?.thread ??
      (await tx.prospectEmailThread.upsert({
        where: { replyTokenHash: threadIdentity },
        create: {
          organizationId: input.organizationId,
          subject: input.subject,
          replyTokenHash: threadIdentity,
          lastMessageAt: input.occurredAt,
        },
        update: {},
      }))
    await tx.prospectEmailThreadProvider.upsert({
      where: {
        providerAccountId_providerThreadId: {
          providerAccountId: input.providerAccountId,
          providerThreadId: input.providerThreadId,
        },
      },
      create: {
        threadId: thread.id,
        providerAccountId: input.providerAccountId,
        providerThreadId: input.providerThreadId,
      },
      update: {},
    })
    await tx.prospectEmailThread.updateMany({
      where: {
        id: thread.id,
        OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: input.occurredAt } }],
      },
      data: { lastMessageAt: input.occurredAt },
    })
    const message =
      existing ??
      (await tx.prospectEmailMessage.create({
        data: {
          ...identity,
          organizationId: input.organizationId,
          threadId: thread.id,
          direction: input.direction,
          status: input.direction === 'OUTBOUND' ? 'SENT' : 'RECEIVED',
          occurredAt: input.occurredAt,
          fromAddress: input.fromAddress,
          toAddresses: input.toAddresses,
          subject: input.subject,
          internetMessageId: input.internetMessageId ?? null,
          inReplyTo: input.inReplyTo ?? null,
          sourceReference: `https://mail.google.com/mail/u/${encodeURIComponent(account.mailboxAddress)}/#all/${encodeURIComponent(input.providerMessageId)}`,
        },
      }))
    const evidence = prospectOutreachEvidenceSchema.parse({
      schema: OUTREACH_EVIDENCE_SCHEMA,
      kind: 'message',
      reviewerType: 'AGENT',
      reviewerId: input.actor.id,
      reason: `Provider metadata receipt ${input.sourceReceiptId}; sha256 ${input.sourceReceiptSha256}`,
      binding: {
        messageId: message.id,
        ...identity,
        fingerprint: prospectOutreachMessageFingerprint(message),
      },
      classification: input.classification,
      ...(input.direction === 'OUTBOUND' ? { observedSent: true } : {}),
    })
    const externalReceiptKey = `outreach-reconcile:${hash([identity, input.sourceReceiptSha256, input.classification, prospectOutreachMessageFingerprint(message)])}`
    await tx.prospectActivity.createMany({
      data: [
        {
          organizationId: input.organizationId,
          type: 'NOTE_ADDED',
          summary: 'Observed provider message history reconciled',
          evidence,
          actorId: input.actor.id,
          externalReceiptKey,
        },
      ],
      skipDuplicates: true,
    })

    return { inserted: !existing, dryRun: false, messageId: message.id }
  })
}

/** Unknown inbound still stops delivery; only current source-bound automated classifications are exempt. */
export async function isProspectKnownAutomatedReply(
  reader: Pick<Transaction, 'prospectActivity'>,
  message: OutreachMessage,
): Promise<boolean> {
  if (!message.providerAccountId || !message.providerMessageId || !message.organizationId)
    return false
  const activities = await reader.prospectActivity.findMany({
    where: { organizationId: message.organizationId },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: { evidence: true, actorId: true, occurredAt: true },
  })
  const classification = activities
    .map(evidenceFrom)
    .filter(
      (item) =>
        item?.kind === 'message' &&
        item.binding.messageId === message.id &&
        item.binding.providerAccountId === message.providerAccountId &&
        item.binding.providerMessageId === message.providerMessageId &&
        item.binding.fingerprint === prospectOutreachMessageFingerprint(message),
    )
    .at(-1)
  return (
    classification?.kind === 'message' &&
    ['automated', 'outOfOffice', 'bounce'].includes(classification.classification)
  )
}
