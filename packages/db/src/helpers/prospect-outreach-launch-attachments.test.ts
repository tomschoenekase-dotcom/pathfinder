import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { launchAttachmentsSha256 } from '@pathfinder/contracts/venue-launch-asset-node'
import type { VenueLaunchAsset } from '@pathfinder/contracts/venue-launch-asset'
import { renderVenueQrSvg } from '@pathfinder/contracts/venue-qr-svg'

const mocks = vi.hoisted(() => ({ current: vi.fn() }))
vi.mock('./prospect-launch-attachments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./prospect-launch-attachments')>()
  return { ...actual, requireCurrentProspectLaunchAttachments: mocks.current }
})

import {
  approveProspectSendBatchAction,
  reviewProspectOutreachDraftAction,
  stageProspectSendBatchAction,
} from './prospect-outreach-actions'
import { prospectOperationalContentHash } from './prospect-launch-attachments'

const venueUrl = 'https://guide.example.com/venue/chat?source=qr'
const qrBytes = Buffer.from(renderVenueQrSvg(venueUrl), 'utf8')
const launchAsset: VenueLaunchAsset = {
  schema: 'torchiko.venue-launch-asset/1',
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  release: { kind: 'LEGACY', id: 'legacy:venue-1', revisionSha256: 'a'.repeat(64) },
  publicUrl: venueUrl,
  filename: 'venue-qr.svg',
  mimeType: 'image/svg+xml',
  sizeBytes: qrBytes.length,
  sha256: createHash('sha256').update(qrBytes).digest('hex'),
  contentBase64: qrBytes.toString('base64'),
}
const actor = { type: 'HUMAN' as const, id: 'admin-1', role: 'PLATFORM_ADMIN' as const }
const subject = 'A visitor guide for your venue'
const body = 'Visitors can scan the attached code to open the guide.'
const recipient = 'hello@example.org'
const snapshot = { source: 'crm-preparation', launchAttachments: [launchAsset] }
const contentHash = prospectOperationalContentHash(recipient, subject, body, '', snapshot)

describe('prospect outreach launch attachment freeze', () => {
  it('rejects launch attachments without a native origin before staging', async () => {
    mocks.current.mockImplementation(async (_prospectVenueId, value) => value)
    const draft = {
      id: 'draft-1',
      memberId: 'member-1',
      campaignId: 'campaign-1',
      organizationId: 'organization-1',
      venueId: 'prospect-venue-1',
      contactId: 'contact-1',
      status: 'APPROVED',
      version: 2,
      toEmail: recipient,
      subject,
      textBody: body,
      htmlBody: null,
      contentHash,
      groundingSnapshot: snapshot,
      escalationFlags: [],
      contact: {
        doNotContact: false,
        normalizedEmail: recipient,
        emailReadiness: 'VALID',
        permissionState: 'LEGITIMATE_INTEREST_RECORDED',
        suppressedAt: null,
        unsubscribedAt: null,
      },
    }
    const tx = {
      prospectOutreachDraft: { findMany: vi.fn().mockResolvedValue([draft]) },
      prospectSendBatch: { create: vi.fn().mockResolvedValue({ id: 'batch-1' }) },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }

    await expect(
      stageProspectSendBatchAction(
        { campaignId: 'campaign-1', draftIds: ['draft-1'], actor },
        client as never,
      ),
    ).rejects.toThrow(/LAUNCH_ASSET_NATIVE_ORIGIN_REQUIRED/u)
    expect(tx.prospectSendBatch.create).not.toHaveBeenCalled()
  })

  it('keeps NO-SEND preparations outside campaign approval', async () => {
    mocks.current.mockImplementation(async (_prospectVenueId, value) => value)
    const tx = {
      prospectOutreachDraft: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'draft-1',
          preparationKey: 'preparation-1',
          memberId: 'member-1',
          venueId: 'prospect-venue-1',
          status: 'NEEDS_REVIEW',
          toEmail: recipient,
          subject,
          textBody: body,
          htmlBody: null,
          contentHash: prospectOperationalContentHash(recipient, subject, body, '', {}),
          groundingSnapshot: snapshot,
          escalationFlags: [],
        }),
        update: vi.fn(),
      },
      prospectCampaignMember: { update: vi.fn() },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }

    await expect(
      reviewProspectOutreachDraftAction(
        { draftId: 'draft-1', approve: true, actor },
        client as never,
      ),
    ).rejects.toThrow(/NO-SEND preparation is not a campaign approval candidate/u)
    expect(tx.prospectOutreachDraft.update).not.toHaveBeenCalled()
  })

  it('rejects batch approval when the frozen attachment manifest differs from the reviewed draft', async () => {
    mocks.current.mockImplementation(async (_prospectVenueId, value) => value)
    const snapshotHash = createHash('sha256')
      .update(`draft-1:${contentHash}:${recipient}:${launchAttachmentsSha256([launchAsset])}`)
      .digest('hex')
    const batch = {
      id: 'batch-1',
      status: 'STAGED',
      recipientCount: 1,
      snapshotHash,
      items: [
        {
          draftId: 'draft-1',
          recipientEmailSnapshot: recipient,
          subjectSnapshot: subject,
          textBodySnapshot: body,
          htmlBodySnapshot: null,
          contentHashSnapshot: contentHash,
          headerSnapshot: {
            launchAttachments: [],
          },
          draft: {
            groundingSnapshot: snapshot,
            venueId: 'prospect-venue-1',
            contentHash,
          },
        },
      ],
    }
    const tx = {
      prospectSendBatch: {
        findUnique: vi.fn().mockResolvedValue(batch),
        update: vi.fn(),
      },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }

    await expect(
      approveProspectSendBatchAction(
        {
          batchId: 'batch-1',
          expectedRecipientCount: 1,
          expectedSnapshotHash: snapshotHash,
          actor,
        },
        client as never,
      ),
    ).rejects.toThrow(/frozen|attachment/i)
    expect(tx.prospectSendBatch.update).not.toHaveBeenCalled()
  })
})
