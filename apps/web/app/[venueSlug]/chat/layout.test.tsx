import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getBySlug: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND')
  }),
  refresh: vi.fn(),
}))

vi.mock('@pathfinder/api', () => ({
  appRouter: {
    createCaller: () => ({
      venue: { getBySlug: mocks.getBySlug },
    }),
  },
  createTRPCContext: vi.fn(async () => ({})),
}))

vi.mock('next/navigation', () => ({
  notFound: mocks.notFound,
  useRouter: () => ({ refresh: mocks.refresh }),
}))

vi.mock('../../../lib/trpc', () => ({
  TRPCProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import VenueChatLayout, { generateMetadata } from './layout'

describe('VenueChatLayout availability boundary', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.stubGlobal('React', React)
  })

  it('renders the chat tree for an active venue', async () => {
    mocks.getBySlug.mockResolvedValueOnce({ id: 'venue-1' })

    const result = await VenueChatLayout({
      children: <div>Chat tree mounted</div>,
      params: Promise.resolve({ venueSlug: 'museum' }),
    })
    render(result)

    expect(screen.getByText('Chat tree mounted')).toBeTruthy()
  })

  it('renders a generic paused state without mounting the chat tree', async () => {
    mocks.getBySlug.mockRejectedValueOnce({ code: 'SERVICE_UNAVAILABLE' })

    const result = await VenueChatLayout({
      children: <div>Chat tree mounted</div>,
      params: Promise.resolve({ venueSlug: 'museum' }),
    })
    render(result)

    expect(screen.getByRole('heading', { name: 'Guide temporarily unavailable' })).toBeTruthy()
    expect(screen.queryByText('Chat tree mounted')).toBeNull()
    expect(screen.queryByText('museum')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('renders the same temporary state when public lookup admission is exhausted', async () => {
    mocks.getBySlug.mockRejectedValueOnce({ code: 'TOO_MANY_REQUESTS' })

    const result = await VenueChatLayout({
      children: <div>Chat tree mounted</div>,
      params: Promise.resolve({ venueSlug: 'museum' }),
    })
    render(result)

    expect(screen.getByRole('heading', { name: 'Guide temporarily unavailable' })).toBeTruthy()
    expect(screen.queryByText('Chat tree mounted')).toBeNull()
  })

  it('delegates an unknown venue to the Next.js 404 boundary', async () => {
    mocks.getBySlug.mockRejectedValueOnce({ code: 'NOT_FOUND' })

    await expect(
      VenueChatLayout({
        children: <div>Chat tree mounted</div>,
        params: Promise.resolve({ venueSlug: 'missing' }),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND')
    expect(mocks.notFound).toHaveBeenCalledOnce()
  })

  it('uses the admitted public lookup for metadata', async () => {
    mocks.getBySlug.mockResolvedValueOnce({
      name: 'City Museum',
      description: 'Explore the collection.',
    })

    await expect(
      generateMetadata({ params: Promise.resolve({ venueSlug: 'museum' }) }),
    ).resolves.toEqual({
      title: 'City Museum — Torchiko',
      description: 'Explore the collection.',
    })
    expect(mocks.getBySlug).toHaveBeenCalledWith({ slug: 'museum' })
  })

  it('fails metadata closed to generic text when lookup is denied', async () => {
    mocks.getBySlug.mockRejectedValueOnce({ code: 'TOO_MANY_REQUESTS' })

    await expect(
      generateMetadata({ params: Promise.resolve({ venueSlug: 'museum' }) }),
    ).resolves.toEqual({ title: 'Torchiko' })
  })
})
