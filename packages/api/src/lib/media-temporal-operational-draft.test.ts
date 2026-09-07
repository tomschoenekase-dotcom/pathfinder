import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { mediaIntakeHash } from './media-intake-snapshot'
import { reviewedMediaTemporalOperationalDraft } from './media-temporal-operational-draft'

vi.mock('./media-intake-snapshot', async (original) => ({
  ...(await original<typeof import('./media-intake-snapshot')>()),
  validateMediaIntakeSnapshot: (value: unknown) => value,
}))

function claim(claimId = 'hours', value = 'Open 10–4', effectiveFrom = '2026-09-08T00:00:00.000Z') {
  return {
    claimId,
    value,
    valueHash: createHash('sha256').update(value).digest('hex'),
    targetKey: 'greenhouse:hours',
    targetItemHash: 'a'.repeat(64),
    claimType: 'TEMPORARY_SCHEDULE' as const,
    authority: 'AUTHORIZED_STAFF' as const,
    consequential: true,
    effectiveFrom,
    effectiveUntil: '2026-09-15T00:00:00.000Z',
    source: {
      sourceId: claimId,
      sourceSha256: 'b'.repeat(64),
      sourceVersion: 'upload',
      capturedAt: null,
      observationIndex: 0,
      observationSha256: 'c'.repeat(64),
    },
  }
}
function input(claims: unknown[] = [claim()]) {
  const snapshot = {
    tenantId: 'tenant',
    venueId: 'venue',
    projectId: 'project',
    sourceGeneration: 'generation',
    temporalReview: { claims },
  }
  return {
    snapshot,
    expectedSnapshotHash: mediaIntakeHash(snapshot),
    claimId: 'hours',
    now: '2026-09-07T10:00:00.000Z',
  }
}

describe('dated media operational draft policy', () => {
  it('derives exact finite future dates and inactive draft fields from frozen claims', () => {
    expect(reviewedMediaTemporalOperationalDraft(input())).toMatchObject({
      status: 'DRAFT',
      isActive: false,
      body: 'Open 10–4',
      startsAt: '2026-09-08T00:00:00.000Z',
      expiresAt: '2026-09-15T00:00:00.000Z',
      authorityVerified: false,
    })
  })
  it('normalizes offset dates for the native update receipt comparison', () => {
    expect(
      reviewedMediaTemporalOperationalDraft(
        input([
          {
            ...claim(),
            effectiveFrom: '2026-09-07T19:00:00.000-05:00',
            effectiveUntil: '2026-09-14T19:00:00.000-05:00',
          },
        ]),
      ),
    ).toMatchObject({
      startsAt: '2026-09-08T00:00:00.000Z',
      expiresAt: '2026-09-15T00:00:00.000Z',
    })
  })
  it('rejects a later overlapping authoritative conflict, not just conflict at start', () => {
    expect(() =>
      reviewedMediaTemporalOperationalDraft(
        input([claim(), claim('later', 'Closed', '2026-09-10T00:00:00.000Z')]),
      ),
    ).toThrow('throughout')
  })
  it('does not let expiring corroboration mask an unsupported remainder', () => {
    expect(() =>
      reviewedMediaTemporalOperationalDraft(
        input([
          { ...claim(), authority: 'PUBLIC_SOURCE' },
          {
            ...claim('second'),
            authority: 'PUBLIC_SOURCE',
            source: { ...claim('second').source, sourceSha256: 'd'.repeat(64) },
            effectiveUntil: '2026-09-10T00:00:00.000Z',
          },
        ]),
      ),
    ).toThrow('throughout')
  })
  it('rejects missing finite bounds, expired claims and changed snapshot identity', () => {
    expect(() =>
      reviewedMediaTemporalOperationalDraft({ ...input(), expectedSnapshotHash: 'f'.repeat(64) }),
    ).toThrow('exact frozen')
    expect(() =>
      reviewedMediaTemporalOperationalDraft({ ...input(), now: '2026-09-15T00:00:00.000Z' }),
    ).toThrow('expired')
    expect(() =>
      reviewedMediaTemporalOperationalDraft(input([{ ...claim(), effectiveUntil: undefined }])),
    ).toThrow('finite')
  })
})
