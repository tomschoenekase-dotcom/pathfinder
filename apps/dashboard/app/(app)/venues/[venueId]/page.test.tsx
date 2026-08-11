import { describe, expect, it, vi } from 'vitest'

const redirect = vi.hoisted(() => vi.fn(() => undefined as never))
vi.mock('next/navigation', () => ({ redirect }))

import VenueDetailPage from './page'

describe('legacy venue detail boundary', () => {
  it('redirects to lifecycle home with exact encoded venue context', async () => {
    await VenueDetailPage({ params: Promise.resolve({ venueId: 'venue / one' }) })
    expect(redirect).toHaveBeenCalledWith('/?venue=venue%20%2F%20one')
  })
})
