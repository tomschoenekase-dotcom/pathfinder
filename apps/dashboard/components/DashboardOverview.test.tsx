/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveClientPortalLifecycle } from '@pathfinder/contracts/client-portal-lifecycle'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('@clerk/nextjs', () => ({
  useOrganization: () => ({ organization: { name: 'Riverside Museum' } }),
}))
import { DashboardOverview } from './DashboardOverview'

const lifecycle = (state: 'LIVE' | 'PROCESSING' | 'SETUP_REQUESTED' = 'LIVE') => {
  const base = {
    isActive: false,
    publicContentCount: 0,
    wasLive: false,
    collectingSourceCount: 0,
    processingSourceCount: 0,
    reviewSourceCount: 0,
    intakeProposalCount: 0,
    packageCounts: { draft: 0, approved: 0, applied: 0, reverted: 0 },
    hasActiveOffboarding: false,
  }
  if (state === 'LIVE')
    return resolveClientPortalLifecycle({ ...base, isActive: true, publicContentCount: 1 })
  if (state === 'PROCESSING')
    return resolveClientPortalLifecycle({ ...base, processingSourceCount: 1 })
  return resolveClientPortalLifecycle(base)
}

const lifecycleFrom = (overrides: Partial<Parameters<typeof resolveClientPortalLifecycle>[0]>) =>
  resolveClientPortalLifecycle({
    isActive: false,
    publicContentCount: 0,
    wasLive: false,
    collectingSourceCount: 0,
    processingSourceCount: 0,
    reviewSourceCount: 0,
    intakeProposalCount: 0,
    packageCounts: { draft: 0, approved: 0, applied: 0, reverted: 0 },
    hasActiveOffboarding: false,
    ...overrides,
  })

