import { describe, expect, it } from 'vitest'
import {
  assertDashboardLocalFixturePerformanceBudget,
  assertVisitorBudget,
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
      () => assertVisitorBudget(measured(visitorWithoutNavigation), 'unthrottled'),
      'visitor-metrics-incomplete',
    )
    expectBudgetFailure(
      () => assertDashboardLocalFixturePerformanceBudget(measured(dashboardWithoutNavigation)),
      'dashboard-metrics-incomplete',
    )
    expectBudgetFailure(
      () => assertVisitorBudget([visitorSample, visitorSample], 'unthrottled'),
      'visitor-metrics-incomplete',
    )
    expectBudgetFailure(
      () => assertDashboardLocalFixturePerformanceBudget([dashboardSample, dashboardSample]),
      'dashboard-metrics-incomplete',
    )
  })

  it('accepts the recorded local-fixture-shaped samples', () => {
    expect(() => assertVisitorBudget(measured(visitorSample), 'unthrottled')).not.toThrow()
    expect(() =>
      assertDashboardLocalFixturePerformanceBudget(measured(dashboardSample)),
    ).not.toThrow()
  })

  it('applies readiness ceilings only to their named network profile', () => {
    const observedWeak4g = measured({ ...visitorSample, interactionReadyMs: 26_038 })
    expect(() => assertVisitorBudget(observedWeak4g, 'weak-4g')).not.toThrow()
    expectBudgetFailure(
      () => assertVisitorBudget(observedWeak4g, 'unthrottled'),
      'visitor-interaction-ready-budget-exceeded',
    )
    for (const profile of ['unthrottled', 'weak-4g'] as const)
      expectBudgetFailure(
        () =>
          assertVisitorBudget(
            measured({
              ...visitorSample,
              interactionReadyMs:
                LOCAL_FIXTURE_PERFORMANCE_BUDGETS.visitor.interactionReadyP95Ms[profile] + 1,
            }),
            profile,
          ),
        'visitor-interaction-ready-budget-exceeded',
      )
    expectBudgetFailure(
      () => assertVisitorBudget(measured(visitorSample), 'unknown-profile'),
      'visitor-network-profile-unknown',
    )
    for (const inheritedKey of ['toString', 'constructor', '__proto__'])
      expectBudgetFailure(
        () => assertVisitorBudget(measured(visitorSample), inheritedKey),
        'visitor-network-profile-unknown',
      )
  })

  it('fails visitor latency, asset, and long-task regressions', () => {
    expectBudgetFailure(
      () =>
        assertVisitorBudget(
          measured({
            ...visitorSample,
            interactionReadyMs:
              LOCAL_FIXTURE_PERFORMANCE_BUDGETS.visitor.interactionReadyP95Ms.unthrottled + 1,
          }),
          'unthrottled',
        ),
      'visitor-interaction-ready-budget-exceeded',
    )
    expectBudgetFailure(
      () =>
        assertVisitorBudget(
          measured({
            ...visitorSample,
            allResources: {
              ...visitorSample.allResources,
              transferBytes: LOCAL_FIXTURE_PERFORMANCE_BUDGETS.visitor.resourceTransferBytes + 1,
            },
          }),
          'unthrottled',
        ),
      'visitor-resource-transfer-budget-exceeded',
    )
    expectBudgetFailure(
      () =>
        assertVisitorBudget(
          measured({
            ...visitorSample,
            images: {
              ...visitorSample.images,
              transferBytes: LOCAL_FIXTURE_PERFORMANCE_BUDGETS.visitor.imageTransferBytes + 1,
            },
          }),
          'unthrottled',
        ),
      'visitor-image-transfer-budget-exceeded',
    )
    expectBudgetFailure(
      () =>
        assertVisitorBudget(
          measured({
            ...visitorSample,
            longTasks: {
              ...visitorSample.longTasks,
              longestMs: LOCAL_FIXTURE_PERFORMANCE_BUDGETS.visitor.longestTaskMs + 1,
            },
          }),
          'unthrottled',
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
      () => assertVisitorBudget(measured(missingVisitorMetric), 'unthrottled'),
      'visitor-metrics-incomplete',
    )
    expectBudgetFailure(
      () => assertVisitorBudget(measured(zeroResources), 'unthrottled'),
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
