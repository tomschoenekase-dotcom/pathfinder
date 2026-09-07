/**
 * Versioned gates for deterministic local fixtures. These figures are deliberately
 * not service SLOs: they do not exercise a provider, database, or real retrieval.
 *
 * Calibration source: local-fixture-baseline.v1.json (2026-09-07, local Next
 * development server, Chromium, three samples). The thresholds leave room for
 * local variance while making material route, asset, and main-thread regressions
 * executable failures.
 */
export const LOCAL_FIXTURE_PERFORMANCE_BUDGETS = {
  version: 1,
  calibrationArtifact: 'tests/performance/local-fixture-baseline.v1.json',
  visitor: {
    interactionReadyP95Ms: 2_500,
    resourceTransferBytes: 6_000_000,
    // The baseline loads no external images. This is an explicit future-asset
    // allowance, not an image weight derived from an observed image baseline.
    imageTransferBytes: 750_000,
    longestTaskMs: 600,
  },
  dashboard: {
    coldReadyP95Ms: 10_000,
    switchP95Ms: 400,
    resourceTransferBytes: 5_000_000,
    longestTaskMs: 600,
  },
} as const

type ResourceAggregate = { requests: number; transferBytes: number }
type LongTasks = { count: number; totalDurationMs: number; longestMs: number }
const dashboardSwitchViews = ['venues', 'analytics', 'transcript', 'directory'] as const

export type VisitorPerformanceSample = {
  interactionReadyMs: number
  navigation: {
    responseStartMs: number
    domContentLoadedMs: number
    loadEventMs: number
    documentTransferBytes: number
    documentEncodedBodyBytes: number
  } | null
  allResources: ResourceAggregate
  scripts: ResourceAggregate
  styles: ResourceAggregate
  images: ResourceAggregate
  longTasks: LongTasks
}

export type DashboardPerformanceSample = {
  coldReadyMs: number
  switchMs: Record<string, number>
  navigation: {
    responseStartMs: number
    domContentLoadedMs: number
    loadEventMs: number
    transferBytes: number
  } | null
  resources: ResourceAggregate
  scripts: ResourceAggregate
  longTasks: LongTasks
}

export class LocalFixturePerformanceBudgetError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'LocalFixturePerformanceBudgetError'
  }
}

function fail(code: string): never {
  throw new LocalFixturePerformanceBudgetError(code)
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function p95(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0
}

function hasResourceAggregate(value: unknown): value is ResourceAggregate {
  return (
    typeof value === 'object' &&
    value !== null &&
    finiteNonNegative((value as ResourceAggregate).requests) &&
    finiteNonNegative((value as ResourceAggregate).transferBytes)
  )
}

function hasObservedResourceAggregate(value: unknown): value is ResourceAggregate {
  return hasResourceAggregate(value) && value.requests > 0 && value.transferBytes > 0
}

function hasLongTasks(value: unknown): value is LongTasks {
  return (
    typeof value === 'object' &&
    value !== null &&
    finiteNonNegative((value as LongTasks).count) &&
    finiteNonNegative((value as LongTasks).totalDurationMs) &&
    finiteNonNegative((value as LongTasks).longestMs)
  )
}

function hasVisitorMetrics(sample: unknown): sample is VisitorPerformanceSample {
  if (typeof sample !== 'object' || sample === null) return false
  const visitorSample = sample as VisitorPerformanceSample
  const navigation = visitorSample.navigation
  return (
    finiteNonNegative(visitorSample.interactionReadyMs) &&
    hasObservedResourceAggregate(visitorSample.allResources) &&
    hasResourceAggregate(visitorSample.scripts) &&
    hasResourceAggregate(visitorSample.styles) &&
    hasResourceAggregate(visitorSample.images) &&
    hasLongTasks(visitorSample.longTasks) &&
    typeof navigation === 'object' &&
    navigation !== null &&
    finiteNonNegative(navigation.responseStartMs) &&
    finiteNonNegative(navigation.domContentLoadedMs) &&
    finiteNonNegative(navigation.loadEventMs) &&
    finiteNonNegative(navigation.documentTransferBytes) &&
    finiteNonNegative(navigation.documentEncodedBodyBytes)
  )
}

function hasDashboardMetrics(sample: unknown): sample is DashboardPerformanceSample {
  if (typeof sample !== 'object' || sample === null) return false
  const dashboardSample = sample as DashboardPerformanceSample
  const navigation = dashboardSample.navigation
  return (
    finiteNonNegative(dashboardSample.coldReadyMs) &&
    typeof dashboardSample.switchMs === 'object' &&
    dashboardSample.switchMs !== null &&
    dashboardSwitchViews.every((view) => finiteNonNegative(dashboardSample.switchMs[view])) &&
    Object.keys(dashboardSample.switchMs).length === dashboardSwitchViews.length &&
    hasObservedResourceAggregate(dashboardSample.resources) &&
    hasResourceAggregate(dashboardSample.scripts) &&
    hasLongTasks(dashboardSample.longTasks) &&
    typeof navigation === 'object' &&
    navigation !== null &&
    finiteNonNegative(navigation.responseStartMs) &&
    finiteNonNegative(navigation.domContentLoadedMs) &&
    finiteNonNegative(navigation.loadEventMs) &&
    finiteNonNegative(navigation.transferBytes)
  )
}

export function assertVisitorLocalFixturePerformanceBudget(
  samples: VisitorPerformanceSample[],
): void {
  if (samples.length < 3 || !samples.every(hasVisitorMetrics)) fail('visitor-metrics-incomplete')

  const budget = LOCAL_FIXTURE_PERFORMANCE_BUDGETS.visitor
  if (p95(samples.map((sample) => sample.interactionReadyMs)) > budget.interactionReadyP95Ms) {
    fail('visitor-interaction-ready-budget-exceeded')
  }
  if (samples.some((sample) => sample.allResources.transferBytes > budget.resourceTransferBytes)) {
    fail('visitor-resource-transfer-budget-exceeded')
  }
  if (samples.some((sample) => sample.images.transferBytes > budget.imageTransferBytes)) {
    fail('visitor-image-transfer-budget-exceeded')
  }
  if (samples.some((sample) => sample.longTasks.longestMs > budget.longestTaskMs)) {
    fail('visitor-long-task-budget-exceeded')
  }
}

export function assertDashboardLocalFixturePerformanceBudget(
  samples: DashboardPerformanceSample[],
): void {
  if (samples.length < 3 || !samples.every(hasDashboardMetrics))
    fail('dashboard-metrics-incomplete')

  const budget = LOCAL_FIXTURE_PERFORMANCE_BUDGETS.dashboard
  if (p95(samples.map((sample) => sample.coldReadyMs)) > budget.coldReadyP95Ms) {
    fail('dashboard-cold-ready-budget-exceeded')
  }
  for (const view of dashboardSwitchViews) {
    if (p95(samples.map((sample) => sample.switchMs[view] ?? Number.NaN)) > budget.switchP95Ms) {
      fail(`dashboard-${view}-switch-budget-exceeded`)
    }
  }
  if (samples.some((sample) => sample.resources.transferBytes > budget.resourceTransferBytes)) {
    fail('dashboard-resource-transfer-budget-exceeded')
  }
  if (samples.some((sample) => sample.longTasks.longestMs > budget.longestTaskMs)) {
    fail('dashboard-long-task-budget-exceeded')
  }
}
