import { describe, expect, it } from 'vitest'

import type { SupportCompletionPackageFulfillment } from './agent-approval-policy'
import { deriveSupportCompletionOutcome } from './support-completion-outcome'

function fulfillment(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 6,
    linkedPackageCount: 0,
    packages: [],
    digest: 'a'.repeat(64),
    guestObservability: { effects: [] },
    contentFulfillment: { receipts: [] },
    temporalFulfillment: { receipts: [] },
    noChangeFulfillment: { receipts: [] },
    ...overrides,
  } as unknown as SupportCompletionPackageFulfillment
}

describe('deriveSupportCompletionOutcome', () => {
  it.each([
    ['RESOLVED', fulfillment()],
    ['UPDATED', fulfillment({ guestObservability: { effects: [{}] } })],
    ['UPDATED', fulfillment({ contentFulfillment: { receipts: [{ state: 'CURRENT' }] } })],
    ['UPDATED', fulfillment({ temporalFulfillment: { receipts: [{}] } })],
    ['NO_CHANGE', fulfillment({ noChangeFulfillment: { receipts: [{}] } })],
    [
      'MIXED',
      fulfillment({
        guestObservability: { effects: [{}] },
        noChangeFulfillment: { receipts: [{}] },
      }),
    ],
  ])('returns %s for exact fulfillment evidence', (outcome, value) => {
    expect(deriveSupportCompletionOutcome(value)).toBe(outcome)
  })

  it('does not call historical-only chained content an update', () => {
    expect(
      deriveSupportCompletionOutcome(
        fulfillment({ contentFulfillment: { receipts: [{ state: 'SUPERSEDED' }] } }),
      ),
    ).toBe('RESOLVED')
  })

  it('does not call an applied package with no guest effects an update', () => {
    expect(
      deriveSupportCompletionOutcome(fulfillment({ linkedPackageCount: 1, packages: [{}] })),
    ).toBe('RESOLVED')
  })

  it('keeps legacy V1 neutral', () => {
    expect(
      deriveSupportCompletionOutcome({
        contractVersion: 1,
        linkedPackageCount: 0,
        packages: [],
        digest: 'a'.repeat(64),
      }),
    ).toBe('RESOLVED')
  })
})
