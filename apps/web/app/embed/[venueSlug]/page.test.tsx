import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createContext: vi.fn(async () => ({})),
  enabled: vi.fn(),
  getBySlug: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND')
  }),
}))

vi.mock('@pathfinder/api', () => ({
  appRouter: {
    createCaller: () => ({ venue: { getBySlug: mocks.getBySlug } }),
  },
  createTRPCContext: mocks.createContext,
}))

vi.mock('@pathfinder/config/feature-flags', () => ({
  isEmbedPreviewEnabled: mocks.enabled,
}))

vi.mock('next/navigation', () => ({ notFound: mocks.notFound }))

vi.mock('../../../components/VenueChatExperience', () => ({
  VenueChatExperience: ({ venueSlug, presentation }: Record<string, string>) => (
    <div>{`${presentation}:${venueSlug}`}</div>
  ),
}))

vi.mock('../../../components/VenueTemporarilyUnavailable', () => ({
  VenueTemporarilyUnavailable: ({ showHomeLink }: { showHomeLink?: boolean }) => (
    <div>{`Temporarily unavailable:${String(showHomeLink)}`}</div>
  ),
}))

vi.mock('../../../components/WidgetReadySignal', () => ({
  WidgetReadySignal: ({ venueSlug }: { venueSlug: string }) => (
    <div>{`widget-ready:${venueSlug}`}</div>
  ),
}))

vi.mock('../../../lib/trpc', () => ({
  TRPCProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import EmbedVenuePage, { metadata } from './page'

describe('controlled embed preview', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    mocks.enabled.mockReturnValue(true)
    vi.stubGlobal('React', React)
  })

  it('fails closed before context or venue lookup when disabled', async () => {
    mocks.enabled.mockReturnValue(false)

    await expect(
      EmbedVenuePage({
        params: Promise.resolve({ venueSlug: 'museum' }),
        searchParams: Promise.resolve({ chrome: 'hidden' }),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND')
    expect(mocks.createContext).not.toHaveBeenCalled()
    expect(mocks.getBySlug).not.toHaveBeenCalled()
  })

  it('renders the shared chat in embed presentation for an active venue', async () => {
    mocks.getBySlug.mockResolvedValueOnce({ id: 'venue-1' })

    render(
      await EmbedVenuePage({
        params: Promise.resolve({ venueSlug: 'museum' }),
        searchParams: Promise.resolve({}),
      }),
    )

    expect(screen.getByText('embed:museum')).toBeTruthy()
    expect(screen.getByText('widget-ready:museum')).toBeTruthy()
    expect(mocks.getBySlug).toHaveBeenCalledWith({ slug: 'museum' })
  })

  it('renders web-view presentation only for exact hidden chrome input', async () => {
    mocks.getBySlug.mockResolvedValueOnce({ id: 'venue-1' })

    render(
      await EmbedVenuePage({
        params: Promise.resolve({ venueSlug: 'museum' }),
        searchParams: Promise.resolve({ chrome: 'hidden' }),
      }),
    )

    expect(screen.getByText('webview:museum')).toBeTruthy()
    expect(screen.queryByText('widget-ready:museum')).toBeNull()
  })

  it.each([
    { chrome: 'none' },
    { chrome: ['hidden', 'hidden'] },
    { chrome: 'hidden', source: 'native' },
  ])('fails non-exact chrome input back to ordinary embed %#', async (searchParams) => {
    mocks.getBySlug.mockResolvedValueOnce({ id: 'venue-1' })

    render(
      await EmbedVenuePage({
        params: Promise.resolve({ venueSlug: 'museum' }),
        searchParams: Promise.resolve(searchParams),
      }),
    )

    expect(screen.getByText('embed:museum')).toBeTruthy()
    expect(screen.queryByText('widget-ready:museum')).toBeNull()
  })

  it('uses the generic paused state without mounting chat', async () => {
    mocks.getBySlug.mockRejectedValueOnce({ code: 'SERVICE_UNAVAILABLE' })

    render(
      await EmbedVenuePage({
        params: Promise.resolve({ venueSlug: 'museum' }),
        searchParams: Promise.resolve({}),
      }),
    )

    expect(screen.getByText('Temporarily unavailable:false')).toBeTruthy()
    expect(screen.queryByText('embed:museum')).toBeNull()
    expect(screen.queryByText('widget-ready:museum')).toBeNull()
  })

  it('delegates missing venues to the 404 boundary', async () => {
    mocks.getBySlug.mockRejectedValueOnce({ code: 'NOT_FOUND' })

    await expect(
      EmbedVenuePage({
        params: Promise.resolve({ venueSlug: 'missing' }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('declares a no-index and no-follow metadata boundary', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false })
  })
})
