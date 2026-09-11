import { describe, expect, it, vi } from 'vitest'

import { STAFF_INTERVIEW_CONSENT_TEXT } from '@pathfinder/contracts/staff-interview'

import {
  getIntakeV1SubmissionAction,
  getLatestIntakeV1SubmissionAction,
  intakeV1SubmissionSelection,
  listIntakeV1CandidatesAction,
  listIntakeV1UploadCandidatesAction,
  materializeIntakeV1Draft,
} from './intake-v1-submission-actions'

const completeOperations = {
  kind: 'INTERVIEW' as const,
  displayName: 'Operations',
  role: 'OPERATIONS' as const,
  consent: true,
  draftsByRole: {
    OPERATIONS: {
      'operations.hours': {
        mode: 'ANSWER' as const,
        text: '  Daily  ',
        privacy: 'PUBLIC_CANDIDATE' as const,
        uncertain: false,
        confidence: 0.9,
      },
      'operations.closures': {
        mode: 'SKIP' as const,
        text: 'retained draft text',
        privacy: 'PUBLIC_CANDIDATE' as const,
        uncertain: false,
        confidence: 0.8,
      },
      'operations.internal-procedures': {
        mode: 'REDACT' as const,
        text: 'private draft text',
        privacy: 'PRIVATE' as const,
        uncertain: false,
        confidence: 0.8,
      },
    },
  },
}

