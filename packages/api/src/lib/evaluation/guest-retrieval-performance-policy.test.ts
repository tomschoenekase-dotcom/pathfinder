import { describe, expect, it } from 'vitest'

import {
  assertGuestRetrievalPerformanceBudget,
  GuestRetrievalPerformanceBudgetError,
} from './guest-retrieval-performance-policy'

describe('guest retrieval local engineering performance budget', () => {
  it('accepts a measurement comfortably within the retained local baseline headroom', () => {
    expect(() =>
      assertGuestRetrievalPerformanceBudget({
        firstReadMs: 51,
        repeatedP95Ms: 16,
        boundedHistoryMs: 1,
      }),
    ).not.toThrow()
  })

  it('reports the breached repeated-read metric and observed duration', () => {
    expect(() =>
      assertGuestRetrievalPerformanceBudget({
        firstReadMs: 10,
        repeatedP95Ms: 300,
        boundedHistoryMs: 1,
      }),
    ).toThrow(
      expect.objectContaining({
        name: GuestRetrievalPerformanceBudgetError.name,
        metric: 'repeated-p95-ms',
        observedMs: 300,
        limitMs: 250,
      }),
    )
  })
})
