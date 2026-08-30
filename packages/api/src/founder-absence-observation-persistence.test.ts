import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createMany: vi.fn(),
  findUnique: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    founderAbsenceObservation: {
      createMany: mocks.createMany,
      findUnique: mocks.findUnique,
    },
  },
  withTenantIsolationBypass: <T>(operation: () => Promise<T>) => operation(),
}))

import { captureFounderAbsenceObservation } from './founder-absence-observation'

const now = new Date('2026-08-30T15:29:58.000Z')
const retained = {
  id: 'observation-2026-08-30',
  observedOn: new Date('2026-08-30T00:00:00.000Z'),
  capturedAt: now,
  releaseSha: 'a'.repeat(40),
  schemaVersion: 1,
  snapshotHash: 'b'.repeat(64),
  snapshot: {},
  evidenceComplete: true,
}
const readiness = {
  summary: { dimensionsWithReviewCandidates: 0, visibleSignals: 0 },
  dimensions: [
    {
      key: 'customer-support',
      label: 'Customer support',
      visibleSignals: 0,
      hasMore: false,
      state: 'NO_VISIBLE_SIGNAL' as const,
      interpretation: 'No visible signal in the bounded snapshot.',
    },
  ],
  evidenceWindow: {
    kind: 'BOUNDED_CURRENT_STATE' as const,
    complete: true,
    hasMore: false,
    historicalContinuityVerified: false,
  },
  target: {},
  authority: {},
}

describe('captureFounderAbsenceObservation persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createMany.mockResolvedValue({ count: 1 })
    mocks.findUnique.mockResolvedValue(retained)
  })

  it('retains a daily snapshot with conflict-free insertion', async () => {
    await expect(
      captureFounderAbsenceObservation({ readiness, releaseSha: 'A'.repeat(40), now }),
    ).resolves.toBe(retained)

    expect(mocks.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            observedOn: new Date('2026-08-30T00:00:00.000Z'),
            capturedAt: now,
            releaseSha: 'a'.repeat(40),
            schemaVersion: 1,
            evidenceComplete: true,
          }),
        ],
        skipDuplicates: true,
      }),
    )
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { observedOn: new Date('2026-08-30T00:00:00.000Z') },
    })
  })

  it('returns the immutable existing row on a same-day restart without an exception path', async () => {
    mocks.createMany.mockResolvedValue({ count: 0 })

    await expect(
      captureFounderAbsenceObservation({ readiness, releaseSha: 'c'.repeat(40), now }),
    ).resolves.toBe(retained)

    expect(mocks.createMany).toHaveBeenCalledOnce()
    expect(mocks.findUnique).toHaveBeenCalledOnce()
  })

  it('fails closed when insertion reports success but no retained row can be read', async () => {
    mocks.findUnique.mockResolvedValue(null)

    await expect(
      captureFounderAbsenceObservation({ readiness, releaseSha: 'a'.repeat(40), now }),
    ).rejects.toThrow('Founder absence observation was not retained')
  })
})
