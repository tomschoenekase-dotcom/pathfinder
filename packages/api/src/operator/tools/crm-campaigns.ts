import type { Prisma } from '@prisma/client'

import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { PROSPECT_OUTREACH_RELEASE_POLICY } from '@pathfinder/db'

import { operatorUntrustedText, redactAddresses } from '../crm-projection'
import { OperatorNotFoundError } from '../grants'
import { isCampaignReleaseEnabled } from '../kinds/release-gate'
import type { OperatorReadTool } from '../registry'
import { eligibilityForContacts } from './crm-eligibility'
import { pageResult, requireCursorInScope } from './page'

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null)
const BODY_MAX = 8_000
const BATCHES_SHOWN = 10

function hasAttachments(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false
  const attachments = (snapshot as { launchAttachments?: unknown }).launchAttachments
  return Array.isArray(attachments) && attachments.length > 0
}

const getCampaign: OperatorReadTool = {
  name: 'crm.get_campaign',
  capability: 'crm:read',
  async handler(raw, context) {
    const { campaignId } = OPERATOR_MCP_INPUTS['crm.get_campaign'].parse(raw)
    const database = context.database
    const campaign = await database.prospectOutreachCampaign.findUnique({
      where: { id: campaignId },
    })
    if (!campaign) throw new OperatorNotFoundError()
    const [memberStatus, draftStatus, batches, batchCount, control] = await Promise.all([
      database.prospectCampaignMember.groupBy({
        by: ['status'],
        where: { campaignId },
        _count: { _all: true },
      }),
      database.prospectOutreachDraft.groupBy({
        by: ['status'],
        where: { campaignId },
        _count: { _all: true },
      }),
      database.prospectSendBatch.findMany({
        where: { campaignId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: BATCHES_SHOWN,
      }),
      database.prospectSendBatch.count({ where: { campaignId } }),
      database.prospectDeliveryControl.findUnique({
        where: { id: 'global' },
        select: { deliveryEnabled: true },
      }),
    ])
    const tally = (rows: Array<{ status: string; _count: { _all: number } }>) => ({
      total: rows.reduce((sum, row) => sum + row._count._all, 0),
      byStatus: Object.fromEntries(rows.map((row) => [row.status, row._count._all])),
    })
    return {
      campaign: {
        campaignId: campaign.id,
        name: campaign.name.slice(0, 191),
        description: campaign.description
          ? operatorUntrustedText(redactAddresses(campaign.description))
          : null,
        status: campaign.status,
        dailyLimit: campaign.dailySendCap,
        pausedAt: iso(campaign.pausedAt),
        createdAt: campaign.createdAt.toISOString(),
        updatedAt: campaign.updatedAt.toISOString(),
      },
      members: tally(memberStatus),
      drafts: tally(draftStatus),
      batches: batches.map((batch) => ({
        batchId: batch.id,
        status: batch.status,
        recipientCount: batch.recipientCount,
        snapshotHash: batch.snapshotHash,
        createdAt: batch.createdAt.toISOString(),
        reviewedAt: iso(batch.approvedAt),
        releasedAt: iso(batch.releasedAt),
      })),
      batchCount,
      releasePolicy: {
        phase: PROSPECT_OUTREACH_RELEASE_POLICY.phase,
        maxRecipients: PROSPECT_OUTREACH_RELEASE_POLICY.maxRecipients,
        promotion: PROSPECT_OUTREACH_RELEASE_POLICY.promotionStatus,
      },
      releaseAdapterEnabled: isCampaignReleaseEnabled(),
      deliveryEnabled: control?.deliveryEnabled === true,
    }
  },
}

const listDrafts: OperatorReadTool = {
  name: 'crm.list_drafts',
  capability: 'crm:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['crm.list_drafts'].parse(raw)
    const database = context.database
    const where: Prisma.ProspectOutreachDraftWhereInput = {
      ...(input.campaignId ? { campaignId: input.campaignId } : {}),
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      ...(input.memberId ? { memberId: input.memberId } : {}),
      ...(input.status ? { status: input.status } : {}),
    }
    await requireCursorInScope(input.cursor, (id) =>
      database.prospectOutreachDraft.findFirst({
        where: { AND: [where, { id }] },
        select: { id: true },
      }),
    )
    const rows = await database.prospectOutreachDraft.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      include: { providerDraftAccount: { select: { provider: true } } },
    })
    const page = rows.slice(0, input.limit)
    const eligibility = await eligibilityForContacts(
      database,
      page.map((draft) => draft.contactId),
    )
    return pageResult(
      page.map((draft) => {
        const eligible = draft.contactId ? eligibility.get(draft.contactId) : undefined
        return {
          draftId: draft.id,
          gmailDraftId:
            draft.providerDraftAccount?.provider === 'GMAIL' ? draft.providerDraftId : null,
          gmailDraftMailboxId:
            draft.providerDraftAccount?.provider === 'GMAIL' ? draft.providerDraftAccountId : null,
          memberId: draft.memberId,
          campaignId: draft.campaignId,
          organizationId: draft.organizationId,
          contactId: draft.contactId,
          version: draft.version,
          status: draft.status,
          subject: operatorUntrustedText(redactAddresses(draft.subject), 998),
          body: operatorUntrustedText(draft.textBody, BODY_MAX),
          contentHash: draft.contentHash,
          escalationFlags: draft.escalationFlags.slice(0, 10),
          // The address is shown only while the contact may still be written to.
          recipient: eligible?.draft.eligible ? draft.toEmail : null,
          eligibleToEmail: eligible?.send.eligible ?? false,
          eligibilityReasons: [...(eligible?.send.reasons ?? ['no_contact_selected'])],
          hasAttachments: hasAttachments(draft.groundingSnapshot),
          reviewedAt: iso(draft.approvedAt),
          createdAt: draft.createdAt.toISOString(),
        }
      }),
      rows.length > input.limit ? page.at(-1)!.id : null,
    )
  },
}

