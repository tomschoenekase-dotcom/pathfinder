import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  venueList: vi.fn(),
  listRequests: vi.fn(),
  getRequest: vi.fn(),
  listEligibleAttachments: vi.fn(),
  auth: vi.fn(),
  cookieGet: vi.fn(),
}))

vi.mock('@clerk/nextjs/server', () => ({ auth: mocks.auth }))
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ get: mocks.cookieGet })) }))

vi.mock('../../../lib/server-caller', () => ({
  createDashboardCaller: vi.fn(async () => ({
    venue: { list: mocks.venueList },
    support: {
      listRequests: mocks.listRequests,
      getRequest: mocks.getRequest,
      listEligibleAttachments: mocks.listEligibleAttachments,
    },
  })),
}))

import SupportPage from './page'

describe('SupportPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.venueList.mockResolvedValue([
      { id: 'venue_alpha', name: 'Science Museum' },
      { id: 'venue_beta', name: 'History Center' },
    ])
    mocks.listRequests.mockResolvedValue({
      items: [{ id: 'request_beta' }],
      nextCursor: null,
    })
    mocks.getRequest.mockResolvedValue({ id: 'request_beta', messages: [] })
    mocks.listEligibleAttachments.mockResolvedValue({ items: [], nextCursor: null })
    mocks.auth.mockResolvedValue({ sessionClaims: {} })
    mocks.cookieGet.mockReturnValue(undefined)
  })

  it('links an operator preview to the venue-wide Support workspace', async () => {
    mocks.auth.mockResolvedValue({
      sessionClaims: { publicMetadata: { platform_role: 'PLATFORM_ADMIN' } },
    })
    mocks.cookieGet.mockReturnValue({ value: 'tenant_alpha' })

    const element = await SupportPage({ searchParams: Promise.resolve({}) })

    expect(element.props.operatorSupportHref).toBe(
      '/admin/clients/tenant_alpha/venues/venue_alpha/support-operations',
    )
  })

  it('loads both list and detail using only the explicitly selected venue', async () => {
    const element = await SupportPage({
      searchParams: Promise.resolve({ venue: 'venue_beta' }),
    })

    expect(mocks.listRequests).toHaveBeenCalledWith({ venueId: 'venue_beta' })
    expect(mocks.getRequest).toHaveBeenCalledWith({
      venueId: 'venue_beta',
      requestId: 'request_beta',
    })
    expect(mocks.listEligibleAttachments).toHaveBeenCalledWith({
      venueId: 'venue_beta',
      limit: 20,
    })
    expect(element.props.activeVenue).toEqual({ id: 'venue_beta', name: 'History Center' })
  })

  it('does not attempt a detail read when the selected venue has no requests', async () => {
    mocks.listRequests.mockResolvedValueOnce({ items: [], nextCursor: null })

    const element = await SupportPage({ searchParams: Promise.resolve({}) })

    expect(mocks.listRequests).toHaveBeenCalledWith({ venueId: 'venue_alpha' })
    expect(mocks.getRequest).not.toHaveBeenCalled()
    expect(mocks.listEligibleAttachments).toHaveBeenCalledWith({
      venueId: 'venue_alpha',
      limit: 20,
    })
    expect(element.props.initialDetail).toBeNull()
  })

  it('opens a visitor-insight correction draft instead of an unrelated existing request', async () => {
    const element = await SupportPage({
      searchParams: Promise.resolve({ venue: 'venue_beta', new: 'visitor-insight' }),
    })

    expect(mocks.getRequest).not.toHaveBeenCalled()
    expect(element.props.initialDetail).toBeNull()
    expect(element.props.initialCreateDraft).toEqual({
      category: 'CONTENT_CORRECTION',
      subject: 'Visitor experience review',
    })
  })
})
