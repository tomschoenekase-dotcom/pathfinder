// @vitest-environment jsdom

import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { buildOnboardingMilestoneRollup } from '@pathfinder/contracts'
import { OnboardingMilestoneMetricsPanel } from './OnboardingMilestoneMetricsPanel'

describe('OnboardingMilestoneMetricsPanel', () => {
  it('shows honest missing denominators instead of fabricated zero rates', () => {
    const from = new Date('2026-08-01T00:00:00.000Z')
    const to = new Date('2026-08-19T00:00:00.000Z')
    render(
      <OnboardingMilestoneMetricsPanel
        rollup={buildOnboardingMilestoneRollup({
          events: [],
          from,
          to,
          eventLimit: 1000,
          truncated: false,
        })}
      />,
    )
    expect(screen.getAllByText('Not observed').length).toBeGreaterThan(1)
    expect(screen.getByText(/append-only workflow events/i)).toBeTruthy()
    expect(screen.getByText('Metric definitions')).toBeTruthy()
  })
})
