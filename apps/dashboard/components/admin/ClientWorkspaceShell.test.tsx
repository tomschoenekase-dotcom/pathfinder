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
    expect(
      screen.getByRole('link', { name: /Guest conversations/ }).getAttribute('aria-current'),
    ).toBe('page')
    expect(screen.getByRole('link', { name: /Open guest preview/ }).getAttribute('href')).toBe(
      'https://guide.example/harbor/chat',
    )
  })
})
