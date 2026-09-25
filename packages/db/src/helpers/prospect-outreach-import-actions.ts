import { createHash } from 'node:crypto'

import { db } from '../client'
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

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
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
        contact.emailReadiness !== 'VALID' ||
        !['LEGITIMATE_INTEREST_RECORDED', 'OPTED_IN'].includes(contact.permissionState) ||
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
