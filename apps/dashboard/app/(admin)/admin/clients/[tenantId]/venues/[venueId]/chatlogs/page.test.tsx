/* @vitest-environment jsdom */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ listVenueSessions: vi.fn() }))
vi.mock('../../../../../../../../lib/admin-caller', () => ({
  createAdminCaller: async () => ({ admin: { listVenueSessions: mocks.listVenueSessions } }),
}))

import AdminChatlogsPage from './page'

describe('AdminChatlogsPage pagination', () => {
  it('preserves active filters while exposing bounded older-session navigation', async () => {
    const observedAt = new Date('2026-08-27T12:00:00.000Z')
    mocks.listVenueSessions.mockResolvedValue({
      sessions: [
        {
          id: 'session_1',
          startedAt: observedAt,
          lastActiveAt: observedAt,
          isNotable: true,
          experienceScope: 'PUBLIC',
          messageCount: 6,
          _count: { engagementResponses: 1, adminNotes: 2 },
        },
      ],
      nextCursor: 'session_1',
    })
    const page = await AdminChatlogsPage({
      params: Promise.resolve({ tenantId: 'tenant_1', venueId: 'venue_1' }),
      searchParams: Promise.resolve({
        from: '2026-08-01',
        notable: 'on',
        scope: 'PUBLIC',
        cursor: 'session_2',
      }),
    })
    const html = renderToStaticMarkup(page)

    expect(mocks.listVenueSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        notableOnly: true,
        experienceScope: 'PUBLIC',
        cursor: 'session_2',
      }),
    )
    expect(html).toContain('Newest sessions')
    expect(html).toContain('Older sessions')
    expect(html).toContain('cursor=session_1')
    expect(html).toContain('from=2026-08-01')
  })
})
