import { describe, expect, it } from 'vitest'

import { normalizeVenuePriceBreakdown } from './service'

describe('venue price breakdown', () => {
  it('preserves an exact multi-venue breakdown in covered-venue order', () => {
    expect(
      normalizeVenuePriceBreakdown({
        venueIds: ['venue-b', 'venue-a'],
        totalAmountMinor: 5_000n,
        venueAmounts: [
          { venueId: 'venue-a', amountMinor: 2_000n },
          { venueId: 'venue-b', amountMinor: 3_000n },
        ],
      }),
    ).toEqual([
      { venueId: 'venue-b', amountMinor: 3_000n },
      { venueId: 'venue-a', amountMinor: 2_000n },
    ])
  })

  it('derives a complete single-venue component without duplicating price input', () => {
    expect(
      normalizeVenuePriceBreakdown({
        venueIds: ['venue-a'],
        totalAmountMinor: 2_500n,
      }),
    ).toEqual([{ venueId: 'venue-a', amountMinor: 2_500n }])
  })

  it.each([
    {
      label: 'missing multi-venue components',
      venueIds: ['venue-a', 'venue-b'],
      totalAmountMinor: 5_000n,
      venueAmounts: undefined,
    },
    {
      label: 'partial component coverage',
      venueIds: ['venue-a', 'venue-b'],
      totalAmountMinor: 5_000n,
      venueAmounts: [{ venueId: 'venue-a', amountMinor: 5_000n }],
    },
    {
      label: 'duplicate venue component',
      venueIds: ['venue-a', 'venue-b'],
      totalAmountMinor: 5_000n,
      venueAmounts: [
        { venueId: 'venue-a', amountMinor: 2_500n },
        { venueId: 'venue-a', amountMinor: 2_500n },
      ],
    },
    {
      label: 'non-summing components',
      venueIds: ['venue-a', 'venue-b'],
      totalAmountMinor: 5_000n,
      venueAmounts: [
        { venueId: 'venue-a', amountMinor: 2_000n },
        { venueId: 'venue-b', amountMinor: 2_000n },
      ],
    },
  ])('rejects $label', ({ venueIds, totalAmountMinor, venueAmounts }) => {
    expect(() =>
      normalizeVenuePriceBreakdown({
        venueIds,
        totalAmountMinor,
        ...(venueAmounts ? { venueAmounts } : {}),
      }),
    ).toThrow()
  })

  it('allows a legacy or non-billed arrangement to omit both total and components', () => {
    expect(
      normalizeVenuePriceBreakdown({
        venueIds: ['venue-a', 'venue-b'],
        totalAmountMinor: null,
      }),
    ).toEqual([])
  })
})
