import { db } from '../client'
import { isIP } from 'node:net'
import { writeAuditLogStrict } from './audit'
import { prospectOperationalContentHash } from './prospect-launch-attachments'
import {
  detectProspectDraftEscalations,
  PROSPECT_OUTREACH_COMPANY_SENDER,
  ProspectOutreachError,
} from './prospect-outreach-actions'

type HumanActor = { type: 'HUMAN'; id: string; role: 'PLATFORM_ADMIN' }
type Client = typeof db

function requireHuman(actor: HumanActor) {
  if (!actor.id || actor.type !== 'HUMAN' || actor.role !== 'PLATFORM_ADMIN') {
    throw new ProspectOutreachError(
      'APPROVAL_REQUIRED',
      'A human platform administrator is required',
    )
  }
}

export function isTerminalProspectOutreachImportRow(
  row: {
    status: string
    import: { status: string; failedRows: number; duplicateRows: number }
  } | null,
): boolean {
  return Boolean(
    row &&
    row.status === 'IMPORTED' &&
    ['COMPLETE', 'PARTIAL'].includes(row.import.status) &&
    row.import.failedRows === 0 &&
    row.import.duplicateRows === 0,
  )
}

function normalizedContactEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new ProspectOutreachError('INVALID_INPUT', 'A valid sourced contact email is required')
  }
  return email
}

const OPERATOR_SOURCE_LABEL = 'Operator-supplied public contact page'

function publicHttpsSourceUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new ProspectOutreachError('INVALID_INPUT', 'A public HTTPS source page is required')
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  const reservedSuffix = /\.(?:localhost|local|test|example|invalid|internal|onion)$/u
  const ipv4 = (isIP(host) === 4 ? host.split('.').map(Number) : null) as
    | [number, number, number, number]
    | null
  const privateIpv4 =
    ipv4 &&
    (ipv4?.[0] === 0 ||
      ipv4?.[0] === 10 ||
      ipv4?.[0] === 127 ||
      (ipv4?.[0] === 169 && (ipv4?.[1] ?? 0) === 254) ||
      (ipv4?.[0] === 172 && (ipv4?.[1] ?? 0) >= 16 && (ipv4?.[1] ?? 0) <= 31) ||
      (ipv4?.[0] === 192 && (ipv4?.[1] ?? 0) === 168) ||
      (ipv4?.[0] ?? 0) >= 224)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !host.includes('.') ||
    reservedSuffix.test(host) ||
    isIP(host) === 6 ||
    privateIpv4
  ) {
    throw new ProspectOutreachError('INVALID_INPUT', 'A public HTTPS source page is required')
  }
  url.hash = ''
  return url.toString()
}

