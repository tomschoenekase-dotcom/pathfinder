// @vitest-environment jsdom

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const query = vi.fn()
  const mutate = vi.fn()
  const convertMutate = vi.fn()
  return {
    query,
    mutate,
    convertMutate,
    client: {
      admin: {
        listPublicInterestSubmissions: { query },
        reviewPublicInterestSubmission: { mutate },
        convertPublicInterestSubmissionToProspect: { mutate: convertMutate },
      },
    },
  }
})
const { query, mutate, convertMutate } = mocks
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => mocks.client,
}))

import { PublicInterestInbox } from './PublicInterestInbox'

describe('PublicInterestInbox', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

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
    expect(query).toHaveBeenCalledWith(
      { status: 'NEW', limit: 100 },
      { signal: expect.any(AbortSignal) },
    )
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

  it('cancels the obsolete read when the status filter changes', async () => {
    const signals: AbortSignal[] = []
    query.mockImplementation((input, options) => {
      signals.push(options.signal)
      if (input.status === 'NEW') return new Promise(() => {})
      return Promise.resolve({ items: [], counts: {}, policy: {} })
    })
    render(<PublicInterestInbox />)
    await waitFor(() => expect(signals).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    await waitFor(() => expect(signals).toHaveLength(2))
    expect(signals[0]?.aborted).toBe(true)
    expect(await screen.findByText(/No inbound requests/u)).toBeTruthy()
  })

  it('recovers with fixed guidance when the inbox read exceeds its deadline', async () => {
    vi.useFakeTimers()
    query.mockImplementation(() => new Promise(() => {}))
    render(<PublicInterestInbox />)
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(screen.getByRole('alert').textContent).toMatch(/could not be loaded in time/i)
    expect(screen.queryByText(/secret provider detail/i)).toBeNull()
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it('distinguishes a saved review from a failed follow-up refresh', async () => {
    query
      .mockResolvedValueOnce({
        items: [
          {
            id: 'clw1234567890abcdefghijk',
            organizationName: 'River Museum',
            contactName: 'Avery Guide',
            workEmail: 'avery@example.com',
            website: null,
            cityRegion: null,
            venueType: null,
            message: null,
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
        policy: {},
      })
      .mockRejectedValueOnce(new Error('secret provider detail'))
    render(<PublicInterestInbox />)
    fireEvent.click(await screen.findByRole('button', { name: 'Mark reviewed' }))
    expect(await screen.findByText(/review decision was saved, but the inbox/i)).toBeTruthy()
    expect(screen.queryByText(/secret provider detail/i)).toBeNull()
  })
})
