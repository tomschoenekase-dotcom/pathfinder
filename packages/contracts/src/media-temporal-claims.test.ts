import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MediaTemporalClaimSchema } from './media-temporal-claims'

const value = 'Open 10:00–16:00'
const base = {
  claimId: 'schedule-1',
  targetKey: 'hours:greenhouse',
  targetItemHash: 'a'.repeat(64),
  claimType: 'TEMPORARY_SCHEDULE' as const,
  value,
  valueHash: createHash('sha256').update(value).digest('hex'),
  authority: 'UNKNOWN' as const,
  consequential: true,
  effectiveFrom: '2026-12-20T00:00:00.000Z',
  effectiveUntil: '2026-12-28T00:00:00.000Z',
  source: {
    sourceId: 'poster-1',
    sourceSha256: 'b'.repeat(64),
    sourceVersion: 'upload-7',
    capturedAt: '2026-12-01T00:00:00.000Z',
    observationIndex: 0,
    observationSha256: 'c'.repeat(64),
  },
}

describe('MediaTemporalClaimSchema', () => {
  it('retains explicit unknown authority and exact source/version evidence', () => {
    expect(MediaTemporalClaimSchema.parse(base)).toEqual(base)
  })
  it.each([
    { effectiveUntil: undefined },
    { effectiveUntil: base.effectiveFrom },
    { source: { ...base.source, sourceVersion: '' } },
  ])('rejects unsafe temporal or identity input %#', (change) => {
    expect(MediaTemporalClaimSchema.safeParse({ ...base, ...change }).success).toBe(false)
  })
  it('leaves exact value digest verification to the server reconciliation boundary', () => {
    expect(MediaTemporalClaimSchema.safeParse({ ...base, valueHash: 'd'.repeat(64) }).success).toBe(
      true,
    )
  })
  it('does not expire a stable historical fact merely because it was captured long ago', () => {
    expect(
      MediaTemporalClaimSchema.safeParse({
        ...base,
        claimType: 'STABLE_FACT',
        authority: 'HISTORICAL_SOURCE',
        effectiveFrom: undefined,
        effectiveUntil: undefined,
      }).success,
    ).toBe(true)
  })
  it('preserves an explicitly unknown capture date without inventing one', () => {
    expect(
      MediaTemporalClaimSchema.parse({
        ...base,
        claimType: 'STABLE_FACT',
        authority: 'HISTORICAL_SOURCE',
        effectiveFrom: undefined,
        effectiveUntil: undefined,
        source: { ...base.source, capturedAt: null },
      }).source.capturedAt,
    ).toBeNull()
  })
})
