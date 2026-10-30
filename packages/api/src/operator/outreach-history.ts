import { planProspectOutreachEvidence, type ProspectOutreachEvidence } from '@pathfinder/db'
import type { OperatorDatabase } from './audit'
import { grantCoversTenant, OperatorNotFoundError } from './grants'
import type { OperatorKindContext, OperatorApplyContext } from './proposals'
import { redactAddresses } from './crm-projection'

export async function requireOutreachAccount(
  organizationId: string,
  context: Pick<OperatorKindContext, 'database' | 'grant'>,
) {
  const row = await context.database.prospectOrganization.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      conversion: { select: { tenantId: true } },
      customerRelationships: { where: { status: 'ACTIVE' }, select: { tenantId: true } },
    },
  })
  if (
    !row ||
    [
      ...(row.conversion ? [row.conversion.tenantId] : []),
      ...row.customerRelationships.map((item) => item.tenantId),
    ].some((id) => !grantCoversTenant(context.grant, id))
  )
    throw new OperatorNotFoundError()
}
export async function requireOutreachGroupScope(
  organizationIds: readonly string[],
  context: Pick<OperatorKindContext, 'database' | 'grant'>,
) {
  // Every member may own a customer relationship; checking only the requested alias leaks groups.
  for (const id of new Set(organizationIds)) await requireOutreachAccount(id, context)
}
export async function readOutreachHistoryState(database: OperatorDatabase, organizationId: string) {
  const plan = await planProspectOutreachEvidence(database, organizationId)
  const revision = plan.revision
  return { plan, revision }
}
/** The operator is the agent making this evidence claim; a delegated admin is not relabeled its reviewer. */
export function outreachReviewActor(context: OperatorApplyContext) {
  return {
    type: 'AGENT' as const,
    id: `operator:${context.grant.grantId}`,
    capabilities: ['prospects:outreach-history:reconcile'],
  }
}
export function readableOutreachReason(reason: string) {
  const labels: Record<string, string> = {
    eligible: 'Ready for the next outreach step',
    history_incomplete: 'Outreach history needs review',
    unresolved: 'Account identity or mailbox coverage needs review',
    existing_unsent_draft: 'An unsent draft already exists',
    cold_sequence_complete: 'Three cold emails sent; sequence complete',
    cooldown: 'Follow-up interval has not elapsed',
    inConversation: 'Human conversation; use a reviewed reply',
    deferred: 'Outreach deferred',
    declined: 'The recipient declined',
    customer: 'Existing customer relationship',
    closed: 'Relationship closed',
  }
  return labels[reason] ?? reason.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
}
export function publicOutreachEvidence(evidence: unknown): unknown {
  if (Array.isArray(evidence)) return evidence.map(publicOutreachEvidence)
  if (evidence && typeof evidence === 'object')
    return Object.fromEntries(
      Object.entries(evidence).map(([key, value]) => [
        key,
        ['recipientAddress', 'mailboxAddress'].includes(key)
          ? '[address withheld; server binds the current record]'
          : publicOutreachEvidence(value),
      ]),
    )
  return typeof evidence === 'string' ? redactAddresses(evidence) : evidence
}
export type ReviewChange =
  | {
      kind: 'message'
      messageId: string
      classification:
        | 'cold'
        | 'warm'
        | 'human'
        | 'automated'
        | 'outOfOffice'
        | 'bounce'
        | 'policyBlocked'
        | 'unknown'
    }
  | {
      kind: 'relationship'
      relationship: 'prospect' | 'deferred' | 'declined' | 'closed'
      deferUntil?: string | null | undefined
    }
  | {
      kind: 'contactHealth'
      contactId: string
      messageId: string
      health: 'bounced' | 'policyBlocked' | 'healthy'
    }
  | {
      kind: 'complete'
      coverage: {
        providerAccountId: string
        searchedAt: string
        throughAt: string
        query: string
        sourceReceiptId: string
        resultFingerprint: string
      }[]
    }
export async function bindOutreachReview(
  database: OperatorDatabase,
  organizationId: string,
  change: ReviewChange,
  reviewerId: string,
  reason: string,
): Promise<ProspectOutreachEvidence> {
  const { plan } = await readOutreachHistoryState(database, organizationId)
  const base = {
    schema: 'prospect-outreach-history/v1' as const,
    reviewerId,
    reviewerType: 'AGENT' as const,
    reason,
  }
  if (change.kind === 'relationship')
    return {
      ...base,
      kind: 'relationship',
      relationship: change.relationship,
      deferUntil: change.deferUntil ?? null,
    }
  if (change.kind === 'complete')
    return {
      ...base,
      kind: 'complete',
      historyFingerprint: plan.historyFingerprint,
      organizationIds: plan.organizationIds,
      contactIds: plan.contactIds,
      mailboxIds: plan.mailboxes.map((item) => item.id),
      coverage: change.coverage.map((item) => {
        const mailbox = plan.mailboxes.find((mailbox) => mailbox.id === item.providerAccountId)
        if (!mailbox) throw new Error('Coverage names a mailbox outside this history plan')
        return { ...item, mailboxAddress: mailbox.mailboxAddress, complete: true as const }
      }),
    }
  const message = plan.messages.find((item) => item.messageId === change.messageId)
  if (!message?.providerAccountId || !message.providerMessageId)
    throw new Error('Select a current source-bound provider message from get_outreach_history')
  const binding = {
    messageId: message.messageId,
    providerAccountId: message.providerAccountId,
    providerMessageId: message.providerMessageId,
    fingerprint: message.fingerprint,
  }
  if (change.kind === 'message')
    return { ...base, kind: 'message', binding, classification: change.classification }
  const contact = await database.prospectContact.findFirst({
    where: { id: change.contactId, organizationId: { in: plan.organizationIds }, archivedAt: null },
    select: { normalizedEmail: true },
  })
  if (!contact?.normalizedEmail)
    throw new Error('The selected contact has no current address in this account scope')
  return {
    ...base,
    kind: 'contactHealth',
    binding,
    contactId: change.contactId,
    recipientAddress: contact.normalizedEmail,
    health: change.health,
  }
}