const getSendBatch: OperatorReadTool = {
  name: 'crm.get_outreach_batch',
  capability: 'crm:read',
  async handler(raw, context) {
    const { batchId } = OPERATOR_MCP_INPUTS['crm.get_outreach_batch'].parse(raw)
    const database = context.database
    const batch = await database.prospectSendBatch.findUnique({
      where: { id: batchId },
      include: {
        items: { orderBy: { id: 'asc' }, include: { draft: { select: { contactId: true } } } },
      },
    })
    if (!batch) throw new OperatorNotFoundError()
    const eligibility = await eligibilityForContacts(
      database,
      batch.items.map((item) => item.draft.contactId),
    )
    return {
      batch: {
        batchId: batch.id,
        campaignId: batch.campaignId,
        status: batch.status,
        recipientCount: batch.recipientCount,
        snapshotHash: batch.snapshotHash,
        createdAt: batch.createdAt.toISOString(),
        reviewedAt: iso(batch.approvedAt),
        queuedAt: iso(batch.queuedAt),
        releasedAt: iso(batch.releasedAt),
        cancelledReason: batch.cancelledReason,
      },
      items: batch.items.slice(0, 50).map((item) => {
        const eligible = item.draft.contactId ? eligibility.get(item.draft.contactId) : undefined
        const header = item.headerSnapshot as { launchAttachmentsSha256?: unknown } | null
        return {
          itemId: item.id,
          draftId: item.draftId,
          memberId: item.memberId,
          recipient: eligible?.draft.eligible ? item.recipientEmailSnapshot : null,
          subject: operatorUntrustedText(redactAddresses(item.subjectSnapshot), 998),
          contentHash: item.contentHashSnapshot,
          attachmentsSha256:
            typeof header?.launchAttachmentsSha256 === 'string'
              ? header.launchAttachmentsSha256
              : null,
          status: item.status,
          eligibleNow: eligible?.send.eligible ?? false,
          reasons: [...(eligible?.send.reasons ?? ['no_contact_selected'])],
        }
      }),
      withinReleasePolicy:
        batch.recipientCount >= 1 &&
        batch.recipientCount <= PROSPECT_OUTREACH_RELEASE_POLICY.maxRecipients,
    }
  },
}

export const crmCampaignReadTools: readonly OperatorReadTool[] = [
  getCampaign,
  listDrafts,
  getSendBatch,
]
