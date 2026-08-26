/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ClientWorkspaceShell } from './ClientWorkspaceShell'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

let pathname = '/admin/clients/client-1'

vi.mock('next/navigation', () => ({ usePathname: () => pathname }))
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))

const client = { id: 'client-1', name: 'Northstar Group', slug: 'northstar', status: 'ACTIVE' }
const venues = [
  {
    id: 'venue-1',
    name: 'Harbor Museum',
    slug: 'harbor',
    isActive: true,
    guestUrl: 'https://guide.example/harbor/chat',
  },
  { id: 'venue-2', name: 'Hill Park', slug: 'hill-park', isActive: false, guestUrl: null },
]

describe('ClientWorkspaceShell', () => {
  afterEach(cleanup)

  it('keeps the client overview at client scope without exposing venue-only controls', () => {
    pathname = '/admin/clients/client-1'
    render(
      <ClientWorkspaceShell client={client} venues={venues}>
        <p>Overview body</p>
      </ClientWorkspaceShell>,
    )

    expect(screen.getByText('Client scope')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Northstar Group' })).toBeTruthy()
    expect(screen.getByRole('link', { name: /Harbor Museum/ }).getAttribute('href')).toBe(
      '/admin/clients/client-1/venues/venue-1',
    )
    expect(screen.queryByText('Observe & improve')).toBeNull()
    expect(screen.queryByRole('link', { name: /Legacy compatibility/ })).toBeNull()
    expect(screen.queryByRole('link', { name: /Open guest preview/ })).toBeNull()
  })

  it('makes venue scope, grouped workflows, and guest preview explicit on venue routes', () => {
    pathname = '/admin/clients/client-1/venues/venue-1/chatlogs'
    render(
      <ClientWorkspaceShell client={client} venues={venues}>
        <p>Venue body</p>
      </ClientWorkspaceShell>,
    )

    expect(screen.getByText('Venue scope')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Harbor Museum' })).toBeTruthy()
    expect(screen.getByText('Build & manage')).toBeTruthy()
    expect(screen.getByText('Observe & improve')).toBeTruthy()
    expect(screen.getByRole('link', { name: /External credentials/ }).getAttribute('href')).toBe(
      '/admin/clients/client-1/credentials',
    )
    expect(screen.getByRole('link', { name: /AI configuration/ }).getAttribute('href')).toBe(
      '/admin/clients/client-1/venues/venue-1/ai-configuration',
    )
    expect(screen.getByRole('link', { name: /Feature access/ }).getAttribute('href')).toBe(
      '/admin/clients/client-1/venues/venue-1/feature-access',
    )
    expect(
      screen.getByRole('link', { name: /Guest conversations/ }).getAttribute('aria-current'),
    ).toBe('page')
    expect(screen.getByRole('link', { name: /Open guest preview/ }).getAttribute('href')).toBe(
      'https://guide.example/harbor/chat',
    )
    expect(screen.getByRole('link', { name: /Manifest review/ }).getAttribute('href')).toBe(
      '/admin/clients/client-1/venues/venue-1/deployment-manifest',
    )
    expect(screen.getByRole('link', { name: /Guided intake/ }).getAttribute('href')).toBe(
      '/admin/clients/client-1/venues/venue-1/intake',
    )
    expect(screen.getByRole('link', { name: /Venue packages/ }).getAttribute('href')).toBe(
      '/admin/clients/client-1/venues/venue-1/packages',
    )
    expect(screen.getByRole('link', { name: /Native FULL releases/ }).getAttribute('href')).toBe(
      '/admin/clients/client-1/venues/venue-1/native-releases',
    )
    expect(screen.getByRole('link', { name: /Legacy compatibility/ }).getAttribute('href')).toBe(
      '/admin/clients/client-1/venues/venue-1/compatibility-content',
    )
    expect(screen.getByRole('link', { name: /Open guest preview/ }).getAttribute('rel')).toBe(
      'noreferrer',
    )
    expect(screen.getByRole('link', { name: /Open guest preview/ }).getAttribute('target')).toBe(
      '_blank',
    )
  })

  it('renders a graceful client-scoped empty venue state', () => {
    pathname = '/admin/clients/client-1'
    render(
      <ClientWorkspaceShell client={client} venues={[]}>
        Empty account
      </ClientWorkspaceShell>,
    )

    expect(screen.getByLabelText('Workspace navigation').textContent).toContain('No venues yet')
    expect(screen.getByText('Empty account')).toBeTruthy()
    expect(screen.queryByRole('main')).toBeNull()
    expect(screen.queryByText('Build & manage')).toBeNull()
    expect(screen.queryByText('Observe & improve')).toBeNull()
  })

  it('selects venue scope only on an exact path segment boundary', () => {
    pathname = '/admin/clients/client-1/venues/venue-10/content'
    render(
      <ClientWorkspaceShell
        client={client}
        venues={[venues[0]!, { ...venues[1]!, id: 'venue-10', name: 'Venue Ten' }]}
      >
        Exact venue body
      </ClientWorkspaceShell>,
    )

    expect(screen.getByRole('heading', { name: 'Venue Ten' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Venue Ten' }).getAttribute('aria-current')).toBe(
      'page',
    )
    expect(screen.getByRole('link', { name: 'Harbor Museum' }).getAttribute('aria-current')).toBe(
      null,
    )
    expect(
      screen.getByRole('link', { name: /Universal content/ }).getAttribute('aria-current'),
    ).toBe('page')
  })

  it('does not mark a workflow active when its href is only a text prefix', () => {
    pathname = '/admin/clients/client-1/venues/venue-1/content-archive'
    render(
      <ClientWorkspaceShell client={client} venues={venues}>
        Archive body
      </ClientWorkspaceShell>,
    )

    expect(
      screen.getByRole('link', { name: /Universal content/ }).getAttribute('aria-current'),
    ).toBe(null)
  })
})
