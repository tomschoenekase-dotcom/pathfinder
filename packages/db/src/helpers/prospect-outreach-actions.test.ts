import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { prospectOperationalContentHash } from './prospect-launch-attachments'

import {
  approveProspectSendBatchAction,
  createProspectCampaignAction,
  detectProspectDraftEscalations,
  linkExistingProspectGmailDraftAction,
  PROSPECT_OUTREACH_MAX_BATCH,
  PROSPECT_OUTREACH_MAX_COHORT,
  PROSPECT_OUTREACH_RELEASE_POLICY,
  PROSPECT_PLAYBOOK_VERSION,
  releaseProspectSendBatchAction,
  requireProspectOutreachReleasePolicy,
  saveProspectOutreachDraftAction,
  stageProspectSendBatchAction,
} from './prospect-outreach-actions'

describe('prospect outreach policy', () => {
  it('admits a reviewed-later contact to a draft campaign without making it send-ready', async () => {
    const tx = {
      prospectOrganization: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'org-1',
            venues: [{ id: 'venue-1' }],
            contacts: [{ id: 'contact-1', venueId: 'venue-1' }],
          },
        ]),
      },
      prospectOutreachCampaign: {
        create: vi.fn().mockResolvedValue({ id: 'campaign-1' }),
      },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }

    await createProspectCampaignAction(
      {
        name: 'Draft-only Chicago cohort',
        organizationIds: ['org-1'],
        cohortSnapshot: { territory: 'Chicago Metro' },
        actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
      },
      client as never,
    )

    expect(tx.prospectOrganization.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          contacts: expect.objectContaining({
            where: expect.objectContaining({ emailReadiness: { not: 'INVALID' } }),
          }),
        }),
      }),
    )
    expect(tx.prospectOutreachCampaign.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          members: {
            create: [expect.objectContaining({ status: 'SELECTED', contactId: 'contact-1' })],
          },
        }),
      }),
    )
  })

  it.each(['UNKNOWN', 'REVIEW_REQUIRED', 'OPTED_OUT', 'PROHIBITED'])(
    'does not stage a batch when permission is %s',
    async (permissionState) => {
      const create = vi.fn()
      const tx = {
        prospectOutreachDraft: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'draft-1',
              campaignId: 'campaign-1',
              status: 'APPROVED',
              contact: {
                normalizedEmail: 'hello@example.org',
                emailReadiness: 'VALID',
                permissionState,
                doNotContact: false,
                suppressedAt: null,
                unsubscribedAt: null,
              },
            },
          ]),
        },
        prospectSendBatch: { create },
      }

      await expect(
        stageProspectSendBatchAction(
          {
            campaignId: 'campaign-1',
            draftIds: ['draft-1'],
            actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
          },
          { $transaction: vi.fn((work) => work(tx)) } as never,
        ),
      ).rejects.toMatchObject({ code: 'SUPPRESSED' })
      expect(create).not.toHaveBeenCalled()
    },
  )

  it.each(['UNKNOWN', 'REVIEW_REQUIRED', 'OPTED_OUT', 'PROHIBITED'])(
    'does not release a frozen batch when permission is %s',
    async (permissionState) => {
      const recipient = 'hello@example.org'
      const subject = 'Torchiko at Example Museum'
      const body = 'A reviewed message.'
      const contentHash = prospectOperationalContentHash(recipient, subject, body, '', {})
      const recipientIdentityHash = createHash('sha256').update(recipient).digest('hex')
      const snapshotHash = createHash('sha256')
        .update(`draft-1:${contentHash}:${recipient}`)
        .digest('hex')
      const createMany = vi.fn()
      const tx = {
        prospectDeliveryControl: {
          findUnique: vi.fn().mockResolvedValue({ deliveryEnabled: true, internalOnly: false }),
        },
        correspondenceProviderAccount: {
          findUnique: vi.fn().mockResolvedValue({
            provider: 'GMAIL',
            capabilities: ['SEND'],
            connectionStatus: 'CONNECTED',
            deliveryEnabled: true,
            pausedAt: null,
            mailboxAddress: 'tomschoenekase@torchiko.com',
          }),
        },
        prospectSendBatch: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'batch-1',
            status: 'APPROVED',
            recipientCount: 1,
            snapshotHash,
            campaign: { pausedAt: null, status: 'DRAFT' },
            items: [
              {
                id: 'item-1',
                draftId: 'draft-1',
                memberId: 'member-1',
                recipientEmailSnapshot: recipient,
                recipientIdentityHash,
                subjectSnapshot: subject,
                textBodySnapshot: body,
                htmlBodySnapshot: null,
                contentHashSnapshot: contentHash,
                headerSnapshot: {},
                idempotencyKey: 'idempotency-1',
                draft: {
                  id: 'draft-1',
                  status: 'APPROVED',
                  contentHash,
                  toEmail: recipient,
                  subject,
                  textBody: body,
                  htmlBody: null,
                  groundingSnapshot: {},
                  venueId: null,
                  contact: {
                    normalizedEmail: recipient,
                    doNotContact: false,
                    archivedAt: null,
                    emailReadiness: 'VALID',
                    permissionState,
                    suppressedAt: null,
                    unsubscribedAt: null,
                  },
                },
              },
            ],
          }),
          update: vi.fn(),
        },
        prospectSendOutbox: { createMany },
      }

      await expect(
        releaseProspectSendBatchAction(
          {
            batchId: 'batch-1',
            providerAccountId: 'gmail-account-1',
            expectedRecipientCount: 1,
            expectedSnapshotHash: snapshotHash,
            actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
          },
          { $transaction: vi.fn((work) => work(tx)) } as never,
        ),
      ).rejects.toMatchObject({ code: 'SUPPRESSED' })
      expect(createMany).not.toHaveBeenCalled()
    },
  )

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
    expect(PROSPECT_OUTREACH_RELEASE_POLICY).toMatchObject({
      phase: 'INITIAL_CANARY',
      maxRecipients: 50,
      nextPhaseMaxRecipients: 100,
      promotionStatus: 'NOT_AUTHORIZED',
      promotionRequirement: 'REVIEWED_EVIDENCE_AND_CODE_CHANGE',
    })
    expect(PROSPECT_PLAYBOOK_VERSION).toMatch(/^torchiko-email-playbook-/u)
  })

  it('accepts the initial 50-recipient canary and rejects implicit promotion to 51', () => {
    expect(() => requireProspectOutreachReleasePolicy(50)).not.toThrow()
    expect(() => requireProspectOutreachReleasePolicy(51)).toThrow(
      /promotion requires reviewed evidence and a code change/i,
    )
  })

  it('rejects a 51-recipient batch before staging can open a transaction', async () => {
    const client = { $transaction: vi.fn() }

    await expect(
      stageProspectSendBatchAction(
        {
          campaignId: 'campaign-1',
          draftIds: Array.from({ length: 51 }, (_, index) => `draft-${index}`),
          actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
        },
        client as never,
      ),
    ).rejects.toThrow(/permits 1–50 recipients/i)
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('refuses to approve a legacy staged batch above the active canary', async () => {
    const tx = {
      prospectSendBatch: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'batch-legacy-51',
          status: 'STAGED',
          recipientCount: 51,
          snapshotHash: 'a'.repeat(64),
          items: Array.from({ length: 51 }, (_, index) => ({ id: `item-${index}` })),
        }),
        update: vi.fn(),
      },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }

    await expect(
      approveProspectSendBatchAction(
        {
          batchId: 'batch-legacy-51',
          expectedRecipientCount: 51,
          expectedSnapshotHash: 'a'.repeat(64),
          actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
        },
        client as never,
      ),
    ).rejects.toThrow(/promotion requires reviewed evidence and a code change/i)
    expect(tx.prospectSendBatch.update).not.toHaveBeenCalled()
  })
})

