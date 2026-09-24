import { launchAttachmentsFromSnapshot } from '@pathfinder/contracts/venue-launch-asset-node'
import type { Prisma } from '@prisma/client'
import { db } from '../client'
import { salesHash, ProspectSalesError, type SalesClient } from './prospect-sales-snapshot'
import { requireSalesOperator, type SalesActor } from './prospect-sales-actions'
import {
  createProspectCampaignActionInTransaction,
  saveProspectOutreachDraftActionInTransaction,
} from './prospect-outreach-actions'
import {
  readEligibleNativeOrigin,
  requireProspectApprovalScope,
  type NativeOriginVerifier,
} from './prospect-native-origin'
import { writeAuditLogStrict } from './audit'

export const NATIVE_HANDOFF_SCHEMA = 'torchiko.native-operational-handoff/1'
export async function createNativeOperationalCandidate(
  input: {
    venueId: string
    expectedSnapshotHash: string
    draftId: string
    contentHash: string
    meaningReviewId: string
    providerAccountId: string
    campaignName: string
    actor: SalesActor
  },
  verify: NativeOriginVerifier,
  client: SalesClient = db,
) {
  const actor = input.actor
  requireSalesOperator(actor)
  if (!input.campaignName.trim() || input.campaignName.length > 160)
    throw new ProspectSalesError(
      'INVALID_INPUT',
      'Explicit bounded operational campaign name required',
    )
  try {
    return await client.$transaction(
      async (tx) => {
        const { origin, draft, native } = await readEligibleNativeOrigin(input, tx, verify)
        if (native.venue.id !== input.venueId || native.snapshotHash !== input.expectedSnapshotHash)
          throw new ProspectSalesError(
            'CONFLICT',
            'STALE_NATIVE_HANDOFF: exact current source and venue required',
          )
        requireProspectApprovalScope(actor, [native.organization.id])
        if (actor.type === 'SYSTEM' && !origin.synthetic)
          throw new ProspectSalesError(
            'FORBIDDEN',
            'A synthetic rehearsal cannot approve or campaign a real venue',
          )
        // A renamed/double-clicked selection cannot create duplicate operational
        // candidates for identical origin bytes. A new message needs a new revision.
        const key = salesHash({ origin })
        const id = 'native-handoff_' + key.slice(0, 40)
        const previous = await tx.prospectActivity.findUnique({ where: { id } })
        if (previous) return previous
        const campaign = await createProspectCampaignActionInTransaction(
          {
            name: input.campaignName,
            organizationIds: [native.organization.id],
            actor,
            selectedContacts: {
              [native.organization.id]: { venueId: native.venue.id, contactId: draft.contactId! },
            },
            cohortSnapshot: {
              schema: NATIVE_HANDOFF_SCHEMA,
              nativeOrigin: origin,
              selectedBy: actor,
              syntheticRehearsal: origin.synthetic,
              humanApproval: 'ABSENT',
              purpose:
                'Explicit single-prospect operational candidate selection, not a send release',
            },
          },
          tx,
        )
        const members = await tx.prospectCampaignMember.findMany({
          where: { campaignId: campaign.id, organizationId: native.organization.id },
          take: 2,
        })
        const member = members.length === 1 ? members[0] : null
        if (
          !member ||
          member.venueId !== draft.venueId ||
          member.contactId !== draft.contactId ||
          member.status !== 'SELECTED'
        )
          throw new ProspectSalesError(
            'CONFLICT',
            'Existing campaign owner did not retain the exact explicit recipient',
          )
        const candidate = await saveProspectOutreachDraftActionInTransaction(
          {
            memberId: member.id,
            subject: draft.subject,
            textBody: draft.textBody,
            actor,
            groundingSnapshot: {
              nativeSalesOrigin: origin,
              ...(launchAttachmentsFromSnapshot(draft.groundingSnapshot).length
                ? { launchAttachments: launchAttachmentsFromSnapshot(draft.groundingSnapshot) }
                : {}),
              submittedBy: actor,
              humanApproval: 'ABSENT',
              originNoSendRecordUnchanged: true,
            },
          },
          tx,
          verify,
        )
        const activity = await tx.prospectActivity.create({
          data: {
            id,
            organizationId: native.organization.id,
            venueId: native.venue.id,
            contactId: draft.contactId,
            type: 'NOTE_ADDED',
            actorId: input.actor.id,
            summary: origin.synthetic
              ? 'SYNTHETIC rehearsal: new operational candidate selected; original NO-SEND draft retained'
              : 'New operational candidate selected for separate exact human approval; original NO-SEND draft retained',
            evidence: {
              schema: NATIVE_HANDOFF_SCHEMA,
              nativeDraftId: draft.id,
              nativeContentHash: draft.contentHash,
              origin,
              campaignId: campaign.id,
              memberId: member.id,
              operationalDraftId: candidate.id,
              operationalContentHash: candidate.contentHash,
              selectedBy: input.actor,
              syntheticRehearsal: origin.synthetic,
              humanApproval: 'ABSENT',
              SEND_AUTHORIZED: false,
            } as Prisma.InputJsonValue,
          },
        })
        await writeAuditLogStrict(
          {
            actorId: input.actor.id,
            actorType: input.actor.type,
            actorRole: input.actor.role,
            action: 'prospect.native-reviewed-candidate.handoff',
            targetType: 'ProspectOutreachDraft',
            targetId: candidate.id,
            sourceReferences: [{ nativeDraftId: draft.id, meaningReviewId: input.meaningReviewId }],
            afterState: {
              campaignId: campaign.id,
              candidateId: candidate.id,
              syntheticRehearsal: origin.synthetic,
              approval: 'ABSENT',
              sourceNoSendUnchanged: true,
            },
          },
          tx,
        )
        return activity
      },
      { isolationLevel: 'Serializable', timeout: 30_000 },
    )
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      ['P2034', 'P2002'].includes(String(error.code))
    )
      throw new ProspectSalesError(
        'CONFLICT',
        'CONCURRENT_NATIVE_HANDOFF: another selection won; no partial campaign or candidate committed',
      )
    throw error
  }
}
