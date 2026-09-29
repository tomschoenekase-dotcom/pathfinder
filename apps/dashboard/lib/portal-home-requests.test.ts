import { describe, expect, it } from 'vitest'

import { buildHomeRequests, type HomeSupportRequest } from './portal-home-requests'

const base: HomeSupportRequest = {
  id: 'request-1',
  subject: 'Add fall hours',
  status: 'WAITING_FOR_CLIENT',
  missingInformation: ['Opening hours', 'A photo of the sign', 'Holiday closures'],
  canReply: true,
  clientActivityAt: '2026-09-24T15:00:00.000Z',
  statusChangedAt: '2026-09-24T15:00:00.000Z',
}
const live = { state: 'LIVE', clientAction: 'NONE' } as const
const noPreview = { state: 'UNAVAILABLE', id: null } as const

describe('buildHomeRequests', () => {
  it('puts what the venue owes first, links straight into the conversation, and summarises the ask', () => {
    const requests = buildHomeRequests({
      venueId: 'venue a',
      lifecycle: live,
      clientPreview: noPreview,
      supportRequests: [
        {
          ...base,
          id: 'working',
          subject: 'Trail map',
          status: 'IN_REVIEW',
          missingInformation: [],
        },
        base,
      ],
    })
    expect(requests.map((request) => [request.id, request.needsYou])).toEqual([
      ['request-1', true],
      ['working', false],
    ])
    expect(requests[0]).toMatchObject({
      href: '/support?venue=venue%20a&request=request-1',
      actionLabel: 'Reply',
      detail: 'Opening hours · A photo of the sign · and 1 more',
      meta: 'Requested Sep 24',
    })
    expect(requests[1]).toMatchObject({ actionLabel: 'View', meta: 'In review · Sep 24' })
  })

  it('never treats work waiting on Torchiko, or a conversation the venue cannot answer, as owed', () => {
    const requests = buildHomeRequests({
      venueId: 'venue',
      lifecycle: live,
      clientPreview: noPreview,
      supportRequests: [
        { ...base, canReply: false },
        { ...base, id: 'r2', status: 'APPLYING' },
        { ...base, id: 'done', status: 'COMPLETED' },
        { ...base, id: 'closed', status: 'CANCELLED' },
      ],
    })
    expect(requests.every((request) => !request.needsYou)).toBe(true)
    expect(requests.map((request) => request.id)).toEqual(['request-1', 'r2'])
  })

  it('adds lifecycle asks only when the venue has to act', () => {
    const preview = buildHomeRequests({
      venueId: 'v',
      lifecycle: { state: 'CLIENT_PREVIEW', clientAction: 'OPEN_PREVIEW' },
      clientPreview: { state: 'AVAILABLE', id: 'pkg 1' },
      supportRequests: [],
    })
    expect(preview[0]).toMatchObject({ needsYou: true, href: '/venues/v/preview/pkg%201' })

    const paused = buildHomeRequests({
      venueId: 'v',
      lifecycle: { state: 'PAUSED', clientAction: 'CONTACT_SUPPORT' },
      clientPreview: noPreview,
      supportRequests: [],
    })
    expect(paused[0]).toMatchObject({ needsYou: true, href: '/support?venue=v' })

    const building = buildHomeRequests({
      venueId: 'v',
      lifecycle: { state: 'PROCESSING', clientAction: 'NONE' },
      clientPreview: noPreview,
      supportRequests: [],
    })
    expect(building).toEqual([expect.objectContaining({ needsYou: false })])
  })

  it('keeps Torchiko-side items to a short list', () => {
    const requests = buildHomeRequests({
      venueId: 'v',
      lifecycle: live,
      clientPreview: noPreview,
      supportRequests: Array.from({ length: 6 }, (_, index) => ({
        ...base,
        id: `w${index}`,
        status: 'IN_REVIEW',
      })),
    })
    expect(requests).toHaveLength(3)
  })
})
