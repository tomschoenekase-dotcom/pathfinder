/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AdminChatlogNotableToggle } from './AdminChatlogNotableToggle'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ setNotable: vi.fn() }))

vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { setSessionNotable: { mutate: mocks.setNotable } } }),
}))

describe('AdminChatlogNotableToggle', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it('exposes pressed state and announces a failed update without changing it', async () => {
    mocks.setNotable.mockRejectedValueOnce(new Error('Session update failed'))
    render(
      <AdminChatlogNotableToggle
        tenantId="tenant-1"
        venueId="venue-1"
        sessionId="session-1"
        initialIsNotable={false}
      />,
    )
    const toggle = screen.getByRole('button', { name: 'Mark notable' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect((await screen.findByRole('alert')).textContent).toBe('Session update failed')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
  })

  it('updates both its accessible name and pressed state after success', async () => {
    mocks.setNotable.mockResolvedValueOnce({ ok: true })
    render(
      <AdminChatlogNotableToggle
        tenantId="tenant-1"
        venueId="venue-1"
        sessionId="session-1"
        initialIsNotable={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Mark notable' }))
    const toggle = await screen.findByRole('button', { name: 'Unmark notable' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
  })
})
