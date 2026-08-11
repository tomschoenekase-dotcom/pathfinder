import { beforeEach, describe, expect, it, vi } from 'vitest'

import { STAFF_INTERVIEW_CONSENT_TEXT } from '@pathfinder/contracts/staff-interview'

import {
  createIntakeProposal,
  IntakeActionError,
  type IntakeActionClient,
  type IntakeProposalInput,
} from './intake-actions'

const venueFindFirst = vi.fn()
const runCreate = vi.fn()
const evidenceCreate = vi.fn()
const eventCreate = vi.fn()
const db = {
  venue: { findFirst: venueFindFirst },
  intakeRun: { create: runCreate },
  intakeEvidenceRecord: { create: evidenceCreate },
  intakeRunEvent: { create: eventCreate },
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
} as unknown as IntakeActionClient

describe('canonical intake actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    venueFindFirst.mockResolvedValue({ id: 'venue-a' })
    runCreate.mockResolvedValue({
      id: 'run-1',
      venueId: 'venue-a',
      sourceKind: 'INTERVIEW',
      status: 'AWAITING_REVIEW',
      displayName: 'Operations interview',
      createdAt: new Date(),
    })
  })

  it('pins venue scope and never passes private answer text to persistence', async () => {
    await createIntakeProposal({
      db,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      actorId: 'operator-a',
      proposal: {
        kind: 'INTERVIEW',
        displayName: 'Operations interview',
        submission: {
          role: 'OPERATIONS',
          consentToUse: true,
          acceptedConsentText: STAFF_INTERVIEW_CONSENT_TEXT,
          answers: [
            {
              questionId: 'operations.internal-procedures',
              text: 'Private escalation instructions.',
              privacy: 'PRIVATE',
              skipped: false,
              redacted: false,
              uncertain: false,
              confidence: 0.8,
            },
          ],
        },
      },
    })

    expect(venueFindFirst).toHaveBeenCalledWith({
      where: { id: 'venue-a', tenantId: 'tenant-a' },
      select: { id: true },
    })
    const persisted = runCreate.mock.calls[0]?.[0]?.data
    expect(JSON.stringify(persisted)).not.toContain('Private escalation instructions.')
    expect(persisted.interviewPublicAnswers).toEqual([])
    expect(persisted.interviewAnswerManifest).toEqual([
      expect.objectContaining({
        questionId: 'operations.internal-procedures',
        privacy: 'PRIVATE',
        normalizedHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ])
    expect(evidenceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        normalizedHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    })
  })

  it('returns a typed domain error before scope or persistence work for invalid input', async () => {
    await expect(
      createIntakeProposal({
        db,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        actorId: 'operator-a',
        proposal: {
          kind: 'WEBSITE',
          displayName: 'Invalid site',
          websiteUri: 'not-a-url',
        } as IntakeProposalInput,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<IntakeActionError>>({ code: 'INVALID_INPUT' }),
    )
    expect(venueFindFirst).not.toHaveBeenCalled()
    expect(runCreate).not.toHaveBeenCalled()
  })
})