/** Append operator-supplied public-page evidence to an existing campaign contact. */
export async function appendProspectCampaignEmailSourceEvidenceAction(
  input: {
    memberId: string
    email: string
    sourceUrl: string
    sourceLabel?: string
    actor: HumanActor
  },
  client: Client = db,
) {
  requireHuman(input.actor)
  const email = normalizedContactEmail(input.email)
  const sourceUrl = publicHttpsSourceUrl(input.sourceUrl)
  const sourceLabel = input.sourceLabel?.trim() || OPERATOR_SOURCE_LABEL
  if (
    !input.memberId.trim() ||
    sourceLabel.length > 300 ||
    /[\u0000-\u001f\u007f]/u.test(sourceLabel)
  )
    throw new ProspectOutreachError('INVALID_INPUT', 'A bounded source page label is required')

  return client.$transaction(
    async (tx) => {
      const member = await tx.prospectCampaignMember.findUnique({
        where: { id: input.memberId },
        include: {
          campaign: true,
          organization: true,
          venue: true,
          contact: true,
          drafts: { select: { id: true }, take: 1 },
          sendItems: { select: { id: true }, take: 1 },
        },
      })
      if (!member) throw new ProspectOutreachError('NOT_FOUND', 'Campaign member not found')
      if (
        member.campaign.status !== 'DRAFT' ||
        member.campaign.pausedAt ||
        member.status !== 'SELECTED' ||
        member.drafts.length ||
        member.sendItems.length ||
        member.organization.archivedAt ||
        !member.venueId ||
        !member.venue ||
        member.venue.archivedAt ||
        !member.contact ||
        member.contact.archivedAt ||
        member.contactId !== member.contact.id ||
        member.contact.organizationId !== member.organizationId ||
        member.contact.venueId !== member.venueId
      )
        throw new ProspectOutreachError(
          'CONFLICT',
          'An undrafted selected campaign member with an existing same-venue contact is required',
        )

      const duplicateCandidate = await tx.prospectDuplicateCandidate.findFirst({
        where: {
          status: { in: ['OPEN', 'CONFIRMED_DUPLICATE'] },
          OR: [
            { organizationAId: member.organizationId },
            { organizationBId: member.organizationId },
          ],
        },
        select: { id: true },
      })
      if (duplicateCandidate)
        throw new ProspectOutreachError(
          'CONFLICT',
          'Unresolved organization identity or alias evidence blocks source capture',
        )

      const capturedValue = {
        email,
        sourcePage: sourceUrl,
        captureMethod: 'operator_supplied',
        emailVerified: false,
        permissionApproved: false,
      }
      const candidates = await tx.prospectSourceEvidence.findMany({
        where: {
          organizationId: member.organizationId,
          venueId: member.venueId,
          contactId: null,
          sourceType: 'WEBSITE',
          sourceUrl,
          createdBy: input.actor.id,
        },
        orderBy: { createdAt: 'asc' },
        take: 20,
        select: { id: true, capturedValue: true, sourceUrl: true },
      })
      const prior = candidates.find((row) => {
        const priorValue = row.capturedValue
        if (!priorValue || typeof priorValue !== 'object' || Array.isArray(priorValue)) return false
        const record = priorValue as Record<string, unknown>
        return (
          record.email === email &&
          record.sourcePage === sourceUrl &&
          record.captureMethod === 'operator_supplied' &&
          record.emailVerified === false &&
          record.permissionApproved === false
        )
      })
      if (prior)
        return { id: prior.id, sourceUrl: prior.sourceUrl, capturedValue, idempotent: true }
      if (candidates.length)
        throw new ProspectOutreachError(
          'CONFLICT',
          'A source page is already recorded with different email evidence',
        )

      const evidence = await tx.prospectSourceEvidence.create({
        data: {
          organizationId: member.organizationId,
          venueId: member.venueId,
          contactId: null,
          sourceType: 'WEBSITE',
          sourceUrl,
          sourceLabel,
          capturedValue,
          createdBy: input.actor.id,
        },
        select: { id: true, sourceUrl: true, capturedValue: true },
      })
      await tx.prospectActivity.create({
        data: {
          organizationId: member.organizationId,
          venueId: member.venueId,
          contactId: null,
          type: 'RESEARCH_ADDED',
          summary: 'Operator-supplied public page recorded for contact review',
          evidence: {
            sourceEvidenceId: evidence.id,
            sourceUrl,
            email,
            emailVerified: false,
            permissionApproved: false,
          },
          actorId: input.actor.id,
        },
      })
      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'prospect.outreach-contact.source-evidence-appended',
          targetType: 'ProspectSourceEvidence',
          targetId: evidence.id,
          afterState: {
            memberId: member.id,
            organizationId: member.organizationId,
            venueId: member.venueId,
            contactId: member.contactId,
            sourceUrl,
            email,
            emailVerified: false,
            permissionApproved: false,
          },
        },
        tx,
      )
      return { ...evidence, idempotent: false }
    },
    { isolationLevel: 'Serializable' },
  )
}

