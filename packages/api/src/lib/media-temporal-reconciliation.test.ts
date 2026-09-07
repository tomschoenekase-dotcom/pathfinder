import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { reconcileMediaTemporalClaims } from './media-temporal-reconciliation'

const claim = (id: string, value: string, overrides: Record<string, unknown> = {}) => ({
  claimId: id,
  targetKey: 'hours:greenhouse',
  targetItemHash: 'a'.repeat(64),
  claimType: 'STABLE_FACT',
  value,
  valueHash: createHash('sha256').update(value).digest('hex'),
  authority: 'PUBLIC_SOURCE',
  consequential: true,
  source: {
    sourceId: `source-${id}`,
    sourceSha256: 'b'.repeat(64),
    sourceVersion: `version-${id}`,
    capturedAt: '2020-01-01T00:00:00.000Z',
    observationIndex: 0,
    observationSha256: 'c'.repeat(64),
  },
  ...overrides,
})
const now = '2026-12-22T12:00:00.000Z'

describe('reconcileMediaTemporalClaims', () => {
  it('does not count duplicate copies of one source as independent corroboration', () => {
    const result = reconcileMediaTemporalClaims({
      claims: [claim('copy-a', 'Open'), claim('copy-b', 'Open')],
      now,
    })
    expect(result.comparisons[0]?.disposition).toBe('UNVERIFIED_SINGLE')
    const other = claim('other', 'Open')
    other.source.sourceSha256 = 'd'.repeat(64)
    expect(
      reconcileMediaTemporalClaims({ claims: [claim('a', 'Open'), other], now }).comparisons[0]
        ?.disposition,
    ).toBe('RECOMMENDED_CORROBORATED')
  })
  it('keeps a special-week schedule finite and stops accepting it after its end', () => {
    const temporary = claim('special', 'Holiday hours', {
      claimType: 'TEMPORARY_SCHEDULE',
      effectiveFrom: '2026-12-20T00:00:00.000Z',
      effectiveUntil: '2026-12-28T00:00:00.000Z',
    })
    expect(reconcileMediaTemporalClaims({ claims: [temporary], now }).selectedClaimIds).toEqual([
      'special',
    ])
    expect(
      reconcileMediaTemporalClaims({ claims: [temporary], now: '2026-12-29T00:00:00.000Z' }),
    ).toMatchObject({ selectedClaimIds: [], comparisons: [{ disposition: 'EXPIRED_SCHEDULE' }] })
    expect(
      reconcileMediaTemporalClaims({ claims: [temporary], now: '2026-12-19T00:00:00.000Z' }),
    ).toMatchObject({ comparisons: [{ disposition: 'FUTURE_SCHEDULE' }] })
  })
  it('uses current authorized evidence over a newer contradictory public source', () => {
    const result = reconcileMediaTemporalClaims({
      claims: [
        claim('staff', 'Open', {
          authority: 'AUTHORIZED_STAFF',
          source: {
            ...claim('x', 'x').source,
            sourceId: 'staff',
            capturedAt: '2025-01-01T00:00:00.000Z',
          },
        }),
        claim('new-public', 'Closed', {
          source: {
            ...claim('x', 'x').source,
            sourceId: 'public',
            capturedAt: '2026-12-21T00:00:00.000Z',
          },
        }),
      ],
      now,
    })
    expect(result).toMatchObject({
      selectedClaimIds: ['staff'],
      blockedTargetKeys: [],
      comparisons: [{ disposition: 'RECOMMENDED_AUTHORITY' }],
    })
  })
  it('blocks only a consequential target and remains deterministic across input order', () => {
    const greenhouse = [claim('a', 'Open'), claim('b', 'Closed')]
    const minor = [
      claim('c', 'Blue sign', { targetKey: 'sign:color', consequential: false }),
      claim('d', 'Green sign', { targetKey: 'sign:color', consequential: false }),
    ]
    const first = reconcileMediaTemporalClaims({ claims: [...greenhouse, ...minor], now })
    const second = reconcileMediaTemporalClaims({
      claims: [...minor, ...greenhouse].reverse(),
      now,
    })
    expect(first.blockedTargetKeys).toEqual(['hours:greenhouse'])
    expect(first.comparisons.find((item) => item.targetKey === 'sign:color')?.disposition).toBe(
      'DEFERRED_NON_CONSEQUENTIAL',
    )
    expect(first.reconciliationHash).toBe(second.reconciliationHash)
  })
  it('retains an old stable historical fact as active evidence without recency expiry', () => {
    const result = reconcileMediaTemporalClaims({
      claims: [
        claim('history', 'Founded in 1902', {
          targetKey: 'history:founded',
          authority: 'HISTORICAL_SOURCE',
          consequential: false,
        }),
      ],
      now,
    })
    expect(result.selectedClaimIds).toEqual(['history'])
    expect(result.comparisons[0]?.disposition).toBe('UNVERIFIED_SINGLE')
  })
  it('keeps a historical claim usable when its capture date is explicitly unknown', () => {
    const historical = claim('unknown-date', 'Opened in 1902', {
      targetKey: 'history:opened',
      authority: 'HISTORICAL_SOURCE',
      consequential: false,
    })
    const result = reconcileMediaTemporalClaims({
      claims: [{ ...historical, source: { ...historical.source, capturedAt: null } }],
      now,
    })
    expect(result).toMatchObject({
      selectedClaimIds: ['unknown-date'],
      comparisons: [{ disposition: 'UNVERIFIED_SINGLE' }],
    })
  })
  it('blocks claims that reuse a target key for different draft item identities', () => {
    const result = reconcileMediaTemporalClaims({
      claims: [claim('a', 'Open'), claim('b', 'Open', { targetItemHash: 'd'.repeat(64) })],
      now,
    })
    expect(result).toMatchObject({
      blockedTargetKeys: ['hours:greenhouse'],
      comparisons: [{ disposition: 'TARGET_INCONSISTENT' }],
    })
  })

  it('rejects a structurally valid value digest that does not match the exact value', () => {
    expect(() =>
      reconcileMediaTemporalClaims({
        claims: [claim('bad-digest', 'Open', { valueHash: 'd'.repeat(64) })],
        now,
      }),
    ).toThrow('value hash does not match')
  })

  it('retains active, future, and expired dispositions for every claim on a target', () => {
    const result = reconcileMediaTemporalClaims({
      claims: [
        claim('active', 'Regular hours'),
        claim('future', 'Winter hours', {
          claimType: 'TEMPORARY_SCHEDULE',
          effectiveFrom: '2027-01-01T00:00:00.000Z',
          effectiveUntil: '2027-02-01T00:00:00.000Z',
        }),
        claim('expired', 'Summer hours', {
          claimType: 'TEMPORARY_SCHEDULE',
          effectiveFrom: '2026-06-01T00:00:00.000Z',
          effectiveUntil: '2026-09-01T00:00:00.000Z',
        }),
      ],
      now,
    })
    expect(result.claimTemporalDispositions).toEqual([
      { claimId: 'active', disposition: 'ACTIVE' },
      { claimId: 'expired', disposition: 'EXPIRED' },
      { claimId: 'future', disposition: 'FUTURE' },
    ])
    expect(result.comparisons[0]?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceSha256: 'b'.repeat(64),
          observationIndex: 0,
          observationSha256: 'c'.repeat(64),
          value: 'Regular hours',
        }),
      ]),
    )
  })

  it.each([
    ['source SHA', { source: { ...claim('x', 'Open').source, sourceSha256: 'd'.repeat(64) } }],
    [
      'observation hash',
      { source: { ...claim('x', 'Open').source, observationSha256: 'e'.repeat(64) } },
    ],
    ['target item hash', { targetItemHash: 'f'.repeat(64) }],
  ])('binds a %s-only change into the reconciliation receipt', (_label, overrides) => {
    const original = reconcileMediaTemporalClaims({ claims: [claim('x', 'Open')], now })
    const changed = reconcileMediaTemporalClaims({ claims: [claim('x', 'Open', overrides)], now })
    expect(changed.reconciliationHash).not.toBe(original.reconciliationHash)
  })
})