describe('V1 draft materialization', () => {
  it('materializes only the active role and never promotes retained skip/redact text', () => {
    const proposal = materializeIntakeV1Draft(completeOperations)
    expect(proposal).toMatchObject({
      kind: 'INTERVIEW',
      submission: { consentToUse: true, acceptedConsentText: STAFF_INTERVIEW_CONSENT_TEXT },
    })
    expect(JSON.stringify(proposal)).not.toContain('retained draft text')
    expect(JSON.stringify(proposal)).not.toContain('private draft text')
  })

  it('rejects incomplete, unknown, or privacy-weakened active role drafts', () => {
    expect(materializeIntakeV1Draft({ ...completeOperations, consent: false })).toBeNull()
    expect(
      materializeIntakeV1Draft({
        ...completeOperations,
        draftsByRole: {
          OPERATIONS: {
            ...completeOperations.draftsByRole.OPERATIONS,
            unknown: completeOperations.draftsByRole.OPERATIONS['operations.hours'],
          },
        },
      }),
    ).toBeNull()
    expect(
      materializeIntakeV1Draft({
        ...completeOperations,
        draftsByRole: {
          OPERATIONS: {
            ...completeOperations.draftsByRole.OPERATIONS,
            'operations.internal-procedures': {
              ...completeOperations.draftsByRole.OPERATIONS['operations.internal-procedures'],
              privacy: 'PUBLIC_CANDIDATE',
            },
          },
        },
      }),
    ).toBeNull()
  })

  it('enforces the aggregate 50-member bound and rejects duplicate selections', () => {
    const ids = Array.from({ length: 50 }, (_, index) => `run-${index}`)
    expect(
      intakeV1SubmissionSelection.safeParse({
        operationId: '9d71e9d0-a9fb-429c-aaef-61e3351137c2',
        partialAcknowledged: false,
        drafts: {},
        intakeRunIds: ids,
        intakeUploadIds: [],
      }).success,
    ).toBe(true)
    expect(
      intakeV1SubmissionSelection.safeParse({
        operationId: '9d71e9d0-a9fb-429c-aaef-61e3351137c2',
        partialAcknowledged: false,
        drafts: {},
        intakeRunIds: [...ids, 'run-50'],
        intakeUploadIds: [],
      }).success,
    ).toBe(false)
    expect(
      intakeV1SubmissionSelection.safeParse({
        operationId: '9d71e9d0-a9fb-429c-aaef-61e3351137c2',
        partialAcknowledged: false,
        drafts: {},
        intakeRunIds: ['run-1', 'run-1'],
        intakeUploadIds: [],
      }).success,
    ).toBe(false)
  })

  it('reads a bounded owned revision page without raw draft or object fields', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'submission-1',
      status: 'AWAITING_CANONICAL_REVIEW',
      revision: 22,
      revisions: Array.from({ length: 21 }, (_, index) => ({
        revision: 22 - index,
        manifestHash: 'a'.repeat(64),
        criticalMissing: [],
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        members: [
          {
            ordinal: 0,
            kind: 'INTAKE_UPLOAD',
            immutableHash: 'b'.repeat(64),
            intakeRunId: null,
            intakeUploadId: 'upload-1',
            intakeRun: null,
            intakeUpload: { displayName: 'Uploaded source', intakeRunId: 'linked-run-1' },
          },
        ],
      })),
    })
    const client = { intakeV1Submission: { findFirst } } as unknown as NonNullable<
      Parameters<typeof getIntakeV1SubmissionAction>[0]['client']
    >
    const result = await getIntakeV1SubmissionAction({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      ownerUserId: 'owner-1',
      submissionId: 'submission-1',
      client,
    })
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'submission-1',
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          ownerUserId: 'owner-1',
        },
        select: expect.objectContaining({ revisions: expect.objectContaining({ take: 21 }) }),
      }),
    )
    expect(result.revisions).toHaveLength(20)
    expect(result).toMatchObject({ revisionSemantics: 'FULL_REPLACEMENT', nextRevisionCursor: 3 })
    expect(result.revisions[0]?.members[0]).toMatchObject({
      intakeUploadId: 'upload-1',
      linkedIntakeRunId: 'linked-run-1',
      displayName: 'Uploaded source',
    })
    expect(JSON.stringify(result)).not.toContain('content')
    expect(JSON.stringify(result)).not.toContain('objectKey')
  })

  it('queries only the latest owned aggregate and uses limit-plus-one stable candidate pages', async () => {
    const latestFind = vi.fn().mockResolvedValue(null)
    const runFind = vi.fn().mockResolvedValue([])
    const uploadFind = vi.fn().mockResolvedValue([])
    const client = {
      intakeV1Submission: { findFirst: latestFind },
      intakeRun: { findMany: runFind },
      intakeUpload: { findMany: uploadFind },
    } as unknown as NonNullable<Parameters<typeof getLatestIntakeV1SubmissionAction>[0]['client']>
    await expect(
      getLatestIntakeV1SubmissionAction({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        ownerUserId: 'owner-1',
        client,
      }),
    ).resolves.toBeNull()
    expect(latestFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-1', venueId: 'venue-1', ownerUserId: 'owner-1' },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      }),
    )
    await listIntakeV1CandidatesAction({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      ownerUserId: 'owner-1',
      limit: 20,
      cursor: { createdAt: '2026-01-01T00:00:00.000Z', id: 'run-9' },
      client,
    })
    await listIntakeV1UploadCandidatesAction({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      ownerUserId: 'owner-1',
      limit: 20,
      cursor: { createdAt: '2026-01-01T00:00:00.000Z', id: 'upload-9' },
      client,
    })
    expect(runFind).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 21,
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          requestedBy: 'owner-1',
          requestedByType: 'HUMAN',
          OR: expect.any(Array),
        }),
      }),
    )
    expect(uploadFind).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 21,
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          requestedBy: 'owner-1',
          OR: expect.any(Array),
        }),
      }),
    )
  })

  it('rejects an invalid 51-source candidate request before dispatch', async () => {
    const findMany = vi.fn()
    const client = { intakeRun: { findMany } } as unknown as NonNullable<
      Parameters<typeof listIntakeV1CandidatesAction>[0]['client']
    >
    await expect(
      listIntakeV1CandidatesAction({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        ownerUserId: 'owner-1',
        limit: 51,
        client,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(findMany).not.toHaveBeenCalled()
  })
})
