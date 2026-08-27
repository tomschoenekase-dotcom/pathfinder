/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FreshnessAuditView } from './FreshnessAuditView'
;(globalThis as typeof globalThis & { React: typeof React }).React = React
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { confirmFreshnessCurrent: { mutate: vi.fn() } } }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
const empty = { items: [], nextCursor: null }

describe('FreshnessAuditView', () => {
  afterEach(cleanup)
  it('states evidence limitations and honest empty queues', () => {
    render(
      <FreshnessAuditView
        tenantId="tenant_1"
        venueId="venue_1"
        thresholdDays={60}
        horizonDays={14}
        observedAt={new Date('2026-08-11T12:00:00Z')}
        stalePlaces={empty}
        staleKnowledge={empty}
        gapPlaces={empty}
        gapKnowledge={empty}
        dateSensitive={empty}
      />,
    )
    expect(screen.getByText(/does not compare independent sources/)).toBeTruthy()
    expect(screen.getByText(/Nothing here is auto-patched or published/)).toBeTruthy()
    expect(screen.getByText(/No human-confirmed content/)).toBeTruthy()
  })
  it('distinguishes stale review, provenance gaps, and expired active updates', () => {
    const content = {
      id: 'place_1',
      entityType: 'PLACE' as const,
      label: 'North Hall',
      category: null,
      sourceType: 'DOCUMENT',
      sourceName: 'Guide',
      sourceUrl: 'https://example.test/guide',
      importedAt: null,
      humanConfirmedAt: new Date('2026-01-01'),
      lastReviewedAt: new Date('2026-01-02'),
      updatedAt: new Date('2026-01-02'),
    }
    render(
      <FreshnessAuditView
        tenantId="tenant_1"
        venueId="venue_1"
        thresholdDays={60}
        horizonDays={14}
        observedAt={new Date('2026-08-11T12:00:00Z')}
        stalePlaces={{ items: [content], nextCursor: null }}
        staleKnowledge={empty}
        gapPlaces={{
          items: [{ ...content, id: 'place_2', sourceName: null, lastReviewedAt: null }],
          nextCursor: null,
        }}
        gapKnowledge={empty}
        dateSensitive={{
          items: [
            {
              id: 'update_1',
              title: 'Closure',
              updateType: 'TEMPORARY_CLOSURE',
              severity: 'WARNING',
              priority: 'HIGH',
              startsAt: new Date('2026-08-01'),
              expiresAt: new Date('2026-08-10'),
              publishedAt: new Date('2026-08-01'),
              updatedAt: new Date('2026-08-01'),
              place: null,
              temporalState: 'EXPIRED',
              guestVisibleNow: false,
              cleanupPending: true,
            },
          ],
          nextCursor: null,
        }}
      />,
    )
    expect(screen.getByText(/Last reviewed 221 days ago/)).toBeTruthy()
    expect(screen.getByText(/Missing: source name, review date/)).toBeTruthy()
    expect(screen.getByText('Expired · guest-hidden')).toBeTruthy()
    expect(screen.getByText(/visibility window has closed safely/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Agent questions' }).getAttribute('href')).toBe(
      '/admin/clients/tenant_1/venues/venue_1/agents',
    )
    expect(screen.queryByText('https://example.test/guide')).toBeNull()
  })
})
