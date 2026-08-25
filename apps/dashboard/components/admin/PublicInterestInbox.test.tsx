// @vitest-environment jsdom

import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.hoisted(() => vi.fn())
const mutate = vi.hoisted(() => vi.fn())
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      listPublicInterestSubmissions: { query },
      reviewPublicInterestSubmission: { mutate },
    },
  }),
}))

import { PublicInterestInbox } from './PublicInterestInbox'

describe('PublicInterestInbox', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('crypto', { randomUUID: () => '33333333-3333-4333-8333-333333333333' })
    query.mockResolvedValue({
      items: [
        {
          id: 'clw1234567890abcdefghijk',
          organizationName: 'River Museum',
          contactName: 'Avery Guide',
          workEmail: 'avery@example.com',
          website: 'https://river.example',
          cityRegion: 'St. Louis, MO',
          venueType: 'Museum',
          message: 'We need a better guest guide.',
          sourcePath: '/request-demo',
          status: 'NEW',
          reviewedAt: null,
          reviewedBy: null,
          createdAt: new Date('2026-08-25T12:00:00Z'),
          reviews: [],
        },
      ],
      counts: { NEW: 1 },
      policy: {
        createsCanonicalProspect: false,
        sendsCommunication: false,
        pricingAuthorityGranted: false,
      },
    })
    mutate.mockResolvedValue({ id: 'clw1234567890abcdefghijk', status: 'REVIEWED' })
  })

  it('shows staged evidence and records a bounded review decision', async () => {
    render(<PublicInterestInbox />)
    expect(await screen.findByText('River Museum')).toBeTruthy()
    expect(screen.getByText(/never sends a message, sets a price/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }))
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: '33333333-3333-4333-8333-333333333333',
          decision: 'MARK_REVIEWED',
        }),
      ),
    )
  })

  it('has explicit loading and empty states', async () => {
    query.mockResolvedValue({ items: [], counts: {}, policy: {} })
    render(<PublicInterestInbox />)
    expect(screen.getByRole('status').textContent).toMatch(/Loading/u)
    expect(await screen.findByText(/No new inbound requests/u)).toBeTruthy()
  })
})
