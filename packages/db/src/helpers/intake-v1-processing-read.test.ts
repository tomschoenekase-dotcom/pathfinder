import { describe, expect, it, vi } from 'vitest'

import { getIntakeV1ProcessingRead, IntakeV1ProcessingReadError } from './intake-v1-processing-read'

const base = {
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  ownerUserId: 'user-a',
  submissionId: 'submission-a',
  revision: 2,
  websiteResearchEnabled: false,
}

function member(
  ordinal: number,
  processingDispatch: {
    kind: string
    status: string
    holdReason: string | null
    leaseExpiresAt?: Date | null
  } | null,
) {
  return {
    id: `member-${ordinal}`,
    ordinal,
    intakeRun: {
      displayName: `Source ${ordinal}`,
      sourceKind: ordinal === 1 ? 'WEBSITE' : 'INTERVIEW',
    },
    intakeUpload: null,
    processingDispatch: processingDispatch
      ? { ...processingDispatch, leaseExpiresAt: processingDispatch.leaseExpiresAt ?? null }
      : null,
  }
}

describe('getIntakeV1ProcessingRead', () => {
  it('returns bounded safe owner progress without provider or source internals', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      submissionId: 'submission-a',
      revision: 2,
      createdAt: new Date('2026-09-07T12:00:00.000Z'),
      members: [
        member(1, { kind: 'WEBSITE_RESEARCH', status: 'PENDING', holdReason: null }),
        member(2, { kind: 'REVIEW_READY', status: 'COMPLETED', holdReason: null }),
        member(3, {
          kind: 'WEBSITE_RESEARCH',
          status: 'LEASED',
          holdReason: null,
          leaseExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
        }),
        member(4, {
          kind: 'EXTRACTION_UNSUPPORTED',
          status: 'HELD',
          holdReason: 'EXTRACTION_NOT_EXECUTABLE',
        }),
        member(5, { kind: 'WEBSITE_RESEARCH', status: 'FAILED', holdReason: null }),
        member(6, null),
      ],
    })
    const result = await getIntakeV1ProcessingRead(base, {
      intakeV1SubmissionRevision: { findFirst },
    } as never)

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          submissionId: 'submission-a',
          revision: 2,
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          submission: { ownerUserId: 'user-a' },
        },
        select: expect.objectContaining({
          members: expect.objectContaining({ take: 51, orderBy: { ordinal: 'asc' } }),
        }),
      }),
    )
    expect(result.counts).toEqual({
      total: 6,
      pending: 0,
      inProgress: 1,
      completed: 1,
      held: 1,
      failed: 1,
      policyDisabled: 1,
      notScheduled: 1,
    })
    expect(result.members[0]).toMatchObject({
      sourceLabel: 'Website',
      status: 'POLICY_DISABLED',
      reasonCode: 'WEBSITE_RESEARCH_DISABLED',
    })
    expect(result.members[5]).toMatchObject({
      processingKind: null,
      status: 'NOT_SCHEDULED',
      reasonCode: 'NOT_SCHEDULED_HISTORICAL',
    })
    expect(result).toMatchObject({
      completionMeaning: 'MATERIAL_PROCESSING_ONLY',
      publicationCreated: false,
    })
    expect(JSON.stringify(result)).not.toMatch(/lastError|leaseToken|websiteUri|immutableHash/iu)
  })

  it('keeps enabled website work pending rather than reporting success', async () => {
    const result = await getIntakeV1ProcessingRead({ ...base, websiteResearchEnabled: true }, {
      intakeV1SubmissionRevision: {
        findFirst: vi.fn().mockResolvedValue({
          submissionId: 'submission-a',
          revision: 2,
          createdAt: new Date(),
          members: [member(1, { kind: 'WEBSITE_RESEARCH', status: 'PENDING', holdReason: null })],
        }),
      },
    } as never)
    expect(result.members[0]?.status).toBe('PENDING')
    expect(result.counts.pending).toBe(1)
  })

  it('projects an expired or malformed website lease as recoverable pending using one injected clock', async () => {
    const clock = vi.fn(() => new Date('2026-09-07T12:00:00.000Z'))
    const findFirst = vi.fn().mockResolvedValue({
      submissionId: 'submission-a',
      revision: 2,
      createdAt: new Date(),
      members: [
        member(1, {
          kind: 'WEBSITE_RESEARCH',
          status: 'LEASED',
          holdReason: null,
          leaseExpiresAt: new Date('2026-09-07T11:59:59.999Z'),
        }),
        member(2, { kind: 'WEBSITE_RESEARCH', status: 'LEASED', holdReason: null }),
      ],
    })
    const result = await getIntakeV1ProcessingRead(
      { ...base, websiteResearchEnabled: true },
      { intakeV1SubmissionRevision: { findFirst } } as never,
      clock,
    )
    expect(clock).toHaveBeenCalledTimes(1)
    expect(result.members.map(({ status, reasonCode }) => ({ status, reasonCode }))).toEqual([
      { status: 'PENDING', reasonCode: 'PROCESSING_RECOVERY_PENDING' },
      { status: 'PENDING', reasonCode: 'PROCESSING_RECOVERY_PENDING' },
    ])
    expect(result.counts.pending).toBe(2)
    expect(JSON.stringify(result)).not.toMatch(/leaseExpiresAt|leaseToken/iu)
  })

  it('projects expired website work as policy disabled while the worker gate is off', async () => {
    const result = await getIntakeV1ProcessingRead(
      base,
      {
        intakeV1SubmissionRevision: {
          findFirst: vi.fn().mockResolvedValue({
            submissionId: 'submission-a',
            revision: 2,
            createdAt: new Date(),
            members: [
              member(1, {
                kind: 'WEBSITE_RESEARCH',
                status: 'LEASED',
                holdReason: null,
                leaseExpiresAt: new Date('2026-09-07T00:00:00.000Z'),
              }),
            ],
          }),
        },
      } as never,
      () => new Date('2026-09-07T12:00:00.000Z'),
    )
    expect(result.members[0]).toMatchObject({
      status: 'POLICY_DISABLED',
      reasonCode: 'WEBSITE_RESEARCH_DISABLED',
    })
  })

  it('fails closed for a missing scoped owner revision and an oversized revision', async () => {
    await expect(
      getIntakeV1ProcessingRead(base, {
        intakeV1SubmissionRevision: { findFirst: vi.fn().mockResolvedValue(null) },
      } as never),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      getIntakeV1ProcessingRead(base, {
        intakeV1SubmissionRevision: {
          findFirst: vi.fn().mockResolvedValue({
            submissionId: 'submission-a',
            revision: 2,
            createdAt: new Date(),
            members: Array.from({ length: 51 }, (_, index) => member(index, null)),
          }),
        },
      } as never),
    ).rejects.toBeInstanceOf(IntakeV1ProcessingReadError)
  })
})
