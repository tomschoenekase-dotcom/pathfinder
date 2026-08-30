/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ replace: vi.fn(), createCampaign: vi.fn() }))

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/prospects',
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      createProspectCampaign: { mutate: mocks.createCampaign },
      listProspectSavedViews: { query: vi.fn() },
      listProspects: { query: vi.fn() },
      saveProspectView: { mutate: vi.fn() },
    },
  }),
}))

import { ProspectDirectory } from './ProspectDirectory'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const fixture = {
  result: {
    items: [
      {
        id: 'prospect-1',
        canonicalName: 'Harbor Museum',
        venues: [{ name: 'Harbor Museum' }],
        territory: { name: 'Chicago' },
        opportunity: {
          stage: 'RESEARCHED',
          priority: 'HIGH',
          nextAction: 'Review contact',
          nextActionAt: new Date('2026-09-01T12:00:00Z'),
        },
        relationshipTier: 'HIGH_VALUE',
        priority: 'HIGH',
      },
    ],
    nextCursor: null,
  },
  savedViews: [],
}

describe('ProspectDirectory campaign dialog accessibility', () => {
  afterEach(() => {
    cleanup()
    document.body.style.overflow = ''
  })

  it('contains focus, closes on Escape, and returns focus to its opener', async () => {
    render(<ProspectDirectory fixture={fixture as never} outreachAvailable />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all shown prospects' }))
    const opener = screen.getByRole('button', { name: 'Create outreach campaign' })
    opener.focus()
    fireEvent.click(opener)

    const dialog = screen.getByRole('dialog', { name: 'Create outreach campaign' })
    const name = screen.getByRole('textbox', { name: 'Campaign name' })
    await waitFor(() => expect(document.activeElement).toBe(name))
    expect(dialog.getAttribute('aria-describedby')).toBe('campaign-description')
    expect(document.body.style.overflow).toBe('hidden')

    const cancel = screen.getByRole('button', { name: 'Cancel' })
    name.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(cancel)
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(name)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(opener))
    expect(document.body.style.overflow).toBe('')
  })
})
