import { describe, expect, it } from 'vitest'

import {
  projectProspectNoSendRehearsal,
  type ProspectNoSendRehearsalInput,
} from './prospect-outreach-rehearsal'

function fixture(): ProspectNoSendRehearsalInput {
  return {
    campaignId: 'campaign-1',
    generatedAt: new Date('2026-08-26T04:00:00Z'),
    campaignStatus: 'DRAFT',
    campaignPausedAt: null,
    processDeliveryEnabled: false,
    globalDeliveryEnabled: false,
    internalOnly: true,
    openDuplicateCandidateCount: 0,
    members: [
      {
        id: 'member-1',
        organizationId: 'org-1',
        status: 'NEEDS_REVIEW',
        contact: {
          id: 'contact-1',
          normalizedEmail: 'internal@example.com',
          emailReadiness: 'VALID',
          permissionState: 'LEGITIMATE_INTEREST_RECORDED',
          doNotContact: false,
          suppressedAt: null,
          unsubscribedAt: null,
          source: 'fixture',
          provenance: [{ source: 'fixture' }],
          sourceImportRowId: null,
          sources: [{ id: 'evidence-1' }],
        },
        drafts: [
          {
            id: 'draft-1',
            status: 'NEEDS_REVIEW',
            escalationFlags: [],
            approvedAt: null,
            approvedBy: null,
          },
        ],
      },
    ],
    batches: [],
  }
}

describe('projectProspectNoSendRehearsal', () => {
  it('reports a bounded, dark, zero-cost campaign as ready only for human review', () => {
    const result = projectProspectNoSendRehearsal(fixture())

    expect(result.outcome).toBe('READY_FOR_HUMAN_REVIEW')
    expect(result.readyForHumanReview).toBe(true)
    expect(result.readyToSend).toBe(false)
    expect(result.safety).toMatchObject({
      deliveryDark: true,
      providerRequired: false,
      providerCallsMade: 0,
      estimatedProviderCostUsd: 0,
      emergencyStopDirection: 'DISABLE_ONLY',
    })
  })

  it('blocks duplicates, suppressions, missing provenance, and enabled delivery together', () => {
    const input = fixture()
    const first = input.members[0]!
    const unsafe = {
      ...first,
      id: 'member-2',
      organizationId: 'org-2',
      contact: {
        ...first.contact!,
        id: 'contact-2',
        source: null,
        provenance: [],
        sources: [],
        doNotContact: true,
      },
    }
    const result = projectProspectNoSendRehearsal({
      ...input,
      processDeliveryEnabled: true,
      members: [first, unsafe],
    })

    expect(result.readyForHumanReview).toBe(false)
    expect(result.readyToSend).toBe(false)
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        'DELIVERY_NOT_DARK',
        'CONTACT_SAFETY_FAILED',
        'CONTACT_PROVENANCE_MISSING',
        'DUPLICATE_MEMBER_EMAIL',
      ]),
    )
  })

  it('rejects a frozen snapshot with duplicate identities or provider side effects', () => {
    const input = fixture()
    const frozen = {
      recipientEmailSnapshot: 'internal@example.com',
      recipientIdentityHash: 'b'.repeat(64),
      contentHashSnapshot: 'c'.repeat(64),
      status: 'STAGED',
      providerAccountId: null,
      providerMessageId: null,
    }
    const result = projectProspectNoSendRehearsal({
      ...input,
      batches: [
        {
          id: 'batch-1',
          status: 'STAGED',
          recipientCount: 2,
          snapshotHash: 'a'.repeat(64),
          items: [frozen, { ...frozen, providerAccountId: 'mailbox-1' }],
        },
      ],
    })

    expect(result.blockers).toEqual(
      expect.arrayContaining(['DUPLICATE_FROZEN_RECIPIENT', 'FROZEN_SNAPSHOT_INVALID']),
    )
    expect(result.safety.providerCallsMade).toBe(0)
  })

  it('blocks unresolved organization duplicates and approval without actor evidence', () => {
    const input = fixture()
    input.openDuplicateCandidateCount = 1
    input.members[0]!.drafts[0] = {
      ...input.members[0]!.drafts[0]!,
      status: 'APPROVED',
      approvedAt: new Date('2026-08-26T04:01:00Z'),
      approvedBy: null,
    }

    const result = projectProspectNoSendRehearsal(input)

    expect(result.blockers).toEqual(
      expect.arrayContaining(['ORGANIZATION_DUPLICATE_UNRESOLVED', 'APPROVAL_EVIDENCE_MISSING']),
    )
  })

  it('blocks a legacy 51-recipient batch until canary promotion is separately reviewed', () => {
    const input = fixture()
    const items = Array.from({ length: 51 }, (_, index) => ({
      recipientEmailSnapshot: `recipient-${index}@example.com`,
      recipientIdentityHash: index.toString(16).padStart(64, '0'),
      contentHashSnapshot: (index + 100).toString(16).padStart(64, '0'),
      status: 'STAGED',
      providerAccountId: null,
      providerMessageId: null,
    }))
    const result = projectProspectNoSendRehearsal({
      ...input,
      batches: [
        {
          id: 'batch-legacy-51',
          status: 'STAGED',
          recipientCount: items.length,
          snapshotHash: 'a'.repeat(64),
          items,
        },
      ],
    })

    expect(result.blockers).toContain('CANARY_RELEASE_LIMIT_EXCEEDED')
    expect(result.cohort).toMatchObject({
      activeReleaseLimit: 50,
      withinActiveReleaseLimit: false,
    })
    expect(result.releasePolicy).toMatchObject({
      phase: 'INITIAL_CANARY',
      nextPhaseMaxRecipients: 100,
      promotionStatus: 'NOT_AUTHORIZED',
    })
  })
})
