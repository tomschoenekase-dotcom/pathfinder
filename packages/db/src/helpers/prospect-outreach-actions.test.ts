import { describe, expect, it, vi } from 'vitest'

import {
  detectProspectDraftEscalations,
  PROSPECT_OUTREACH_MAX_BATCH,
  PROSPECT_OUTREACH_MAX_COHORT,
  PROSPECT_PLAYBOOK_VERSION,
  releaseProspectSendBatchAction,
  saveProspectOutreachDraftAction,
} from './prospect-outreach-actions'

describe('prospect outreach policy', () => {
  it('flags business commitments and strategic prospects for explicit human review', () => {
    expect(
      detectProspectDraftEscalations({
        subject: 'A custom Torchiko plan',
        textBody:
          'We will build a custom feature for $25 per month and come to the venue for in-person onboarding.',
        relationshipTier: 'STRATEGIC',
      }),
    ).toEqual(['custom-commitment', 'pricing', 'strategic-prospect', 'travel'])
  })

  it('does not flag normal factual outreach', () => {
    expect(
      detectProspectDraftEscalations({
        subject: 'Torchiko for the museum',
        textBody:
          'Visitors could ask what they should see with thirty minutes left. I would be happy to answer questions.',
        relationshipTier: 'STANDARD',
      }),
    ).toEqual([])
  })

  it('keeps cohort and release sizes bounded', () => {
    expect(PROSPECT_OUTREACH_MAX_COHORT).toBe(5000)
    expect(PROSPECT_OUTREACH_MAX_BATCH).toBe(500)
    expect(PROSPECT_PLAYBOOK_VERSION).toMatch(/^torchiko-email-playbook-/u)
  })
})

describe('prospect frozen-intent invalidation', () => {
  it('cancels staged and approved send intent when a newer draft supersedes it', async () => {
    const tx = {
      prospectCampaignMember: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'member-1',
          campaignId: 'campaign-1',
          organizationId: 'organization-1',
          venueId: 'venue-1',
          contactId: 'contact-1',
          contact: {
            normalizedEmail: 'hello@example.org',
            doNotContact: false,
            emailReadiness: 'VALID',
            permissionState: 'UNKNOWN',
            suppressedAt: null,
            unsubscribedAt: null,
          },
          organization: { relationshipTier: 'STANDARD' },
          drafts: [{ id: 'draft-1', version: 1, status: 'APPROVED' }],
        }),
        update: vi.fn(),
      },
      prospectSendBatch: {
        findMany: vi.fn().mockResolvedValue([{ id: 'batch-1' }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      prospectSendItem: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      prospectOutreachDraft: {
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({ id: 'draft-2', version: 2 }),
      },
      prospectActivity: { create: vi.fn() },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }

    await saveProspectOutreachDraftAction(
      {
        memberId: 'member-1',
        subject: 'A new subject',
        textBody: 'A new grounded message.',
        groundingSnapshot: { evidence: ['source-1'] },
        actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
      },
      client as never,
    )

    expect(tx.prospectSendBatch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['batch-1'] }, status: { in: ['STAGED', 'APPROVED'] } },
      data: { status: 'CANCELLED', cancelledReason: 'DRAFT_SUPERSEDED:draft-1' },
    })
    expect(tx.prospectSendItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }),
    )
  })

  it('rejects release when a frozen draft is no longer approved', async () => {
    const tx = {
      prospectDeliveryControl: { findUnique: vi.fn().mockResolvedValue({ deliveryEnabled: true }) },
      correspondenceProviderAccount: {
        findUnique: vi.fn().mockResolvedValue({
          provider: 'GMAIL',
          capabilities: ['SEND'],
          connectionStatus: 'CONNECTED',
          deliveryEnabled: true,
          pausedAt: null,
        }),
      },
      prospectSendBatch: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'batch-1',
          status: 'APPROVED',
          recipientCount: 1,
          snapshotHash: 'a'.repeat(64),
          items: [
            {
              contentHashSnapshot: 'b'.repeat(64),
              recipientEmailSnapshot: 'hello@example.org',
              draft: {
                status: 'SUPERSEDED',
                contentHash: 'b'.repeat(64),
                toEmail: 'hello@example.org',
                contact: {},
              },
            },
          ],
          campaign: {},
        }),
      },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    await expect(
      releaseProspectSendBatchAction(
        {
          batchId: 'batch-1',
          providerAccountId: 'mailbox-1',
          expectedRecipientCount: 1,
          expectedSnapshotHash: 'a'.repeat(64),
          actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
        },
        client as never,
      ),
    ).rejects.toThrow(/draft or recipient changed/i)
  })

  it('rejects release through a mailbox without explicit SEND capability', async () => {
    const tx = {
      prospectDeliveryControl: { findUnique: vi.fn().mockResolvedValue({ deliveryEnabled: true }) },
      correspondenceProviderAccount: {
        findUnique: vi.fn().mockResolvedValue({
          provider: 'GMAIL',
          capabilities: ['RECEIVE'],
          connectionStatus: 'CONNECTED',
          deliveryEnabled: true,
          pausedAt: null,
        }),
      },
      prospectSendBatch: { findUnique: vi.fn().mockResolvedValue(null) },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    await expect(
      releaseProspectSendBatchAction(
        {
          batchId: 'batch-1',
          providerAccountId: 'mailbox-1',
          expectedRecipientCount: 1,
          expectedSnapshotHash: 'a'.repeat(64),
          actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
        },
        client as never,
      ),
    ).rejects.toThrow(/connected, explicitly enabled Gmail mailbox/i)
  })
})
