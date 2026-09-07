import { describe, expect, it } from 'vitest'
import {
  assertDashboardLocalFixturePerformanceBudget,
  assertVisitorLocalFixturePerformanceBudget,
  LOCAL_FIXTURE_PERFORMANCE_BUDGETS,
  type DashboardPerformanceSample,
  type VisitorPerformanceSample,
} from './local-fixture-performance-budgets'

const visitorSample: VisitorPerformanceSample = {
  interactionReadyMs: 1_200,
  navigation: {
    responseStartMs: 100,
    domContentLoadedMs: 200,
    loadEventMs: 400,
    documentTransferBytes: 2_000,
    documentEncodedBodyBytes: 1_500,
  },
  allResources: { requests: 10, transferBytes: 5_000_000 },
  scripts: { requests: 6, transferBytes: 4_900_000 },
  styles: { requests: 2, transferBytes: 50_000 },
  images: { requests: 1, transferBytes: 100_000 },
  longTasks: { count: 1, totalDurationMs: 280, longestMs: 280 },
}

const dashboardSample: DashboardPerformanceSample = {
  coldReadyMs: 6_900,
  switchMs: { venues: 90, analytics: 65, transcript: 65, directory: 84 },
  navigation: {
    responseStartMs: 5_600,
    domContentLoadedMs: 5_700,
    loadEventMs: 6_500,
    transferBytes: 7_500,
  },
  resources: { requests: 8, transferBytes: 3_600_000 },
  scripts: { requests: 5, transferBytes: 3_500_000 },
  longTasks: { count: 1, totalDurationMs: 257, longestMs: 257 },
}

function expectBudgetFailure(action: () => void, code: string) {
  expect(action).toThrow(
    expect.objectContaining({ name: 'LocalFixturePerformanceBudgetError', code }),
  )
}

function measured<T>(sample: T): T[] {
  return [sample, sample, sample]
}

