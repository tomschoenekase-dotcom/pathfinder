import { describe, expect, it, vi } from 'vitest'

import {
  STAFF_INTERVIEW_CONSENT_TEXT,
  type StaffInterviewSubmission,
} from '@pathfinder/contracts/staff-interview'

import {
  createIntakeAdapterRegistry,
  createStaffInterviewSourceAdapter,
  orchestrateIntake,
  StaffInterviewAdapterError,
} from './index'

const CAPTURED_AT = '2026-08-11T20:00:00.000Z'
const interviewSource = {
  id: 'interview_1',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  kind: 'INTERVIEW' as const,
  displayName: 'Operations written interview',
  capturedAt: CAPTURED_AT,
}

function submission(overrides: Partial<StaffInterviewSubmission> = {}): StaffInterviewSubmission {
  return {
    role: 'OPERATIONS',
    consentToUse: true,
    acceptedConsentText: STAFF_INTERVIEW_CONSENT_TEXT,
    answers: [
      {
        questionId: 'operations.hours',
        text: 'Open 9am to 5pm.',
        privacy: 'PUBLIC_CANDIDATE',
        skipped: false,
        redacted: false,
        uncertain: false,
        confidence: 0.9,
      },
    ],
    ...overrides,
  }
}

const context = { signal: undefined, remainingCostUnits: 100, remainingTimeMs: 30_000 }
const budget = {
  maxSources: 10,
  maxEvidence: 100,
  maxDiscrepancies: 100,
  maxCostUnits: 100,
  maxDurationMs: 30_000,
}

