import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  findMany: vi.fn(),
  groupBy: vi.fn(),
  reviewFind: vi.fn(),
  submissionFind: vi.fn(),
  reviewCreate: vi.fn(),
  update: vi.fn(),
  convert: vi.fn(),
  transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) =>
    operation({
      publicInterestSubmissionReview: { findUnique: mocks.reviewFind, create: mocks.reviewCreate },
      publicInterestSubmission: { findUnique: mocks.submissionFind, update: mocks.update },
    }),
  ),
}))

vi.mock('@pathfinder/db', () => ({
  withTenantIsolationBypass: mocks.bypass,
  convertPublicInterestToProspectAction: mocks.convert,
  ProspectActionError: class ProspectActionError extends Error {},
  db: {
    publicInterestSubmission: { findMany: mocks.findMany, groupBy: mocks.groupBy },
    $transaction: mocks.transaction,
  },
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminPublicInterestRouter } from './public-interest'

const caller = (isPlatformAdmin = true) =>
  router({ interest: adminPublicInterestRouter }).createCaller({
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'founder-1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin,
    },
  }).interest

describe('admin public interest review', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findMany.mockResolvedValue([])
    mocks.groupBy.mockResolvedValue([{ status: 'NEW', _count: { _all: 2 } }])
    mocks.reviewFind.mockResolvedValue(null)
    mocks.submissionFind.mockResolvedValue({ id: 'clw1234567890abcdefghijk', status: 'NEW' })
    mocks.reviewCreate.mockResolvedValue({ id: 'review-1' })
    mocks.update.mockResolvedValue({ id: 'clw1234567890abcdefghijk', status: 'REVIEWED' })
    mocks.convert.mockResolvedValue({
      organization: { id: 'prospect-1' },
      conversion: { id: 'conversion-1' },
      replayed: false,
    })
  })

  it('rejects non-admin access before entering the platform bypass', async () => {
    await expect(caller(false).listPublicInterestSubmissions({ limit: 10 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    } satisfies Partial<TRPCError>)
    expect(mocks.bypass).not.toHaveBeenCalled()
  })

  it('returns bounded staged evidence and explicit non-authority policy', async () => {
    await expect(caller().listPublicInterestSubmissions({ limit: 25 })).resolves.toEqual({
      items: [],
      counts: { NEW: 2 },
      policy: {
        automaticProspectCreation: false,
        reviewedHumanConversionAvailable: true,
        sendsCommunication: false,
        pricingAuthorityGranted: false,
      },
    })
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 25 }))
  })

  it('delegates explicit human conversion to the canonical CRM action', async () => {
    const input = {
      operationId: '22222222-2222-4222-8222-222222222222',
      submissionId: 'clw1234567890abcdefghijk',
      reason: 'Reviewed for canonical CRM creation.',
    }
    await caller().convertPublicInterestSubmissionToProspect(input)
    expect(mocks.convert).toHaveBeenCalledWith({
      ...input,
      actor: { type: 'HUMAN', id: 'founder-1', role: 'PLATFORM_ADMIN' },
    })
  })

  it('records append-only human review evidence and updates the projection', async () => {
    const input = {
      operationId: '22222222-2222-4222-8222-222222222222',
      submissionId: 'clw1234567890abcdefghijk',
      decision: 'MARK_REVIEWED' as const,
      reason: 'Reviewed for CRM reconciliation.',
    }
    await caller().reviewPublicInterestSubmission(input)
    expect(mocks.reviewCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operationId: input.operationId,
        operationHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        reviewerId: 'founder-1',
      }),
    })
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'REVIEWED', reviewedBy: 'founder-1' }),
      }),
    )
  })

  it('returns exact replays and rejects changed operation reuse', async () => {
    mocks.reviewFind.mockResolvedValue({
      operationHash: 'a'.repeat(64),
      submission: { id: 'clw1234567890abcdefghijk', status: 'REVIEWED' },
    })
    await expect(
      caller().reviewPublicInterestSubmission({
        operationId: '22222222-2222-4222-8222-222222222222',
        submissionId: 'clw1234567890abcdefghijk',
        decision: 'ARCHIVE',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<TRPCError>)
    expect(mocks.reviewCreate).not.toHaveBeenCalled()
  })
})
