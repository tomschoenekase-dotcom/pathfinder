/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

let pathname = '/admin'

vi.mock('next/navigation', () => ({ usePathname: () => pathname }))
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))
vi.mock('./AdminCommandPalette', () => ({
  AdminCommandPalette: () => <button type="button">Open command palette</button>,
}))

import { AdminSectionShell } from './AdminSectionShell'

describe('AdminSectionShell browser foundation', () => {
  afterEach(() => {
    cleanup()
    document.body.style.overflow = ''
    pathname = '/admin'
  })

  it('exposes the Torchiko OS landmarks and marks the exact active route', () => {
    pathname = '/admin/operations'
    render(
      <AdminSectionShell>
        <h1>Operations attention</h1>
      </AdminSectionShell>,
    )

    const navigations = screen.getAllByRole('navigation', { name: 'Torchiko OS navigation' })
    expect(navigations).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Control room' }).getAttribute('aria-current')).toBe(
      'page',
    )
    expect(screen.getByRole('link', { name: 'Command center' }).getAttribute('aria-current')).toBe(
      null,
    )
    expect(screen.getByRole('main').textContent).toContain('Operations attention')
    expect(screen.getByRole('link', { name: 'New client' }).getAttribute('href')).toBe('/admin/new')
    expect(screen.getByRole('link', { name: 'Open client portal' }).getAttribute('href')).toBe('/')
  })

  it('opens the responsive navigation, traps page scrolling, and restores focus on Escape', () => {
    render(
      <AdminSectionShell>
        <p>Command center content</p>
      </AdminSectionShell>,
    )

    const trigger = screen.getByRole('button', { name: 'Open navigation' })
    expect(trigger.className).toContain('min-h-11')
    expect(trigger.className).toContain('min-w-11')
    fireEvent.click(trigger)

    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('navigation', { name: 'Torchiko OS navigation' })).toHaveLength(2)
    expect(document.body.style.overflow).toBe('hidden')
    expect(document.activeElement).toBe(
      screen.getAllByRole('button', { name: 'Close navigation' })[1],
    )

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open navigation' }))
    expect(document.body.style.overflow).toBe('')
    expect(screen.getAllByRole('navigation', { name: 'Torchiko OS navigation' })).toHaveLength(1)
  })

  it('keeps keyboard focus inside responsive navigation in both directions', () => {
    render(<AdminSectionShell>Command center</AdminSectionShell>)
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }))

    const panel = document.getElementById('admin-mobile-navigation')
    const focusable = panel?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')
    expect(focusable?.length).toBeGreaterThan(2)
    const first = focusable?.[0]
    const last = focusable?.[(focusable?.length ?? 1) - 1]

    last?.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    first?.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('treats nested operational routes as active without marking the platform root active', () => {
    pathname = '/admin/operations/incidents/incident-1'
    render(<AdminSectionShell>Incident detail</AdminSectionShell>)

    expect(screen.getByRole('link', { name: 'Control room' }).getAttribute('aria-current')).toBe(
      'page',
    )
    expect(screen.getByRole('link', { name: 'Command center' }).getAttribute('aria-current')).toBe(
      null,
    )
    expect(screen.getByRole('main').textContent).toContain('Incident detail')
  })

  it('exposes the global Billing portfolio as a first-class operator route', () => {
    pathname = '/admin/billing'
    render(<AdminSectionShell>Billing portfolio</AdminSectionShell>)

    const link = screen.getByRole('link', { name: 'Billing' })
    expect(link.getAttribute('href')).toBe('/admin/billing')
    expect(link.getAttribute('aria-current')).toBe('page')
  })

  it('offers a skip link and moves route-change focus to the new page heading', async () => {
    const { rerender } = render(
      <AdminSectionShell>
        <h1>Command center</h1>
      </AdminSectionShell>,
    )
    expect(screen.getByRole('link', { name: 'Skip to main content' }).getAttribute('href')).toBe(
      '#admin-main-content',
    )

    pathname = '/admin/operations'
    rerender(
      <AdminSectionShell>
        <h1>Control room</h1>
      </AdminSectionShell>,
    )
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Control room' })),
    )
  })
})
