/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

let pathname = '/'
let platformRole: string | undefined

vi.mock('next/navigation', () => ({ usePathname: () => pathname }))
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))
vi.mock('@clerk/nextjs', () => ({
  SignOutButton: ({ children }: { children: React.ReactNode }) => children,
  useOrganization: () => ({ organization: { name: 'Harbor Museum' } }),
  useUser: () => ({ user: { publicMetadata: { platform_role: platformRole } } }),
}))
vi.mock('@pathfinder/ui', () => ({ TorchikoBrand: () => <span>Torchiko</span> }))
vi.mock('../lib/trpc', () => ({ useTRPCClient: () => ({}) }))

import { DashboardShell } from './DashboardShell'

describe('DashboardShell interaction semantics', () => {
  afterEach(() => {
    cleanup()
    pathname = '/'
    platformRole = undefined
  })

  it('makes the mobile drawer a modal and isolates the page while open', async () => {
    render(
      <DashboardShell>
        <button type="button">Page action</button>
      </DashboardShell>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }))
    const dialog = screen.getByRole('dialog', { name: 'Client portal navigation' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const main = screen.getByRole('main', { hidden: true })
    expect(main.getAttribute('aria-hidden')).toBe('true')
    expect(main.hasAttribute('inert')).toBe(true)

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(false)
  })

  it('renders setup information as current text instead of a no-op link', () => {
    pathname = '/onboarding/setup'
    render(<DashboardShell>Setup form</DashboardShell>)
    expect(screen.queryByRole('link', { name: 'Your information' })).toBeNull()
    expect(screen.getByText('Your information').closest('[aria-current="page"]')).toBeTruthy()
  })

  it('links venue onboarding information directly to the materials target', () => {
    pathname = '/venues/venue-1/onboarding'
    render(<DashboardShell>Journey</DashboardShell>)
    expect(screen.getByRole('link', { name: 'Your information' }).getAttribute('href')).toBe(
      '/venues/venue-1/onboarding#materials',
    )
  })

  it('keeps the compact admin-view return action touch-sized', () => {
    platformRole = 'PLATFORM_ADMIN'
    render(<DashboardShell impersonatedTenantName="Test venue">Journey</DashboardShell>)

    expect(screen.getByRole('button', { name: 'Open admin console' }).className).toContain(
      'min-h-11',
    )
  })

  it('shows the Payment tab only when the server-owned billing gate is available', () => {
    const { rerender } = render(<DashboardShell>Account</DashboardShell>)
    expect(screen.queryByRole('link', { name: 'Payment' })).toBeNull()

    rerender(<DashboardShell paymentAvailable>Payment content</DashboardShell>)
    expect(screen.getByRole('link', { name: 'Payment' }).getAttribute('href')).toBe('/payment')
  })
})
