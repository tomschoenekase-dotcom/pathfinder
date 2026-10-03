import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getGuestPreview: vi.fn(),
  getPublicVenue: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND')
  }),
}))

vi.mock('../../../lib/guest-preview', () => ({ getGuestPreview: mocks.getGuestPreview }))
vi.mock('../../../lib/public-venue', () => ({ getPublicVenue: mocks.getPublicVenue }))
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }))

import GuestPreviewPage, { dynamic, metadata } from './page'

const preview = {
  version: { kind: 'release', id: 'rel_1', status: 'DRAFT', expiresAt: '2026-10-02T12:15:00.000Z' },
  venue: { name: 'Draft Venue', description: null },
  places: [
    { name: 'Lion House', type: 'exhibit', areaName: null, hours: null, shortDescription: 'Cats' },
  ],
  knowledgeEntries: [{ title: 'Tickets', category: 'General', content: 'Cost 10' }],
  modules: [],
  readOnly: true,
}

describe('private guest preview route', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.stubGlobal('React', React)
  })

  it('is dynamic, unindexed and strips the referrer', () => {
    expect(dynamic).toBe('force-dynamic')
    expect(metadata.robots).toEqual({ index: false, follow: false })
    expect(metadata.referrer).toBe('no-referrer')
  })

  it('renders the exact version for a valid link without consulting the public venue lookup', async () => {
    mocks.getGuestPreview.mockResolvedValue(preview)
    render(
      await GuestPreviewPage({
        params: Promise.resolve({ venueSlug: 'draft-venue' }),
        searchParams: Promise.resolve({ token: 'signed' }),
      }),
    )
    expect(mocks.getGuestPreview).toHaveBeenCalledWith('draft-venue', 'signed')
    expect(mocks.getPublicVenue).not.toHaveBeenCalled()
    expect(screen.getByText('Draft Venue')).toBeTruthy()
    expect(screen.getByText('Lion House')).toBeTruthy()
    expect(screen.getByText(/Cannot send messages/u)).toBeTruthy()
  })

  it('shows not-found for a missing token, a repeated token parameter and every refusal', async () => {
    const page = (searchParams: Record<string, string | string[] | undefined>) =>
      GuestPreviewPage({
        params: Promise.resolve({ venueSlug: 'draft-venue' }),
        searchParams: Promise.resolve(searchParams),
      })
    await expect(page({})).rejects.toThrow('NEXT_NOT_FOUND')
    await expect(page({ token: ['a', 'b'] })).rejects.toThrow('NEXT_NOT_FOUND')
    expect(mocks.getGuestPreview).not.toHaveBeenCalled()
    mocks.getGuestPreview.mockResolvedValue(null)
    await expect(page({ token: 'expired-or-forged' })).rejects.toThrow('NEXT_NOT_FOUND')
  })
})
