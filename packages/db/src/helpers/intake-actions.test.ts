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
const runFindFirst = vi.fn()
const executeRaw = vi.fn()
const evidenceCreate = vi.fn()
const eventCreate = vi.fn()
const auditCreate = vi.fn()
const db = {
  venue: { findFirst: venueFindFirst },
  intakeRun: { create: runCreate, findFirst: runFindFirst },
  intakeEvidenceRecord: { create: evidenceCreate },
  intakeRunEvent: { create: eventCreate },
  auditLog: { create: auditCreate },
  $executeRaw: executeRaw,
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
} as unknown as IntakeActionClient

describe('canonical intake actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    venueFindFirst.mockResolvedValue({ id: 'venue-a' })
    runFindFirst.mockResolvedValue(null)
    executeRaw.mockResolvedValue(1)
    auditCreate.mockResolvedValue({ id: 'audit-1' })
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
      actor: { type: 'HUMAN' as const, id: 'operator-a', role: 'MANAGER' as const },
      requestId: '56d3ed81-d294-4051-abd2-0e1a77f61ec7',
      proposal: {
        kind: 'INTERVIEW',
        displayName: 'Operations interview',
        submission: {
          role: 'OPERATIONS',
          consentToUse: true,
          acceptedConsentText: STAFF_INTERVIEW_CONSENT_TEXT,
          answers: [
            {
              questionId: 'operations.hours',
              privacy: 'PUBLIC_CANDIDATE',
              skipped: true,
              redacted: false,
              uncertain: false,
              confidence: 0.8,
            },
            {
              questionId: 'operations.closures',
              privacy: 'PUBLIC_CANDIDATE',
              skipped: false,
              redacted: true,
              uncertain: false,
              confidence: 0.8,
            },
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
    expect(persisted.interviewAnswerManifest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          questionId: 'operations.internal-procedures',
          privacy: 'PRIVATE',
          normalizedHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]),
    )
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
        actor: { type: 'HUMAN', id: 'operator-a', role: 'MANAGER' },
        requestId: '56d3ed81-d294-4051-abd2-0e1a77f61ec7',
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

  it('stores optional notes as review-only structured evidence without leaking text to audit', async () => {
    runCreate.mockResolvedValueOnce({
      id: 'run-notes',
      venueId: 'venue-a',
      sourceKind: 'STRUCTURED_BOOTSTRAP',
      status: 'AWAITING_REVIEW',
      displayName: 'Optional notes',
      createdAt: new Date(),
    })
    await createIntakeProposal({
      db,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      actor: { type: 'HUMAN', id: 'operator-a', role: 'OWNER' },
      requestId: '168c2e1a-8ece-47ad-98dc-e4bde64872ca',
      proposal: { kind: 'NOTES', notes: 'The east entrance is step-free.' },
    })

    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceKind: 'STRUCTURED_BOOTSTRAP',
          displayName: 'Optional notes',
          structuredBootstrap: {
            kind: 'OPTIONAL_NOTES',
            notes: 'The east entrance is step-free.',
          },
        }),
      }),
    )
    expect(evidenceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        runId: 'run-notes',
        sourceKind: 'STRUCTURED_BOOTSTRAP',
        locator: 'optional-notes:run-notes',
        normalizedHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    })
    expect(eventCreate).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(auditCreate.mock.calls[0]?.[0]?.data)).not.toContain(
      'The east entrance is step-free.',
    )
  })

  it('replays an exact actor-bound request without creating duplicate evidence or events', async () => {
    runFindFirst.mockResolvedValue({
      id: 'run-1',
      venueId: 'venue-a',
      sourceKind: 'WEBSITE',
      status: 'AWAITING_REVIEW',
      displayName: 'Venue site',
      requestedBy: 'operator-a',
      submissionInputHash: expect.any(String),
      createdAt: new Date(),
    })
    // Bind the replay to the exact canonical hash produced by the first successful request.
    runFindFirst.mockResolvedValueOnce(null)
    const action = {
      db,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      actor: { type: 'HUMAN' as const, id: 'operator-a', role: 'MANAGER' as const },
      requestId: '56d3ed81-d294-4051-abd2-0e1a77f61ec7',
      proposal: {
        kind: 'WEBSITE' as const,
        displayName: 'Venue site',
        websiteUri: 'https://example.com',
      },
    }
    await createIntakeProposal(action)
    const persisted = runCreate.mock.calls[0]?.[0]?.data
    runFindFirst.mockResolvedValue({
      id: 'run-1',
      venueId: 'venue-a',
      sourceKind: 'WEBSITE',
      status: 'AWAITING_REVIEW',
      displayName: 'Venue site',
      requestedBy: 'operator-a',
      submissionInputHash: persisted.submissionInputHash,
      createdAt: new Date(),
    })
    const replay = await createIntakeProposal(action)
    expect(replay.replayed).toBe(true)
    expect(runCreate).toHaveBeenCalledTimes(1)
    expect(eventCreate).toHaveBeenCalledTimes(1)
    expect(auditCreate).toHaveBeenCalledTimes(1)
  })

  it('rejects request-key reuse by another actor before creating a second run', async () => {
    runFindFirst.mockResolvedValue({
      id: 'run-1',
      venueId: 'venue-a',
      sourceKind: 'WEBSITE',
      status: 'AWAITING_REVIEW',
      displayName: 'Venue site',
      requestedBy: 'operator-b',
      submissionInputHash: 'a'.repeat(64),
      createdAt: new Date(),
    })
    await expect(
      createIntakeProposal({
        db,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        actor: { type: 'HUMAN', id: 'operator-a', role: 'MANAGER' },
        requestId: '56d3ed81-d294-4051-abd2-0e1a77f61ec7',
        proposal: {
          kind: 'WEBSITE',
          displayName: 'Venue site',
          websiteUri: 'https://example.com',
        },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(runCreate).not.toHaveBeenCalled()
  })

  it('rejects non-human or under-authorized actors before database work', async () => {
    await expect(
      createIntakeProposal({
        db,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        actor: { type: 'HUMAN', id: 'staff-a', role: 'STAFF' } as never,
        requestId: '56d3ed81-d294-4051-abd2-0e1a77f61ec7',
        proposal: {
          kind: 'WEBSITE',
          displayName: 'Venue site',
          websiteUri: 'https://example.com',
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(venueFindFirst).not.toHaveBeenCalled()
    expect(executeRaw).not.toHaveBeenCalled()
  })

  it('writes one sanitized strict audit and propagates audit failure through the transaction', async () => {
    auditCreate.mockRejectedValue(new Error('audit unavailable'))
    await expect(
      createIntakeProposal({
        db,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        actor: { type: 'HUMAN', id: 'operator-a', role: 'OWNER' },
        requestId: '56d3ed81-d294-4051-abd2-0e1a77f61ec7',
        proposal: {
          kind: 'WEBSITE',
          displayName: 'Secret display name',
          websiteUri: 'https://private.example/secret',
        },
      }),
    ).rejects.toThrow('audit unavailable')
    const audit = auditCreate.mock.calls[0]?.[0]?.data
    expect(audit).toMatchObject({
      actorId: 'operator-a',
      actorRole: 'OWNER',
      action: 'intake.proposal-created',
      afterState: expect.objectContaining({
        sourceKind: 'WEBSITE',
        status: 'AWAITING_REVIEW',
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    })
    expect(JSON.stringify(audit)).not.toContain('Secret display name')
    expect(JSON.stringify(audit)).not.toContain('private.example')
  })

  it('converges an exact P2002 replay and rejects a mismatched recovery row', async () => {
    const conflict = Object.assign(new Error('unique'), { code: 'P2002' })
    runCreate.mockRejectedValue(conflict)
    runFindFirst.mockResolvedValueOnce(null)
    const action = {
      db,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      actor: { type: 'HUMAN' as const, id: 'operator-a', role: 'MANAGER' as const },
      requestId: '56d3ed81-d294-4051-abd2-0e1a77f61ec7',
      proposal: {
        kind: 'WEBSITE' as const,
        displayName: 'Venue site',
        websiteUri: 'https://example.com',
      },
    }
    runFindFirst.mockResolvedValueOnce({
      id: 'run-1',
      venueId: 'venue-a',
      sourceKind: 'WEBSITE',
      status: 'AWAITING_REVIEW',
      displayName: 'Venue site',
      requestedBy: 'operator-a',
      submissionInputHash: 'wrong'.padEnd(64, '0'),
      createdAt: new Date(),
    })
    await expect(createIntakeProposal(action)).rejects.toMatchObject({ code: 'CONFLICT' })

    runFindFirst.mockReset().mockResolvedValueOnce(null)
    runCreate.mockImplementationOnce(async (args) => {
      const hash = args.data.submissionInputHash
      runFindFirst.mockResolvedValueOnce({
        id: 'run-1',
        venueId: 'venue-a',
        sourceKind: 'WEBSITE',
        status: 'AWAITING_REVIEW',
        displayName: 'Venue site',
        requestedBy: 'operator-a',
        submissionInputHash: hash,
        createdAt: new Date(),
      })
      throw conflict
    })
    await expect(createIntakeProposal(action)).resolves.toMatchObject({ replayed: true })
  })
})
