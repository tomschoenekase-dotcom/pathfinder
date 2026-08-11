/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('@clerk/nextjs', () => ({
  useOrganization: () => ({ organization: { name: 'Riverside Museum' } }),
}))
import { DashboardOverview } from './DashboardOverview'

describe('DashboardOverview client portal', () => {
  afterEach(cleanup)

  it('centers live status and primary client actions without analytics or venue hierarchy', () => {
    render(
      <DashboardOverview
        venue={{ id: 'riverside', name: 'Riverside', isActive: true, placeCount: 12 }}
        venues={[{ id: 'riverside', name: 'Riverside' }]}
        activeUpdates={1}
        chatUrl="https://guest.example/riverside"
      />,
    )
    expect(screen.getByText('PathFinder is live')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Open PathFinder/ }).getAttribute('href')).toBe(
      'https://guest.example/riverside',
    )
    expect(screen.getByText('1 visitor update live')).toBeTruthy()
    expect(screen.getByText('PathFinder tone')).toBeTruthy()
    expect(screen.getByText('PathFinder Support')).toBeTruthy()
    expect(screen.queryByText(/analytics/i)).toBeNull()
    expect(screen.queryByText(/sessions/i)).toBeNull()
    expect(screen.queryByText(/1 venue/i)).toBeNull()
  })

  it('explains the onboarding state without making clients configure the system', () => {
    render(
      <DashboardOverview
        venue={{ id: 'riverside', name: 'Riverside', isActive: false, placeCount: 0 }}
        venues={[{ id: 'riverside', name: 'Riverside' }]}
        activeUpdates={0}
      />,
    )
    expect(screen.getByText('Your PathFinder is being prepared')).toBeTruthy()
    expect(screen.getByText('Your information is with the PathFinder team')).toBeTruthy()
    expect(screen.getByText(/nothing technical for you to configure/i)).toBeTruthy()
  })

  it('reveals venue switching only when the client has multiple venues', () => {
    render(
      <DashboardOverview
        venue={{ id: 'riverside', name: 'Riverside', isActive: true, placeCount: 12 }}
        venues={[
          { id: 'riverside', name: 'Riverside' },
          { id: 'uptown', name: 'Uptown' },
        ]}
        activeUpdates={0}
      />,
    )
    expect(screen.getByRole('navigation', { name: 'Choose venue' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Uptown' }).getAttribute('href')).toBe('/?venue=uptown')
  })
})
