// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.hoisted(() => vi.fn())
const mutate = vi.hoisted(() => vi.fn())
const convertMutate = vi.hoisted(() => vi.fn())
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      listPublicInterestSubmissions: { query },
      reviewPublicInterestSubmission: { mutate },
      convertPublicInterestSubmissionToProspect: { mutate: convertMutate },
    },
  }),
}))

import { PublicInterestInbox } from './PublicInterestInbox'

describe('PublicInterestInbox', () => {
  afterEach(cleanup)

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
          prospectConversion: null,
        },
      ],
      counts: { NEW: 1 },
      policy: {
        automaticProspectCreation: false,
        reviewedHumanConversionAvailable: true,
        sendsCommunication: false,
        pricingAuthorityGranted: false,
      },
    })
    mutate.mockResolvedValue({ id: 'clw1234567890abcdefghijk', status: 'REVIEWED' })
    convertMutate.mockResolvedValue({
      replayed: false,
      organization: { id: 'prospect-1', canonicalName: 'River Museum' },
    })
  })

  it('shows staged evidence and records a bounded review decision', async () => {
    render(<PublicInterestInbox />)
    expect(await screen.findByText('River Museum')).toBeTruthy()
    expect(screen.getByText(/never contacts anyone, sets a price/i)).toBeTruthy()
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

  it('creates a canonical prospect only through the explicit human action', async () => {
    render(<PublicInterestInbox />)
    fireEvent.click(await screen.findByRole('button', { name: 'Create prospect' }))
    await waitFor(() =>
      expect(convertMutate).toHaveBeenCalledWith({
        operationId: '33333333-3333-4333-8333-333333333333',
        submissionId: 'clw1234567890abcdefghijk',
        reason: 'Converted after human review in the inbound interest inbox.',
      }),
    )
    expect(await screen.findByText(/Created River Museum in the prospect CRM/u)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'View prospect' }).getAttribute('href')).toBe(
      '/admin/prospects/prospect-1',
    )
  })

  it('has explicit loading and empty states', async () => {
    query.mockResolvedValue({ items: [], counts: {}, policy: {} })
    render(<PublicInterestInbox />)
    expect(screen.getByRole('status').textContent).toMatch(/Loading/u)
    expect(await screen.findByText(/No new inbound requests/u)).toBeTruthy()
  })
})
