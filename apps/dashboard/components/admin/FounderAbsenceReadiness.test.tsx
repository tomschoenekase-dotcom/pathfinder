/* @vitest-environment jsdom */
import React from 'react'
import { render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { describe, expect, it } from 'vitest'
import { FounderAbsenceReadiness } from './FounderAbsenceReadiness'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const data = {
  schemaVersion: 1 as const,
  generatedAt: new Date('2026-08-28T04:00:00.000Z'),
  kind: 'READINESS_SNAPSHOT' as const,
  target: {
    ordinaryOperationDays: 7 as const,
    launchGate: false as const,
    certification: 'NOT_STARTED' as const,
    observedDays: 0 as const,
    explanation: 'A representative uninterrupted week has not been recorded.',
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
})
