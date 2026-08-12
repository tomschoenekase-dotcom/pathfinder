/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('./NativeVenueDeploymentLifecycleControls', () => ({
  NativeVenueDeploymentLifecycleControls: () => <p>Native lifecycle controls</p>,
}))
vi.mock('./NativeReleaseEvaluationPanel', () => ({
  NativeReleaseEvaluationPanel: () => <p>Advisory evaluation evidence</p>,
}))

import { NativeVenueDeploymentDetail } from './NativeVenueDeploymentDetail'

const release = {
  id: 'release-1',
  profile: 'NATIVE_CORE_V1',
  status: 'DRAFT',
  version: new Date(0),
  updatedAt: new Date(0),
  commandCount: 0,
  materializable: true,
  unsupported: false,
  coverage: [
    'VENUE_CONFIGURATION',
    'PLACES',
    'KNOWLEDGE',
    'GENERALIZED_MODULES',
    'ITEMS',
    'ASSETS',
    'CAPABILITY_MODEL_REFERENCES',
  ].map((section, index) => ({
    section,
    disposition: index < 4 ? 'SUPPORTED' : 'SUPPORTED_EMPTY_ONLY',
  })),
  impactSummary: [
    { kind: 'PLACE', count: 2 },
    { kind: 'VENUE', count: 1 },
  ],
  effectSummary: { expected: 3, recorded: 0, byKind: [] },
} as never

describe('NativeVenueDeploymentDetail', () => {
  afterEach(cleanup)

  it('renders all seven coverage sections and bounded impact totals', () => {
    render(<NativeVenueDeploymentDetail tenantId="tenant-1" venueId="venue-1" release={release} />)
    expect(screen.getAllByText(/Supported/)).toHaveLength(7)
    expect(screen.getByText('3 expected effects · 0 recorded effects')).toBeTruthy()
    expect(screen.getByText('Place').parentElement?.textContent).toContain('2')
    expect(screen.getByText('Advisory evaluation evidence')).toBeTruthy()
    expect(screen.getByText('Native lifecycle controls')).toBeTruthy()
  })

  it('has no automated accessibility violations', async () => {
    const { container } = render(
      <NativeVenueDeploymentDetail tenantId="tenant-1" venueId="venue-1" release={release} />,
    )
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })
})