async function readSelectableMember(tx: Client, memberId: string) {
  const member = await tx.prospectCampaignMember.findUnique({
    where: { id: memberId },
    include: {
      campaign: true,
      organization: { include: { opportunity: true } },
      venue: true,
      drafts: { select: { id: true }, take: 1 },
      sendItems: { select: { id: true }, take: 1 },
    },
  })
  if (!member) throw new ProspectOutreachError('NOT_FOUND', 'Campaign member not found')
  if (
    member.campaign.status !== 'DRAFT' ||
    member.campaign.pausedAt ||
    member.status !== 'SELECTED' ||
    member.drafts.length ||
    member.sendItems.length ||
    member.organization.archivedAt ||
    !member.venueId ||
    !member.venue ||
    member.venue.archivedAt
  ) {
    throw new ProspectOutreachError(
      'CONFLICT',
      'Only an undrafted selected member in an active draft campaign can change contact route',
    )
  }
  return member
}

/** Append a source-backed venue contact in review-required state; this never grants permission. */
export async function addSourcedProspectCampaignContactAction(
  input: {
    memberId: string
    email: string
    sourceEvidenceId: string
    fullName?: string
    title?: string
    actor: HumanActor
  },
  client: Client = db,
) {
  requireHuman(input.actor)
  const email = normalizedContactEmail(input.email)
  if (!input.memberId.trim() || !input.sourceEvidenceId.trim())
    throw new ProspectOutreachError('INVALID_INPUT', 'Member and source evidence IDs are required')

  return client.$transaction(
    async (tx) => {
      const member = await readSelectableMember(tx as Client, input.memberId)
      const evidence = await tx.prospectSourceEvidence.findUnique({
        where: { id: input.sourceEvidenceId },
        select: {
          id: true,
          organizationId: true,
          venueId: true,
          contactId: true,
          sourceUrl: true,
          sourceType: true,
          capturedValue: true,
        },
      })
      const captured = evidence?.capturedValue
      const evidenceEmail =
        captured && typeof captured === 'object' && !Array.isArray(captured)
          ? (captured as Record<string, unknown>).email
          : undefined
      if (
        !evidence ||
        evidence.organizationId !== member.organizationId ||
        evidence.venueId !== member.venueId ||
        (evidence.contactId !== null && evidence.contactId !== member.contactId) ||
        typeof evidenceEmail !== 'string' ||
        normalizedContactEmail(evidenceEmail) !== email ||
        !evidence.sourceUrl?.trim()
      ) {
        throw new ProspectOutreachError(
          'CONFLICT',
          'Source evidence must identify this venue and the exact contact email',
        )
      }
      const [sameOrgEmail, duplicateCandidate] = await Promise.all([
        tx.prospectContact.findFirst({
          where: {
            organizationId: member.organizationId,
            normalizedEmail: { equals: email, mode: 'insensitive' },
          },
          select: { id: true },
        }),
        tx.prospectDuplicateCandidate.findFirst({
          where: {
            status: { in: ['OPEN', 'CONFIRMED_DUPLICATE'] },
            OR: [
              { organizationAId: member.organizationId },
              { organizationBId: member.organizationId },
            ],
          },
          select: { id: true },
        }),
      ])
      if (sameOrgEmail)
        throw new ProspectOutreachError(
          'CONFLICT',
          'This organization already has that email route',
        )
      if (duplicateCandidate)
        throw new ProspectOutreachError(
          'CONFLICT',
          'Unresolved organization identity or alias evidence blocks contact creation',
        )

      const contact = await tx.prospectContact.create({
        data: {
          organizationId: member.organizationId,
          venueId: member.venueId,
          fullName: input.fullName?.trim() || null,
          title: input.title?.trim() || null,
          email,
          normalizedEmail: email,
          source: `SOURCE_EVIDENCE:${evidence.id}`,
          provenance: [{ evidenceId: evidence.id, sourceUrl: evidence.sourceUrl }],
          emailReadiness: 'REVIEW_REQUIRED',
          permissionState: 'REVIEW_REQUIRED',
          permissionEvidence: { sourceEvidenceId: evidence.id, approvalGranted: false },
          createdBy: input.actor.id,
          updatedBy: input.actor.id,
        },
      })
      await tx.prospectActivity.create({
        data: {
          organizationId: member.organizationId,
          venueId: member.venueId,
          contactId: contact.id,
          type: 'CONTACT_ADDED',
          summary: 'Source-backed contact added for campaign routing review',
          evidence: { sourceEvidenceId: evidence.id, sourceUrl: evidence.sourceUrl },
          actorId: input.actor.id,
        },
      })
      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'prospect.outreach-contact.source-added',
          targetType: 'ProspectContact',
          targetId: contact.id,
          afterState: {
            organizationId: member.organizationId,
            venueId: member.venueId,
            sourceEvidenceId: evidence.id,
            email,
            emailReadiness: 'REVIEW_REQUIRED',
            permissionState: 'REVIEW_REQUIRED',
          },
        },
        tx,
      )
      return contact
    },
    { isolationLevel: 'Serializable' },
  )
}