describe('local fixture performance budgets', () => {
  it('returns typed incomplete errors for absent navigation and insufficient samples', () => {
    const visitorWithoutNavigation = {
      ...visitorSample,
      navigation: undefined,
    } as unknown as VisitorPerformanceSample
    const dashboardWithoutNavigation = {
      ...dashboardSample,
      navigation: undefined,
    } as unknown as DashboardPerformanceSample
    expectBudgetFailure(
      () => assertVisitorLocalFixturePerformanceBudget(measured(visitorWithoutNavigation)),
      'visitor-metrics-incomplete',
    )
    expectBudgetFailure(
      () => assertDashboardLocalFixturePerformanceBudget(measured(dashboardWithoutNavigation)),
      'dashboard-metrics-incomplete',
    )
    expectBudgetFailure(
      () => assertVisitorLocalFixturePerformanceBudget([visitorSample, visitorSample]),
      'visitor-metrics-incomplete',
    )
    expectBudgetFailure(
      () => assertDashboardLocalFixturePerformanceBudget([dashboardSample, dashboardSample]),
      'dashboard-metrics-incomplete',
    )
  })

  it('accepts the recorded local-fixture-shaped samples', () => {
    expect(() => assertVisitorLocalFixturePerformanceBudget(measured(visitorSample))).not.toThrow()
    expect(() =>
      assertDashboardLocalFixturePerformanceBudget(measured(dashboardSample)),
    ).not.toThrow()
  })

  it('fails visitor latency, asset, and long-task regressions', () => {
    expectBudgetFailure(
      () =>
        assertVisitorLocalFixturePerformanceBudget(
          measured({
            ...visitorSample,
            interactionReadyMs: LOCAL_FIXTURE_PERFORMANCE_BUDGETS.visitor.interactionReadyP95Ms + 1,
          }),
        ),
      'visitor-interaction-ready-budget-exceeded',
    )
    expectBudgetFailure(
      () =>
        assertVisitorLocalFixturePerformanceBudget(
          measured({
            ...visitorSample,
            allResources: {
              ...visitorSample.allResources,
              transferBytes: LOCAL_FIXTURE_PERFORMANCE_BUDGETS.visitor.resourceTransferBytes + 1,
            },
          }),
        ),
      'visitor-resource-transfer-budget-exceeded',
    )
    expectBudgetFailure(
      () =>
        assertVisitorLocalFixturePerformanceBudget(
          measured({
            ...visitorSample,
            images: {
              ...visitorSample.images,
              transferBytes: LOCAL_FIXTURE_PERFORMANCE_BUDGETS.visitor.imageTransferBytes + 1,
            },
          }),
        ),
      'visitor-image-transfer-budget-exceeded',
    )
    expectBudgetFailure(
      () =>
        assertVisitorLocalFixturePerformanceBudget(
          measured({
            ...visitorSample,
            longTasks: {
              ...visitorSample.longTasks,
              longestMs: LOCAL_FIXTURE_PERFORMANCE_BUDGETS.visitor.longestTaskMs + 1,
            },
          }),
        ),
      'visitor-long-task-budget-exceeded',
    )
  })

  it('fails dashboard latency, asset, and long-task regressions', () => {
    expectBudgetFailure(
      () =>
        assertDashboardLocalFixturePerformanceBudget(
          measured({
            ...dashboardSample,
            coldReadyMs: LOCAL_FIXTURE_PERFORMANCE_BUDGETS.dashboard.coldReadyP95Ms + 1,
          }),
        ),
      'dashboard-cold-ready-budget-exceeded',
    )
    expectBudgetFailure(
      () =>
        assertDashboardLocalFixturePerformanceBudget(
          measured({
            ...dashboardSample,
            switchMs: {
              ...dashboardSample.switchMs,
              venues: LOCAL_FIXTURE_PERFORMANCE_BUDGETS.dashboard.switchP95Ms + 1,
            },
          }),
        ),
      'dashboard-venues-switch-budget-exceeded',
    )
    expectBudgetFailure(
      () =>
        assertDashboardLocalFixturePerformanceBudget(
          measured({
            ...dashboardSample,
            resources: {
              ...dashboardSample.resources,
              transferBytes: LOCAL_FIXTURE_PERFORMANCE_BUDGETS.dashboard.resourceTransferBytes + 1,
            },
          }),
        ),
      'dashboard-resource-transfer-budget-exceeded',
    )
    expectBudgetFailure(
      () =>
        assertDashboardLocalFixturePerformanceBudget(
          measured({
            ...dashboardSample,
            longTasks: {
              ...dashboardSample.longTasks,
              longestMs: LOCAL_FIXTURE_PERFORMANCE_BUDGETS.dashboard.longestTaskMs + 1,
            },
          }),
        ),
      'dashboard-long-task-budget-exceeded',
    )
  })

  it('fails closed for missing, partial, zero, and non-finite measurements', () => {
    const missingVisitorMetric = { ...visitorSample, navigation: null } as VisitorPerformanceSample
    const zeroResources = { ...visitorSample, allResources: { requests: 0, transferBytes: 0 } }
    const incompleteSwitches = {
      ...dashboardSample,
      switchMs: { venues: 90, analytics: 65, transcript: 65 },
    }
    const nonFiniteLongTask = {
      ...dashboardSample,
      longTasks: { ...dashboardSample.longTasks, longestMs: Number.NaN },
    }
    expectBudgetFailure(
      () => assertVisitorLocalFixturePerformanceBudget(measured(missingVisitorMetric)),
      'visitor-metrics-incomplete',
    )
    expectBudgetFailure(
      () => assertVisitorLocalFixturePerformanceBudget(measured(zeroResources)),
      'visitor-metrics-incomplete',
    )
    expectBudgetFailure(
      () => assertDashboardLocalFixturePerformanceBudget(measured(incompleteSwitches)),
      'dashboard-metrics-incomplete',
    )
    expectBudgetFailure(
      () => assertDashboardLocalFixturePerformanceBudget(measured(nonFiniteLongTask)),
      'dashboard-metrics-incomplete',
    )
    expectBudgetFailure(
      () =>
        assertDashboardLocalFixturePerformanceBudget(
          measured({
            ...dashboardSample,
            resources: { requests: 1, transferBytes: Number.POSITIVE_INFINITY },
          }),
        ),
      'dashboard-metrics-incomplete',
    )
  })
})
