/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it } from 'vitest'
import { FounderAbsenceReadiness } from './FounderAbsenceReadiness'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

afterEach(cleanup)

const data = {
  schemaVersion: 2 as const,
  generatedAt: new Date('2026-08-28T04:00:00.000Z'),
  kind: 'READINESS_SNAPSHOT' as const,
  target: {
    ordinaryOperationDays: 7 as const,
    launchGate: false as const,
    certification: 'NOT_CERTIFIED' as const,
    observationState: 'NOT_STARTED' as const,
    observedDays: 0 as const,
    explanation: 'A representative uninterrupted week has not been recorded.',
  },
  observationHistory: {
    retainedDays: 0,
    consecutiveDays: 0,
    latestObservedOn: null,
    latestCapturedAt: null,
    latestReleaseSha: null,
    stale: false,
    incompleteSamples: 0,
    immutableDailySamples: true as const,
  },
  summary: { dimensionsWithReviewCandidates: 1, visibleSignals: 2 },
  dimensions: [
    {
      key: 'FOUNDER_WAITS',
      label: 'Founder waits',
      visibleSignals: 2,
      hasMore: false,
      state: 'REVIEW_CANDIDATES' as const,
      interpretation: 'These waits need a human necessity review.',
    },
    {
      key: 'UNCONTROLLED_EFFECTS',
      label: 'Uncontrolled effects',
      visibleSignals: 0,
      hasMore: false,
      state: 'NO_VISIBLE_SIGNAL' as const,
      interpretation: 'No canonical signal is visible in this bounded snapshot.',
    },
  ],
  evidenceWindow: {
    kind: 'BOUNDED_CURRENT_STATE' as const,
    complete: true,
    hasMore: false,
    historicalContinuityVerified: false as const,
  },
  authority: {
    effect: 'READ_ONLY' as const,
    canChangePermissions: false as const,
    canResolveWork: false as const,
    canCertifyMaturity: false as const,
  },
}

describe('FounderAbsenceReadiness', () => {
  it('labels the view as preparation rather than a completed test or launch gate', () => {
    render(<FounderAbsenceReadiness data={data} />)

    expect(
      screen.getByRole('heading', { name: 'Prepare the seven-day maturity test' }),
    ).toBeTruthy()
    expect(screen.getByText('Not started')).toBeTruthy()
    expect(screen.getByText(/not a launch gate/i)).toBeTruthy()
    expect(screen.getByText('Review · 2')).toBeTruthy()
  })

  it('has no obvious accessibility violations', async () => {
    const { container } = render(<FounderAbsenceReadiness data={data} />)
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations).toEqual([])
  })

  it('shows retained-day progress without presenting it as certification', () => {
    render(
      <FounderAbsenceReadiness
        data={{
          ...data,
          target: { ...data.target, observationState: 'IN_PROGRESS', observedDays: 3 },
          observationHistory: {
            ...data.observationHistory,
            retainedDays: 4,
            consecutiveDays: 3,
            latestObservedOn: '2026-08-28',
            latestCapturedAt: new Date('2026-08-28T04:00:00.000Z'),
            latestReleaseSha: 'a'.repeat(40),
            incompleteSamples: 1,
          },
        }}
      />,
    )

    expect(screen.getByText('3 of 7 days retained')).toBeTruthy()
    expect(screen.getByText(/4 daily samples are retained; 1 is incomplete/i)).toBeTruthy()
    expect(screen.getByText(/cannot .* certify maturity/i)).toBeTruthy()
  })

  it('labels a complete streak as ready for review rather than certified', () => {
    render(
      <FounderAbsenceReadiness
        data={{
          ...data,
          target: { ...data.target, observationState: 'READY_FOR_REVIEW', observedDays: 7 },
          observationHistory: {
            ...data.observationHistory,
            retainedDays: 7,
            consecutiveDays: 7,
            latestObservedOn: '2026-08-28',
            latestCapturedAt: new Date('2026-08-28T04:00:00.000Z'),
            latestReleaseSha: 'a'.repeat(40),
          },
          evidenceWindow: { ...data.evidenceWindow, historicalContinuityVerified: true },
        }}
      />,
    )

    expect(screen.getByText('Ready for review — not certified')).toBeTruthy()
  })
})