describe('DashboardOverview client portal', () => {
  afterEach(cleanup)

  it('centers live status and primary client actions without analytics or venue hierarchy', () => {
    render(
      <DashboardOverview
        venue={{ id: 'riverside', name: 'Riverside', lifecycle: lifecycle() }}
        venues={[{ id: 'riverside', name: 'Riverside' }]}
        activeUpdates={1}
        chatUrl="https://guest.example/riverside"
      />,
    )
    expect(screen.getByText('Live')).toBeTruthy()
    expect(
      screen
        .getAllByRole('link', { name: /Open visitor experience/ })
        .every((link) => link.getAttribute('href') === 'https://guest.example/riverside'),
    ).toBe(true)
    expect(screen.getByText('1 visitor update live')).toBeTruthy()
    expect(screen.getByText('PathFinder tone')).toBeTruthy()
    expect(screen.getByText('PathFinder Support')).toBeTruthy()
    expect(screen.queryByText(/analytics/i)).toBeNull()
    expect(screen.queryByText(/sessions/i)).toBeNull()
    expect(screen.queryByText(/1 venue/i)).toBeNull()
  })

  it('withholds stale preview and distinguishes a ready public visitor link', () => {
    const previewLifecycle = lifecycleFrom({
      packageCounts: { draft: 0, approved: 1, applied: 0, reverted: 0 },
    })
    const { rerender } = render(
      <DashboardOverview
        venue={{
          id: 'riverside',
          name: 'Riverside',
          lifecycle: previewLifecycle,
          clientPreview: { state: 'SUPERSEDED', id: null },
        }}
        venues={[{ id: 'riverside', name: 'Riverside' }]}
        activeUpdates={0}
        chatUrl="https://guest.example/riverside"
      />,
    )
    expect(screen.getByText(/updated exact preview is being prepared/i)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /open preview|visitor experience/i })).toBeNull()

    rerender(
      <DashboardOverview
        venue={{
          id: 'riverside',
          name: 'Riverside',
          lifecycle: lifecycleFrom({
            publicContentCount: 1,
            packageCounts: { draft: 0, approved: 0, applied: 1, reverted: 0 },
          }),
        }}
        venues={[{ id: 'riverside', name: 'Riverside' }]}
        activeUpdates={0}
        chatUrl="https://guest.example/riverside"
      />,
    )
    expect(
      screen
        .getAllByRole('link', { name: /Open visitor experience/ })
        .every((link) => link.getAttribute('href') === 'https://guest.example/riverside'),
    ).toBe(true)
  })

  it('never falls back to public guest content when client preview is unavailable', () => {
    render(
      <DashboardOverview
        venue={{
          id: 'riverside',
          name: 'Riverside',
          lifecycle: lifecycleFrom({
            packageCounts: { draft: 0, approved: 1, applied: 0, reverted: 0 },
          }),
          clientPreview: { state: 'UNAVAILABLE', id: null },
        }}
        venues={[{ id: 'riverside', name: 'Riverside' }]}
        activeUpdates={0}
        chatUrl="https://guest.example/riverside"
      />,
    )
    expect(screen.getByText(/preview is temporarily unavailable/i)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /open preview|visitor experience/i })).toBeNull()
  })

  it('explains the onboarding state without making clients configure the system', () => {
    render(
      <DashboardOverview
        venue={{ id: 'riverside', name: 'Riverside', lifecycle: lifecycle('PROCESSING') }}
        venues={[{ id: 'riverside', name: 'Riverside' }]}
        activeUpdates={0}
      />,
    )
    expect(screen.getByText('In progress')).toBeTruthy()
    expect(screen.getByText('We’re preparing the information you shared.')).toBeTruthy()
    expect(screen.getByText(/nothing you need to configure/i)).toBeTruthy()
    expect(screen.queryByText('The essentials')).toBeNull()
  })

  it('reveals venue switching only when the client has multiple venues', () => {
    render(
      <DashboardOverview
        venue={{ id: 'riverside', name: 'Riverside', lifecycle: lifecycle() }}
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

  it('shows the one required setup action without internal implementation language', () => {
    render(
      <DashboardOverview
        venue={{ id: 'venue / one', name: 'Riverside', lifecycle: lifecycle('SETUP_REQUESTED') }}
        venues={[{ id: 'venue / one', name: 'Riverside' }]}
        activeUpdates={0}
      />,
    )
    expect(screen.getByRole('link', { name: 'Continue setup' }).getAttribute('href')).toBe(
      '/venues/venue%20%2F%20one/intake',
    )
    expect(document.body.textContent).not.toMatch(/package|worker|queue|analytics|agent/iu)
    expect(screen.queryByRole('navigation', { name: 'Choose venue' })).toBeNull()
  })

  it('shows exactly one client task for preview and withholds live management tools', () => {
    render(
      <DashboardOverview
        venue={{
          id: 'riverside',
          name: 'Riverside',
          lifecycle: lifecycleFrom({
            packageCounts: { draft: 0, approved: 1, applied: 0, reverted: 0 },
          }),
          clientPreview: { state: 'AVAILABLE', id: 'package-approved' },
        }}
        venues={[{ id: 'riverside', name: 'Riverside' }]}
        activeUpdates={3}
        chatUrl="https://guest.example/riverside"
      />,
    )

    expect(screen.getAllByText('Your next step')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Open preview' }).getAttribute('href')).toBe(
      '/venues/riverside/preview/package-approved',
    )
    expect(screen.queryByRole('link', { name: 'Open visitor experience' })).toBeNull()
    expect(screen.queryByText('The essentials')).toBeNull()
    expect(screen.queryByText(/visitor updates live/i)).toBeNull()
    expect(document.body.textContent).not.toMatch(/analytics|sessions|conversion/iu)
  })

  it('shows one support task for a paused venue and never exposes the visitor link', () => {
    render(
      <DashboardOverview
        venue={{
          id: 'riverside',
          name: 'Riverside',
          lifecycle: lifecycleFrom({ wasLive: true }),
        }}
        venues={[{ id: 'riverside', name: 'Riverside' }]}
        activeUpdates={0}
        chatUrl="https://guest.example/riverside"
        impersonatedTenantName="Owner-authorized preview"
      />,
    )

    expect(screen.getByRole('heading', { name: 'Owner-authorized preview' })).toBeTruthy()
    expect(screen.getAllByText('Your next step')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Contact Support' }).getAttribute('href')).toBe(
      '/support',
    )
    expect(screen.queryByRole('link', { name: /Open PathFinder|Open preview/ })).toBeNull()
    expect(document.body.textContent).not.toMatch(/analytics|sessions|conversion/iu)
  })
})
