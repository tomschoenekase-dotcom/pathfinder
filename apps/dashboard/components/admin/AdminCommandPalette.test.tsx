/* @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ query: vi.fn(), push: vi.fn() }))
vi.mock('../../lib/trpc', () => {
  const client = { admin: { searchAdminOs: { query: mocks.query } } }
  return { useTRPCClient: () => client }
})
vi.mock('next/navigation', () => ({
  usePathname: () => '/admin',
  useRouter: () => ({ push: mocks.push }),
}))
import { AdminCommandPalette } from './AdminCommandPalette'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const createdAt = new Date('2026-08-11T12:00:00Z')
const result = {
  groups: [
    {
      name: 'clients',
      items: [
        {
          id: 't1',
          tenantId: 't1',
          venueId: null,
          label: 'Museum Group',
          detail: 'museum · ACTIVE',
          route: '/admin/clients/t1',
          createdAt,
        },
      ],
      nextCursor: null,
    },
    {
      name: 'venues',
      items: [
        {
          id: 'v1',
          tenantId: 't1',
          venueId: 'v1',
          label: 'City Museum',
          detail: 'ART · active',
          route: '/admin/clients/t1/venues/v1',
          createdAt,
        },
      ],
      nextCursor: null,
    },
    {
      name: 'support',
      items: [
        {
          id: 's1',
          tenantId: 't1',
          venueId: 'v1',
          label: 'Museum hours',
          detail: 'GENERAL · OPEN',
          route: '/admin/clients/t1/venues/v1/support-operations',
          createdAt,
        },
      ],
      nextCursor: null,
    },
  ],
}

describe('AdminCommandPalette', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.query.mockResolvedValue(result)
  })
  afterEach(cleanup)
  async function search() {
    render(<AdminCommandPalette />)
    fireEvent.click(screen.getByRole('button', { name: 'Search or jump' }))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'museum' } })
    await waitFor(
      () =>
        expect(mocks.query).toHaveBeenCalledWith(
          { query: 'museum', limitPerGroup: 5 },
          { signal: expect.any(AbortSignal) },
        ),
      { timeout: 1000 },
    )
  }
  it('groups multi-entity results and navigates exact scoped routes', async () => {
    await search()
    expect(await screen.findByText('Clients')).toBeTruthy()
    expect(screen.getByText('Venues')).toBeTruthy()
    expect(screen.getByText('Support')).toBeTruthy()
    fireEvent.click(screen.getByText('City Museum'))
    expect(mocks.push).toHaveBeenCalledWith('/admin/clients/t1/venues/v1')
  })
  it('jumps to an exact venue sub-page without changing the backend search contract', async () => {
    render(<AdminCommandPalette />)
    fireEvent.click(screen.getByRole('button', { name: 'Search or jump' }))
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'City Museum → Guest design' },
    })
    await waitFor(() =>
      expect(mocks.query).toHaveBeenCalledWith(
        { query: 'City Museum', limitPerGroup: 5 },
        { signal: expect.any(AbortSignal) },
      ),
    )
    fireEvent.click(await screen.findByText('City Museum → Guest design'))
    expect(mocks.push).toHaveBeenCalledWith('/admin/clients/t1/venues/v1/guest-design')
  })
  it('keeps entity results available while jumping to nested agent settings', async () => {
    render(<AdminCommandPalette />)
    fireEvent.click(screen.getByRole('button', { name: 'Search or jump' }))
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'City Museum → Agent settings' },
    })
    expect(await screen.findByText('Museum hours')).toBeTruthy()
    fireEvent.click(await screen.findByText('City Museum → Agent settings'))
    expect(mocks.push).toHaveBeenCalledWith('/admin/clients/t1/venues/v1/agents/settings')
  })
  it('can load later matching venues while in page-jump mode', async () => {
    const cursor = { createdAt: '2026-08-11T12:00:00.000Z', id: 'v1' }
    mocks.query
      .mockResolvedValueOnce({
        groups: result.groups.map((group) =>
          group.name === 'venues' ? { ...group, nextCursor: cursor } : group,
        ),
      })
      .mockResolvedValueOnce({
        groups: [
          {
            name: 'venues',
            items: [
              {
                ...result.groups[1]!.items[0]!,
                id: 'v2',
                label: 'North Museum',
                route: '/admin/clients/t1/venues/v2',
              },
            ],
            nextCursor: null,
          },
        ],
      })
    render(<AdminCommandPalette />)
    fireEvent.click(screen.getByRole('button', { name: 'Search or jump' }))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Museum → Guest design' } })
    fireEvent.click(await screen.findByRole('button', { name: 'More venues' }))
    await waitFor(() =>
      expect(mocks.query).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'Museum', group: 'venues', cursor }),
        { signal: expect.any(AbortSignal) },
      ),
    )
    fireEvent.click(await screen.findByText('North Museum → Guest design'))
    expect(mocks.push).toHaveBeenCalledWith('/admin/clients/t1/venues/v2/guest-design')
  })
  it('supports combobox arrow navigation and Enter', async () => {
    await search()
    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mocks.push).toHaveBeenCalledWith('/admin/clients/t1/venues/v1')
  })
  it('does not search an empty query and exposes an accessible error', async () => {
    mocks.query.mockRejectedValue(new Error('down'))
    render(<AdminCommandPalette />)
    fireEvent.click(screen.getByRole('button', { name: 'Search or jump' }))
    expect(mocks.query).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'museum' } })
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Admin OS search is unavailable',
    )
  })
  it('aborts an in-flight search when the palette unmounts', async () => {
    mocks.query.mockImplementation(() => new Promise(() => undefined))
    const view = render(<AdminCommandPalette />)
    fireEvent.click(screen.getByRole('button', { name: 'Search or jump' }))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'museum' } })
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1), { timeout: 1000 })
    const signal = mocks.query.mock.calls[0]?.[1]?.signal as AbortSignal

    view.unmount()

    expect(signal.aborted).toBe(true)
  })
  it('aborts a stalled search at the request deadline and exposes the retry state', async () => {
    vi.useFakeTimers()
    mocks.query.mockImplementation(() => new Promise(() => undefined))
    render(<AdminCommandPalette />)
    fireEvent.click(screen.getByRole('button', { name: 'Search or jump' }))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'museum' } })

    await act(async () => vi.advanceTimersByTimeAsync(180))
    const signal = mocks.query.mock.calls[0]?.[1]?.signal as AbortSignal
    await act(async () => vi.advanceTimersByTimeAsync(15_000))

    expect(signal.aborted).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('Admin OS search is unavailable')
    vi.useRealTimers()
  })
})
