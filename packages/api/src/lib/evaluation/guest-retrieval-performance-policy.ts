/**
 * Local disposable-fixture engineering targets, derived from the retained
 * 2026-09-08 native baseline (first read 51ms; repeated p95 16ms; bounded
 * history projection 0.7ms). These are intentionally loose regression gates,
 * not hosted-service SLOs or visitor useful-answer budgets.
 */
export const GUEST_RETRIEVAL_PERFORMANCE_BUDGET = {
  version: 'guest-retrieval-local-engineering-budget-v1',
  firstReadMaxMs: 1_000,
  repeatedP95MaxMs: 250,
  boundedHistoryMaxMs: 100,
} as const

export class GuestRetrievalPerformanceBudgetError extends Error {
  constructor(
    readonly metric: 'first-read-ms' | 'repeated-p95-ms' | 'bounded-history-ms',
    readonly observedMs: number,
    readonly limitMs: number,
  ) {
    super(
      `Guest retrieval ${metric} exceeded local engineering budget: observed ${observedMs.toFixed(1)}ms; limit ${limitMs}ms.`,
    )
    this.name = 'GuestRetrievalPerformanceBudgetError'
  }
}

function assertFiniteNonnegative(value: number, metric: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${metric} measurement.`)
}

export function assertGuestRetrievalPerformanceBudget(measurement: {
  firstReadMs: number
  repeatedP95Ms: number
  boundedHistoryMs: number
}): void {
  assertFiniteNonnegative(measurement.firstReadMs, 'first retrieval')
  assertFiniteNonnegative(measurement.repeatedP95Ms, 'repeated retrieval p95')
  assertFiniteNonnegative(measurement.boundedHistoryMs, 'bounded history')
  if (measurement.firstReadMs > GUEST_RETRIEVAL_PERFORMANCE_BUDGET.firstReadMaxMs) {
    throw new GuestRetrievalPerformanceBudgetError(
      'first-read-ms',
      measurement.firstReadMs,
      GUEST_RETRIEVAL_PERFORMANCE_BUDGET.firstReadMaxMs,
    )
  }
  if (measurement.repeatedP95Ms > GUEST_RETRIEVAL_PERFORMANCE_BUDGET.repeatedP95MaxMs) {
    throw new GuestRetrievalPerformanceBudgetError(
      'repeated-p95-ms',
      measurement.repeatedP95Ms,
      GUEST_RETRIEVAL_PERFORMANCE_BUDGET.repeatedP95MaxMs,
    )
  }
  if (measurement.boundedHistoryMs > GUEST_RETRIEVAL_PERFORMANCE_BUDGET.boundedHistoryMaxMs) {
    throw new GuestRetrievalPerformanceBudgetError(
      'bounded-history-ms',
      measurement.boundedHistoryMs,
      GUEST_RETRIEVAL_PERFORMANCE_BUDGET.boundedHistoryMaxMs,
    )
  }
}