/** Change only contactId on the same selected member after verifying exact venue identity. */
export async function selectProspectCampaignContactRouteAction(
  input: { memberId: string; contactId: string; actor: HumanActor },
  client: Client = db,
) {
  requireHuman(input.actor)
  if (!input.memberId.trim() || !input.contactId.trim())
    throw new ProspectOutreachError('INVALID_INPUT', 'Member and contact IDs are required')

  return client.$transaction(
    async (tx) => {
      const member = await readSelectableMember(tx as Client, input.memberId)
      const contact = await tx.prospectContact.findUnique({
        where: { id: input.contactId },
        include: {
          sources: {
            where: { organizationId: member.organizationId, venueId: member.venueId },
            take: 50,
            select: { id: true },
          },
        },
      })
      const provenanceEvidence = Array.isArray(contact?.provenance)
        ? contact.provenance.slice(0, 50).flatMap((item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return []
            const provenance = item as Record<string, unknown>
            const evidenceId = provenance.evidenceId
            const sourceUrl = provenance.sourceUrl
            return typeof evidenceId === 'string' && evidenceId.trim()
              ? [{ evidenceId, sourceUrl: typeof sourceUrl === 'string' ? sourceUrl : null }]
              : []
          })
        : []
      const relationEvidenceIds = new Set(contact?.sources.map((source) => source.id) ?? [])
      const provenanceSourceUrls = new Map(
        provenanceEvidence.map((item) => [item.evidenceId, item.sourceUrl]),
      )
      const evidenceIds = [...new Set([...relationEvidenceIds, ...provenanceSourceUrls.keys()])]
      const sourceEvidence = evidenceIds.length
        ? await tx.prospectSourceEvidence.findMany({
            where: {
              id: { in: evidenceIds },
              organizationId: member.organizationId,
              venueId: member.venueId,
            },
            take: 100,
            select: { id: true, sourceUrl: true, capturedValue: true },
          })
        : []
      const contactEmail = contact?.normalizedEmail?.trim().toLowerCase()
      const hasMatchingEvidence = sourceEvidence.some((source) => {
        const capturedValue = source.capturedValue
        const sourcedEmail =
          capturedValue && typeof capturedValue === 'object' && !Array.isArray(capturedValue)
            ? (capturedValue as Record<string, unknown>).email
            : undefined
        return (
          typeof sourcedEmail === 'string' &&
          sourcedEmail.trim().toLowerCase() === contactEmail &&
          Boolean(source.sourceUrl?.trim()) &&
          (relationEvidenceIds.has(source.id) ||
            (provenanceSourceUrls.get(source.id) !== null &&
              provenanceSourceUrls.get(source.id) === source.sourceUrl))
        )
      })
      if (
        !contact ||
        contact.organizationId !== member.organizationId ||
        contact.venueId !== member.venueId ||
        contact.archivedAt ||
        !contact.normalizedEmail ||
        !hasMatchingEvidence
      ) {
        throw new ProspectOutreachError(
          'CONFLICT',
          'Selected contact must have matching source evidence for the same organization and venue',
        )
      }
      const duplicate = await tx.prospectContact.findFirst({
        where: {
          organizationId: member.organizationId,
          normalizedEmail: { equals: contact.normalizedEmail, mode: 'insensitive' },
          id: { not: contact.id },
        },
        select: { id: true },
      })
      const duplicateCandidate = await tx.prospectDuplicateCandidate.findFirst({
        where: {
          status: { in: ['OPEN', 'CONFIRMED_DUPLICATE'] },
          OR: [
            { organizationAId: member.organizationId },
            { organizationBId: member.organizationId },
          ],
        },
        select: { id: true },
      })
      if (duplicate || duplicateCandidate)
        throw new ProspectOutreachError(
          'CONFLICT',
          'Duplicate email route or unresolved organization identity blocks selection',
        )
      if (member.contactId === contact.id) return { member, contact, changed: false }

      const updated = await tx.prospectCampaignMember.updateMany({
        where: {
          id: member.id,
          status: 'SELECTED',
          campaign: { status: 'DRAFT', pausedAt: null },
          drafts: { none: {} },
          sendItems: { none: {} },
        },
        data: { contactId: contact.id },
      })
      if (updated.count !== 1)
        throw new ProspectOutreachError(
          'CONFLICT',
          'Campaign member changed during contact selection',
        )
      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'prospect.outreach-contact.route-selected',
          targetType: 'ProspectCampaignMember',
          targetId: member.id,
          afterState: {
            memberId: member.id,
            previousContactId: member.contactId,
            contactId: contact.id,
            emailReadiness: contact.emailReadiness,
            permissionState: contact.permissionState,
          },
        },
        tx,
      )
      return { member: { ...member, contactId: contact.id }, contact, changed: true }
    },
    { isolationLevel: 'Serializable' },
  )
}