describe('prospect frozen-intent invalidation', () => {
  it('freezes server-read source evidence in member scope and overwrites caller provenance', async () => {
    const source = {
      id: 'source-1',
      organizationId: 'organization-1',
      venueId: 'venue-1',
      contactId: 'contact-1',
      sourceType: 'WEBSITE',
      sourceUrl: 'https://museum.example/about',
      sourceLabel: 'About page',
      capturedValue: { phone: '312-555-0100' },
      importRowId: null,
      researchedAt: new Date('2026-09-24T12:00:00.000Z'),
      createdBy: 'researcher-1',
      createdAt: new Date('2026-09-24T12:01:00.000Z'),
    }
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
          drafts: [],
        }),
        update: vi.fn(),
      },
      prospectSourceEvidence: { findMany: vi.fn().mockResolvedValue([source]) },
      prospectOutreachDraft: {
        create: vi.fn().mockImplementation(({ data }) => ({ id: 'draft-1', version: 1, ...data })),
      },
      prospectActivity: { create: vi.fn() },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }

    const draft = await saveProspectOutreachDraftAction(
      {
        memberId: 'member-1',
        subject: 'A grounded subject',
        textBody: 'A grounded message.',
        sourceEvidenceIds: ['source-1'],
        groundingSnapshot: {
          resolvedSourceEvidence: [{ id: 'source-1', sourceUrl: 'https://attacker.invalid' }],
        },
        actor: { type: 'AGENT', id: 'agent-1', capabilities: ['prospects:draft'] },
      },
      client as never,
    )

    expect(tx.prospectSourceEvidence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ['source-1'] },
          organizationId: 'organization-1',
          AND: [
            { OR: [{ venueId: null }, { venueId: 'venue-1' }] },
            { OR: [{ contactId: null }, { contactId: 'contact-1' }] },
          ],
        },
      }),
    )
    const grounding = draft.groundingSnapshot as {
      resolvedSourceEvidence: Array<Record<string, unknown>>
    }
    expect(grounding.resolvedSourceEvidence[0]).toMatchObject({
      id: 'source-1',
      organizationId: 'organization-1',
      venueId: 'venue-1',
      contactId: 'contact-1',
      sourceType: 'WEBSITE',
      sourceUrl: 'https://museum.example/about',
      sourceLabel: 'About page',
      capturedValue: { phone: '312-555-0100' },
      createdBy: 'researcher-1',
      researchedAt: '2026-09-24T12:00:00.000Z',
      createdAt: '2026-09-24T12:01:00.000Z',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    expect(grounding.resolvedSourceEvidence[0]?.sourceUrl).not.toBe('https://attacker.invalid')
  })

  it('rejects duplicate and unavailable source evidence IDs before saving a draft', async () => {
    const member = {
      id: 'member-1',
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
      drafts: [],
    }
    const tx = {
      prospectCampaignMember: { findUnique: vi.fn().mockResolvedValue(member), update: vi.fn() },
      prospectSourceEvidence: { findMany: vi.fn().mockResolvedValue([]) },
      prospectOutreachDraft: { create: vi.fn() },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    const input = {
      memberId: 'member-1',
      subject: 'Subject',
      textBody: 'Body',
      groundingSnapshot: {},
      actor: { type: 'AGENT' as const, id: 'agent-1', capabilities: ['prospects:draft'] },
    }

    await expect(
      saveProspectOutreachDraftAction(
        { ...input, sourceEvidenceIds: ['source-1', 'source-1'] },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(tx.prospectSourceEvidence.findMany).not.toHaveBeenCalled()
    await expect(
      saveProspectOutreachDraftAction(
        { ...input, sourceEvidenceIds: ['source-out-of-scope'] },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(tx.prospectOutreachDraft.create).not.toHaveBeenCalled()
  })

  it('removes caller-authored resolved evidence claims when no server IDs are supplied', async () => {
    const tx = {
      prospectCampaignMember: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'member-1',
          organizationId: 'organization-1',
          venueId: null,
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
          drafts: [],
        }),
        update: vi.fn(),
      },
      prospectOutreachDraft: {
        create: vi.fn().mockImplementation(({ data }) => ({ id: 'draft-1', ...data })),
      },
      prospectActivity: { create: vi.fn() },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    const saved = await saveProspectOutreachDraftAction(
      {
        memberId: 'member-1',
        subject: 'Subject',
        textBody: 'Body',
        groundingSnapshot: {
          resolvedSourceEvidence: [{ id: 'source-1', sourceUrl: 'https://attacker.invalid' }],
        },
        actor: { type: 'AGENT', id: 'agent-1', capabilities: ['prospects:draft'] },
      },
      client as never,
    )

    expect(saved.groundingSnapshot).not.toHaveProperty('resolvedSourceEvidence')
  })

  it('retains an unsendable draft for a contact awaiting human readiness review', async () => {
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
            emailReadiness: 'REVIEW_REQUIRED',
            permissionState: 'REVIEW_REQUIRED',
            suppressedAt: null,
            unsubscribedAt: null,
          },
          organization: { relationshipTier: 'STANDARD' },
          drafts: [],
        }),
        update: vi.fn(),
      },
      prospectOutreachDraft: {
        create: vi.fn().mockResolvedValue({ id: 'draft-1', status: 'NEEDS_REVIEW' }),
      },
      prospectActivity: { create: vi.fn() },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }

    await saveProspectOutreachDraftAction(
      {
        memberId: 'member-1',
        subject: 'Torchiko at Example Museum',
        textBody:
          'Hi, I’m Tom Schoenekase. I’d enjoy showing you how Torchiko could help your visitors.',
        groundingSnapshot: { source: 'official-venue-page' },
        actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
      },
      client as never,
    )

    expect(tx.prospectCampaignMember.update).toHaveBeenCalledWith({
      where: { id: 'member-1' },
      data: { status: 'DRAFTED' },
    })
    expect(tx.prospectOutreachDraft.create).toHaveBeenCalled()

    const stageClient = {
      $transaction: vi.fn((work) =>
        work({
          prospectOutreachDraft: {
            findMany: vi.fn().mockResolvedValue([
              {
                id: 'draft-1',
                campaignId: 'campaign-1',
                status: 'APPROVED',
                contact: {
                  normalizedEmail: 'hello@example.org',
                  emailReadiness: 'REVIEW_REQUIRED',
                  permissionState: 'REVIEW_REQUIRED',
                  doNotContact: false,
                  suppressedAt: null,
                  unsubscribedAt: null,
                },
              },
            ]),
          },
        }),
      ),
    }
    await expect(
      stageProspectSendBatchAction(
        {
          campaignId: 'campaign-1',
          draftIds: ['draft-1'],
          actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
        },
        stageClient as never,
      ),
    ).rejects.toMatchObject({ code: 'SUPPRESSED' })
  })

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
          mailboxAddress: 'tomschoenekase@torchiko.com',
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
          mailboxAddress: 'tomschoenekase@torchiko.com',
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

  it('rejects a connected personal mailbox before releasing customer outreach', async () => {
    const tx = {
      prospectDeliveryControl: { findUnique: vi.fn().mockResolvedValue({ deliveryEnabled: true }) },
      correspondenceProviderAccount: {
        findUnique: vi.fn().mockResolvedValue({
          provider: 'GMAIL',
          capabilities: ['SEND'],
          mailboxAddress: 'tomschoenekase@gmail.com',
          connectionStatus: 'CONNECTED',
          deliveryEnabled: true,
          pausedAt: null,
        }),
      },
      prospectSendBatch: { findUnique: vi.fn().mockResolvedValue(null) },
    }
    await expect(
      releaseProspectSendBatchAction(
        {
          batchId: 'batch-1',
          providerAccountId: 'personal-mailbox',
          expectedRecipientCount: 1,
          expectedSnapshotHash: 'a'.repeat(64),
          actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
        },
        { $transaction: vi.fn((work) => work(tx)) } as never,
      ),
    ).rejects.toThrow(/connected, explicitly enabled Gmail mailbox/i)
  })

  it('refuses to release a legacy approved batch above the active canary', async () => {
    const tx = {
      prospectDeliveryControl: {
        findUnique: vi.fn().mockResolvedValue({ deliveryEnabled: true }),
      },
      correspondenceProviderAccount: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'mailbox-1',
          provider: 'GMAIL',
          capabilities: ['SEND'],
          mailboxAddress: 'tomschoenekase@torchiko.com',
          connectionStatus: 'CONNECTED',
          deliveryEnabled: true,
          pausedAt: null,
        }),
      },
      prospectSendBatch: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'batch-legacy-51',
          status: 'APPROVED',
          recipientCount: 51,
          snapshotHash: 'a'.repeat(64),
          items: Array.from({ length: 51 }, (_, index) => ({ id: `item-${index}` })),
          campaign: {},
        }),
      },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }

    await expect(
      releaseProspectSendBatchAction(
        {
          batchId: 'batch-legacy-51',
          providerAccountId: 'mailbox-1',
          expectedRecipientCount: 51,
          expectedSnapshotHash: 'a'.repeat(64),
          actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
        },
        client as never,
      ),
    ).rejects.toThrow(/promotion requires reviewed evidence and a code change/i)
  })
})

