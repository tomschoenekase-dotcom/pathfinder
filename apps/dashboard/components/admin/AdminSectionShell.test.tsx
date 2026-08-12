/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

  it('exposes the PathFinder OS landmarks and marks the exact active route', () => {
    pathname = '/admin/operations'
    render(
      <AdminSectionShell>
        <h1>Operations attention</h1>
      </AdminSectionShell>,
    )

    const navigations = screen.getAllByRole('navigation', { name: 'PathFinder OS navigation' })
    expect(navigations).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Operations' }).getAttribute('aria-current')).toBe(
      'page',
    )
    expect(screen.getByRole('link', { name: 'Command center' }).getAttribute('aria-current')).toBe(
      null,
    )
    expect(screen.getByRole('main').textContent).toContain('Operations attention')
    expect(screen.getByRole('link', { name: 'New client' }).getAttribute('href')).toBe('/admin/new')
    expect(screen.getByRole('link', { name: 'Client portal' }).getAttribute('href')).toBe('/')
  })

  it('opens the responsive navigation, traps page scrolling, and restores focus on Escape', () => {
    render(
      <AdminSectionShell>
        <p>Command center content</p>
      </AdminSectionShell>,
    )

    const trigger = screen.getByRole('button', { name: 'Open navigation' })
    fireEvent.click(trigger)

    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('navigation', { name: 'PathFinder OS navigation' })).toHaveLength(2)
    expect(document.body.style.overflow).toBe('hidden')
    expect(document.activeElement).toBe(
      screen.getAllByRole('button', { name: 'Close navigation' })[1],
    )

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open navigation' }))
    expect(document.body.style.overflow).toBe('')
    expect(screen.getAllByRole('navigation', { name: 'PathFinder OS navigation' })).toHaveLength(1)
  })
})