/** Import one exact provider-read Gmail draft. The provider draft ID is the stable idempotency key. */
export async function importExistingProspectGmailDraftAction(
  input: {
    memberId: string
    providerAccountId: string
    providerDraftId: string
    providerMessageId: string
    fromEmail: string
    toEmail: string
    subject: string
    textBody: string
    htmlBody?: string
    historyReviewConfirmed: true
    actor: HumanActor
  },
  client: Client = db,
) {
  requireHuman(input.actor)
  const from = input.fromEmail.trim().toLowerCase()
  const to = input.toEmail.trim().toLowerCase()
  const subject = input.subject
  const textBody = input.textBody
  const providerDraftId = input.providerDraftId.trim()
  const providerMessageId = input.providerMessageId.trim()
  if (
    !input.memberId.trim() ||
    !input.providerAccountId.trim() ||
    !providerDraftId ||
    !providerMessageId ||
    providerDraftId.length > 191 ||
    providerMessageId.length > 191 ||
    from !== PROSPECT_OUTREACH_COMPANY_SENDER ||
    !to ||
    to.length > 320 ||
    !subject.trim() ||
    subject.length > 998 ||
    !textBody.trim() ||
    textBody.length > 50_000 ||
    (input.htmlBody?.length ?? 0) > 100_000 ||
    input.historyReviewConfirmed !== true
  )
    throw new ProspectOutreachError(
      'INVALID_INPUT',
      'A bounded, exact business Gmail draft is required',
    )

  const groundingSnapshot = {
    source: 'GMAIL_EXISTING_DRAFT_IMPORT',
    providerAccountId: input.providerAccountId,
    providerDraftId,
  }
  const contentHash = prospectOperationalContentHash(
    to,
    subject,
    textBody,
    input.htmlBody ?? '',
    groundingSnapshot,
  )
  const findExisting = (dbClient: Client) =>
    dbClient.prospectOutreachDraftGmailLink.findUnique({
      where: {
        providerAccountId_providerDraftId: {
          providerAccountId: input.providerAccountId,
          providerDraftId,
        },
      },
      include: { outreachDraft: true },
    })

  const perform = async () =>
    client.$transaction(async (tx) => {
      const existing = await findExisting(tx as Client)
      if (existing) {
        const draft = existing.outreachDraft
        if (
          existing.verificationStatus === 'VERIFIED' &&
          draft.memberId === input.memberId &&
          existing.contentHash === contentHash &&
          draft.contentHash === contentHash &&
          draft.toEmail.toLowerCase() === to &&
          draft.subject === subject &&
          draft.textBody === textBody &&
          (draft.htmlBody ?? '') === (input.htmlBody ?? '')
        )
          return {
            draft,
            link: existing,
            idempotent: true,
            messageIdDrifted: existing.providerMessageId !== providerMessageId,
          }
        throw new ProspectOutreachError(
          'CONFLICT',
          'This Gmail draft ID is already linked to different or changed content',
        )
      }

      const account = await tx.correspondenceProviderAccount.findUnique({
        where: { id: input.providerAccountId },
      })
      if (
        !account ||
        account.provider !== 'GMAIL' ||
        account.connectionStatus !== 'CONNECTED' ||
        account.mailboxAddress.trim().toLowerCase() !== PROSPECT_OUTREACH_COMPANY_SENDER ||
        !account.credentialReferenceId ||
        !account.lastReconciliationAt
      ) {
        throw new ProspectOutreachError(
          'CONFLICT',
          'Connected business Gmail and completed mailbox reconciliation are required',
        )
      }
      const member = await tx.prospectCampaignMember.findUnique({
        where: { id: input.memberId },
        include: {
          campaign: true,
          organization: { include: { opportunity: true } },
          venue: true,
          contact: true,
          drafts: { orderBy: { version: 'desc' }, take: 1 },
        },
      })
      if (
        !member ||
        !member.contact ||
        !member.venue ||
        member.contactId !== member.contact.id ||
        member.contact.organizationId !== member.organizationId ||
        member.contact.venueId !== member.venueId
      ) {
        throw new ProspectOutreachError(
          'NOT_FOUND',
          'An exact CRM member, venue and contact are required',
        )
      }
      const contact = member.contact
      if (
        member.campaign.status !== 'DRAFT' ||
        member.campaign.pausedAt ||
        member.status !== 'SELECTED' ||
        member.drafts.length ||
        member.organization.archivedAt ||
        member.venue.archivedAt ||
        contact.archivedAt ||
        contact.normalizedEmail?.trim().toLowerCase() !== to ||
        contact.doNotContact ||
        contact.emailReadiness === 'INVALID' ||
        ['OPTED_OUT', 'PROHIBITED'].includes(contact.permissionState) ||
        contact.suppressedAt ||
        contact.unsubscribedAt ||
        contact.complainedAt ||
        contact.lastHardBounceAt ||
        contact.lastSoftBounceAt
      ) {
        throw new ProspectOutreachError(
          'SUPPRESSED',
          'The member is not currently eligible for an unsent draft',
        )
      }
      const stage = member.organization.opportunity?.stage
      if (
        !stage ||
        !['DISCOVERED', 'RESEARCHED', 'NEEDS_REVIEW', 'READY_FOR_OUTREACH'].includes(stage)
      ) {
        throw new ProspectOutreachError(
          'CONFLICT',
          'Prior outreach or relationship history blocks this import',
        )
      }
      const [duplicate, priorMessage, activeRelationship] = await Promise.all([
        tx.prospectDuplicateCandidate.findFirst({
          where: {
            OR: [
              {
                organizationAId: member.organizationId,
                status: { in: ['OPEN', 'CONFIRMED_DUPLICATE'] },
              },
              {
                organizationBId: member.organizationId,
                status: { in: ['OPEN', 'CONFIRMED_DUPLICATE'] },
              },
            ],
          },
          select: { id: true },
        }),
        tx.prospectEmailMessage.findFirst({
          where: { organizationId: member.organizationId },
          select: { id: true },
        }),
        tx.prospectCustomerRelationship.findFirst({
          where: { organizationId: member.organizationId, status: 'ACTIVE' },
          select: { id: true },
        }),
      ])
      if (duplicate || priorMessage || activeRelationship)
        throw new ProspectOutreachError(
          'CONFLICT',
          'Duplicate, correspondence, or active relationship evidence blocks this import',
        )
      for (const sourceImportRowId of [
        contact.sourceImportRowId,
        member.venue.sourceImportRowId,
      ].filter((x): x is string => Boolean(x))) {
        const row = await tx.prospectImportRow.findUnique({
          where: { id: sourceImportRowId },
          select: {
            status: true,
            import: { select: { status: true, failedRows: true, duplicateRows: true } },
          },
        })
        if (!isTerminalProspectOutreachImportRow(row)) {
          throw new ProspectOutreachError(
            'CONFLICT',
            'Source import must be terminal and reconciled before draft import',
          )
        }
      }
      const draft = await tx.prospectOutreachDraft.create({
        data: {
          campaignId: member.campaignId,
          memberId: member.id,
          organizationId: member.organizationId,
          venueId: member.venueId,
          contactId: member.contactId,
          version: 1,
          status: 'NEEDS_REVIEW',
          toEmail: contact.normalizedEmail!,
          subject,
          textBody,
          htmlBody: input.htmlBody ?? null,
          contentHash,
          groundingSnapshot,
          escalationFlags: detectProspectDraftEscalations({
            subject,
            textBody,
            relationshipTier: member.organization.relationshipTier,
          }),
          generatedByType: 'HUMAN',
          generatedById: input.actor.id,
        },
      })
      const link = await tx.prospectOutreachDraftGmailLink.create({
        data: {
          providerAccountId: input.providerAccountId,
          outreachDraftId: draft.id,
          providerDraftId,
          providerMessageId,
          contentHash,
          verificationStatus: 'VERIFIED',
          createdBy: input.actor.id,
        },
      })
      await tx.prospectCampaignMember.update({
        where: { id: member.id },
        data: { status: 'DRAFTED' },
      })
      await tx.prospectActivity.create({
        data: {
          organizationId: member.organizationId,
          venueId: member.venueId,
          contactId: member.contactId,
          type: 'OUTREACH_DRAFTED',
          summary: 'Existing Gmail draft imported for human review',
          evidence: { draftId: draft.id, gmailLinkId: link.id, providerDraftId, contentHash },
          actorId: input.actor.id,
        },
      })
      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'prospect.outreach-draft.gmail-import',
          targetType: 'ProspectOutreachDraftGmailLink',
          targetId: link.id,
          afterState: {
            memberId: member.id,
            draftId: draft.id,
            providerAccountId: input.providerAccountId,
            providerDraftId,
            providerMessageId,
            contentHash,
            historyReviewConfirmed: true,
          },
        },
        tx,
      )
      return { draft, link, idempotent: false, messageIdDrifted: false }
    })

  try {
    return await perform()
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      const existing = await findExisting(client)
      if (
        existing?.verificationStatus === 'VERIFIED' &&
        existing.outreachDraft.memberId === input.memberId &&
        existing.contentHash === contentHash &&
        existing.outreachDraft.contentHash === contentHash
      ) {
        return {
          draft: existing.outreachDraft,
          link: existing,
          idempotent: true,
          messageIdDrifted: existing.providerMessageId !== providerMessageId,
        }
      }
      throw new ProspectOutreachError('CONFLICT', 'A Gmail draft import raced with another write')
    }
    throw error
  }
}
