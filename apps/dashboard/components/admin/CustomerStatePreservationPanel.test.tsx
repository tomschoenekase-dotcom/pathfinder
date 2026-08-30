/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

import { buildCustomerStatePreservationContext } from '@pathfinder/contracts/customer-state-preservation'

import { CustomerStatePreservationPanel } from './CustomerStatePreservationPanel'

afterEach(cleanup)

const context = buildCustomerStatePreservationContext({
  tenantId: 'tenant-1',
  tenantStatus: 'ACTIVE',
  billingStatus: 'ENDED',
  evidenceBounded: false,
  now: new Date('2026-08-23T12:00:00.000Z'),
  venues: [
    {
      id: 'venue-1',
      name: 'Harbor Museum',
      isActive: false,
      placeRecordCount: 8,
      knowledgeRecordCount: 3,
      packageRecordCount: 2,
      manifestRecordCount: 1,
      hasBotConfigurationRecord: true,
      latestPlan: {
        id: 'plan-1',
        status: 'COMPLETED',
        updatedAt: new Date('2026-08-22T00:00:00.000Z'),
        revocationEvidenceCount: 2,
        completedRevocationCount: 1,
        exportArtifactCount: 4,
      },
    },
  ],
})

describe('CustomerStatePreservationPanel', () => {
  it('shows exact preserved material and unresolved policy without an action control', () => {
    render(<CustomerStatePreservationPanel context={context} />)
    expect(screen.getByRole('heading', { name: 'Preserved customer state' })).toBeTruthy()
    expect(screen.getByText('Restoration review')).toBeTruthy()
    expect(screen.getByText('8')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getAllByText('1').length).toBeGreaterThan(0)
    expect(
      screen.getByText(/No automatic reactivation or customer contact is authorized/u),
    ).toBeTruthy()
    expect(
      screen.getByText(/Retention, pause fees, and reactivation fees remain unresolved/u),
    ).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('has no automated accessibility violations', async () => {
    const { container } = render(<CustomerStatePreservationPanel context={context} />)
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })
})