describe('staff interview intake adapter', () => {
  it('enforces role-specific question separation', async () => {
    const adapter = createStaffInterviewSourceAdapter({
      loadSubmission: () =>
        submission({
          answers: [
            {
              questionId: 'content.voice',
              text: 'Warm and concise.',
              privacy: 'PUBLIC_CANDIDATE',
              skipped: false,
              redacted: false,
              uncertain: false,
              confidence: 0.9,
            },
          ],
        }),
    })

    await expect(adapter.extract(interviewSource, context)).rejects.toMatchObject({
      code: 'INVALID_INTERVIEW',
    })
  })

  it('never maps internal or private answers into the public candidate', async () => {
    const internalText = 'Escalate incidents to the private duty phone.'
    const privateText = 'The alarm code is confidential.'
    const adapter = createStaffInterviewSourceAdapter({
      loadSubmission: () =>
        submission({
          answers: [
            {
              questionId: 'operations.hours',
              text: internalText,
              privacy: 'INTERNAL_CONTEXT',
              skipped: false,
              redacted: false,
              uncertain: false,
              confidence: 0.9,
            },
            {
              questionId: 'operations.internal-procedures',
              text: privateText,
              privacy: 'PUBLIC_CANDIDATE',
              skipped: false,
              redacted: false,
              uncertain: false,
              confidence: 0.8,
            },
          ],
        }),
    })

    const result = await adapter.extract(interviewSource, context)

    expect(result.status).toBe('EXTRACTED')
    if (result.status !== 'EXTRACTED') throw new Error('Expected extraction')
    expect(result.claims).toEqual([])
    expect(result.candidate?.publicAnswers).toEqual([])
    expect(result.candidate?.withheld).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ questionId: 'operations.hours', reason: 'INTERNAL_CONTEXT' }),
        expect.objectContaining({
          questionId: 'operations.internal-procedures',
          reason: 'PRIVATE',
        }),
      ]),
    )
    expect(JSON.stringify(result.candidate)).not.toContain(internalText)
    expect(JSON.stringify(result.candidate)).not.toContain(privateText)
  })

  it('removes redacted text and reports the resulting missing information', async () => {
    const redactedText = 'Do not retain this answer.'
    const adapter = createStaffInterviewSourceAdapter({
      loadSubmission: () =>
        submission({
          answers: [
            {
              questionId: 'operations.hours',
              text: redactedText,
              privacy: 'PUBLIC_CANDIDATE',
              skipped: false,
              redacted: true,
              uncertain: false,
              confidence: 0.9,
            },
          ],
        }),
    })

    const result = await adapter.extract(interviewSource, context)

    expect(result.status).toBe('EXTRACTED')
    if (result.status !== 'EXTRACTED') throw new Error('Expected extraction')
    expect(result.evidence).toEqual([])
    expect(result.candidate?.missingInformation).toContainEqual({
      questionId: 'operations.hours',
      reason: 'REDACTED',
    })
    expect(JSON.stringify(result)).not.toContain(redactedText)
  })

  it('blocks absent consent before using any answers or creating a draft proposal', async () => {
    const createDraftForReview = vi.fn()
    const adapter = createStaffInterviewSourceAdapter({
      loadSubmission: () => submission({ consentToUse: false, acceptedConsentText: undefined }),
    })

    const result = await orchestrateIntake(
      { sources: [interviewSource], budget },
      {
        registry: createIntakeAdapterRegistry({ interview: adapter }),
        buildDraftCandidate: vi.fn(async () => ({ public: true })),
        draftHandoff: { createDraftForReview },
        now: () => new Date(CAPTURED_AT),
      },
    )

    expect(result.stopReason).toBe('CONSENT_REQUIRED')
    expect(result.proposal.status).toBe('FAILED')
    expect(result.adapterResults).toEqual([
      expect.objectContaining({ status: 'BLOCKED', reason: 'CONSENT_REQUIRED' }),
    ])
    expect(result.evidence).toEqual([])
    expect(createDraftForReview).not.toHaveBeenCalled()
  })

  it('structurally rejects recording fields and source recording flags', async () => {
    const withAudio = createStaffInterviewSourceAdapter({
      loadSubmission: () => ({ ...submission(), audioAssetId: 'asset_1' }) as never,
    })
    await expect(withAudio.extract(interviewSource, context)).rejects.toBeInstanceOf(
      StaffInterviewAdapterError,
    )

    const valid = createStaffInterviewSourceAdapter({ loadSubmission: () => submission() })
    await expect(
      valid.extract({ ...interviewSource, consentToRecord: false }, context),
    ).rejects.toMatchObject({ code: 'RECORDING_NOT_ALLOWED' })
  })

  it('produces deterministic evidence and uncertainty metadata from text answers', async () => {
    const adapter = createStaffInterviewSourceAdapter({
      loadSubmission: () =>
        submission({
          answers: [
            {
              questionId: 'operations.hours',
              text: '  Open 9am   to 5pm. ',
              privacy: 'PUBLIC_CANDIDATE',
              skipped: false,
              redacted: false,
              uncertain: true,
              confidence: 0.55,
            },
          ],
        }),
    })

    const first = await adapter.extract(interviewSource, context)
    const second = await adapter.extract(interviewSource, context)

    expect(second).toEqual(first)
    expect(first.status).toBe('EXTRACTED')
    if (first.status !== 'EXTRACTED') throw new Error('Expected extraction')
    expect(first.evidence[0]?.normalizedHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(first.candidate?.publicAnswers[0]?.text).toBe('Open 9am to 5pm.')
    expect(first.candidate?.uncertainties).toEqual([
      { questionId: 'operations.hours', confidence: 0.55 },
    ])
  })

  it('feeds the shared proposal pipeline without auto-publish or apply behavior', async () => {
    const adapter = createStaffInterviewSourceAdapter({ loadSubmission: () => submission() })

    const result = await orchestrateIntake(
      { sources: [interviewSource], budget },
      {
        registry: createIntakeAdapterRegistry({ interview: adapter }),
        now: () => new Date(CAPTURED_AT),
      },
    )

    expect(result.proposal.status).toBe('AWAITING_REVIEW')
    expect(result.proposal.autoPublish).toBe(false)
    expect(result.execution).toEqual({
      autoPublish: false,
      autoApply: false,
      lifecycleCommands: [],
    })
    expect(result.proposal.packageDraftId).toBeUndefined()
  })
})