describe('existing Gmail draft linkage', () => {
  const input = {
    outreachDraftId: 'crm-draft-1',
    providerAccountId: 'gmail-account-1',
    providerDraftId: 'gmail-draft-1',
    providerMessageId: 'gmail-message-1',
    expectedContentHash: 'a'.repeat(64),
    historyReviewConfirmed: true,
    actor: { type: 'HUMAN' as const, id: 'admin-1', role: 'PLATFORM_ADMIN' as const },
  }

  function setup(overrides: Record<string, unknown> = {}) {
    const existing = vi.fn().mockResolvedValue(null)
    const create = vi
      .fn()
      .mockResolvedValue({ id: 'link-1', ...input, contentHash: input.expectedContentHash })
    const draftRecord = {
      id: input.outreachDraftId,
      status: 'NEEDS_REVIEW',
      contentHash: input.expectedContentHash,
      organizationId: 'org-1',
      venueId: 'venue-1',
      contactId: 'contact-1',
      toEmail: 'hello@example.org',
      contact: {
        id: 'contact-1',
        normalizedEmail: 'hello@example.org',
        doNotContact: false,
        emailReadiness: 'VALID',
        permissionState: 'LEGITIMATE_INTEREST_RECORDED',
        suppressedAt: null,
        unsubscribedAt: null,
        archivedAt: null,
        sourceImportRowId: null as string | null,
      },
      member: {
        id: 'member-1',
        status: 'DRAFTED',
        organizationId: 'org-1',
        venueId: 'venue-1',
        contactId: 'contact-1',
        drafts: [{ id: input.outreachDraftId }],
        contact: { id: 'contact-1' },
        organization: { opportunity: { stage: 'READY_FOR_OUTREACH' } },
      },
    }
    const tx = {
      prospectOutreachDraftGmailLink: { findFirst: existing, create },
      correspondenceProviderAccount: {
        findUnique: vi.fn().mockResolvedValue({
          id: input.providerAccountId,
          provider: 'GMAIL',
          mailboxAddress: 'tomschoenekase@torchiko.com',
          connectionStatus: 'CONNECTED',
        }),
      },
      prospectOutreachDraft: { findUnique: vi.fn().mockResolvedValue(draftRecord) },
      prospectEmailMessage: { findFirst: vi.fn().mockResolvedValue(null) },
      prospectCustomerRelationship: { findFirst: vi.fn().mockResolvedValue(null) },
      prospectImportRow: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'IMPORTED',
          import: { status: 'COMPLETE', failedRows: 0, duplicateRows: 0 },
        }),
      },
      auditLog: { create: vi.fn() },
      ...overrides,
    }
    return {
      tx,
      create,
      existing,
      draftRecord,
      client: { $transaction: vi.fn((work) => work(tx)) },
    }
  }

  it('stores exact IDs and version hash once after current suppression and relationship checks', async () => {
    const { tx, create, client } = setup()
    const result = await linkExistingProspectGmailDraftAction(input, client as never)
    expect(result.id).toBe('link-1')
    expect(create).toHaveBeenCalledWith({
      data: {
        providerAccountId: input.providerAccountId,
        outreachDraftId: input.outreachDraftId,
        providerDraftId: input.providerDraftId,
        providerMessageId: input.providerMessageId,
        contentHash: input.expectedContentHash,
        verificationStatus: 'UNVERIFIED',
        createdBy: 'admin-1',
      },
    })
    expect(tx.prospectEmailMessage.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      select: { id: true },
    })
    expect(tx.auditLog.create).toHaveBeenCalled()
  })

  it('returns an exact retry and rejects an ID collision', async () => {
    const exact = { ...input, contentHash: input.expectedContentHash }
    const retry = setup()
    retry.existing.mockResolvedValue(exact)
    await expect(linkExistingProspectGmailDraftAction(input, retry.client as never)).resolves.toBe(
      exact,
    )
    expect(retry.create).not.toHaveBeenCalled()

    const collision = setup()
    collision.existing.mockResolvedValue({ ...exact, outreachDraftId: 'another-crm-draft' })
    await expect(
      linkExistingProspectGmailDraftAction(input, collision.client as never),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('rejects suppressed contacts and previously contacted opportunities', async () => {
    const suppressed = setup()
    suppressed.tx.prospectOutreachDraft.findUnique.mockResolvedValueOnce({
      id: input.outreachDraftId,
      status: 'NEEDS_REVIEW',
      contentHash: input.expectedContentHash,
      organizationId: 'org-1',
      venueId: 'venue-1',
      contactId: 'contact-1',
      toEmail: 'hello@example.org',
      contact: { id: 'contact-1', normalizedEmail: 'hello@example.org', doNotContact: true },
      member: {
        status: 'DRAFTED',
        organizationId: 'org-1',
        venueId: 'venue-1',
        contactId: 'contact-1',
        drafts: [{ id: input.outreachDraftId }],
        organization: { opportunity: { stage: 'DISCOVERED' } },
      },
    })
    await expect(
      linkExistingProspectGmailDraftAction(input, suppressed.client as never),
    ).rejects.toMatchObject({ code: 'SUPPRESSED' })

    const contacted = setup()
    contacted.tx.prospectOutreachDraft.findUnique.mockResolvedValueOnce({
      id: input.outreachDraftId,
      status: 'NEEDS_REVIEW',
      contentHash: input.expectedContentHash,
      organizationId: 'org-1',
      venueId: 'venue-1',
      contactId: 'contact-1',
      toEmail: 'hello@example.org',
      contact: {
        id: 'contact-1',
        normalizedEmail: 'hello@example.org',
        doNotContact: false,
        emailReadiness: 'VALID',
        permissionState: 'LEGITIMATE_INTEREST_RECORDED',
        suppressedAt: null,
        unsubscribedAt: null,
        archivedAt: null,
      },
      member: {
        status: 'DRAFTED',
        organizationId: 'org-1',
        venueId: 'venue-1',
        contactId: 'contact-1',
        drafts: [{ id: input.outreachDraftId }],
        organization: { opportunity: { stage: 'CONTACTED' } },
      },
    })
    await expect(
      linkExistingProspectGmailDraftAction(input, contacted.client as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('rejects existing CRM correspondence even when the opportunity stage looks eligible', async () => {
    const prior = setup()
    prior.tx.prospectEmailMessage.findFirst.mockResolvedValue({ id: 'message-1' })
    await expect(
      linkExistingProspectGmailDraftAction(input, prior.client as never),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(prior.create).not.toHaveBeenCalled()
  })

  it.each([
    ['UNKNOWN', 'LEGITIMATE_INTEREST_RECORDED'],
    ['REVIEW_REQUIRED', 'LEGITIMATE_INTEREST_RECORDED'],
    ['VALID', 'UNKNOWN'],
    ['VALID', 'REVIEW_REQUIRED'],
  ])('fails closed for readiness %s and permission %s', async (readiness, permission) => {
    const blocked = setup()
    blocked.draftRecord.contact.emailReadiness = readiness
    blocked.draftRecord.contact.permissionState = permission
    await expect(
      linkExistingProspectGmailDraftAction(input, blocked.client as never),
    ).rejects.toMatchObject({ code: 'SUPPRESSED' })
    expect(blocked.create).not.toHaveBeenCalled()
  })

  it('rejects an active CRM customer relationship', async () => {
    const prior = setup()
    prior.tx.prospectCustomerRelationship.findFirst.mockResolvedValue({ id: 'relationship-1' })
    await expect(
      linkExistingProspectGmailDraftAction(input, prior.client as never),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(prior.create).not.toHaveBeenCalled()
  })

  it("waits for an imported lead's owning import to become terminal", async () => {
    const pending = setup()
    pending.draftRecord.contact.sourceImportRowId = 'source-row-1'
    pending.tx.prospectImportRow.findUnique.mockResolvedValue({
      status: 'IMPORTED',
      import: { status: 'PROCESSING', failedRows: 0, duplicateRows: 0 },
    })
    await expect(
      linkExistingProspectGmailDraftAction(input, pending.client as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(pending.create).not.toHaveBeenCalled()

    const completed = setup()
    completed.draftRecord.contact.sourceImportRowId = 'source-row-1'
    await expect(
      linkExistingProspectGmailDraftAction(input, completed.client as never),
    ).resolves.toMatchObject({ id: 'link-1' })
  })
})
