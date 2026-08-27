/* @vitest-environment jsdom */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ getSessionChatlog: vi.fn() }))
vi.mock('../../../../../../../../../lib/admin-caller', () => ({
  createAdminCaller: async () => ({ admin: { getSessionChatlog: mocks.getSessionChatlog } }),
}))
vi.mock('../../../../../../../../../components/admin/AdminChatlogNotableToggle', () => ({
  AdminChatlogNotableToggle: () => <div>Notable control</div>,
}))
vi.mock('../../../../../../../../../components/admin/AdminChatlogNoteForm', () => ({
  AdminChatlogNoteForm: () => <div>Notes control</div>,
}))

import AdminChatlogDetailPage from './page'

describe('AdminChatlogDetailPage pagination', () => {
  beforeEach(() => {
    mocks.getSessionChatlog.mockResolvedValue({
      id: 'session_1',
      venueId: 'venue_1',
      startedAt: new Date('2026-08-27T12:00:00.000Z'),
      lastActiveAt: new Date('2026-08-27T13:00:00.000Z'),
      messageCount: 2400,
      isNotable: false,
      experienceScope: 'PUBLIC',
      venue: { name: 'North Museum' },
      messages: [
        {
          id: 'message_1',
          role: 'user',
          content: 'Bounded page message',
          createdAt: new Date('2026-08-27T12:01:00.000Z'),
          sessionSequence: 950,
        },
      ],
      nextBeforeSequence: 950,
      engagementResponses: [],
      adminNotes: [],
    })
  })

  it('requests 50 messages and exposes the stable older-message cursor', async () => {
    const page = await AdminChatlogDetailPage({
      params: Promise.resolve({ tenantId: 'tenant_1', venueId: 'venue_1', sessionId: 'session_1' }),
      searchParams: Promise.resolve({ beforeSequence: '1000' }),
    })
    const html = renderToStaticMarkup(page)

    expect(mocks.getSessionChatlog).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      sessionId: 'session_1',
      messageLimit: 50,
      beforeSequence: 1000,
    })
    expect(html).toContain('2,400 total messages')
    expect(html).toContain('Return to newest')
    expect(html).toContain('beforeSequence=950')
    expect(html).toContain('Bounded page message')
  })

  it('ignores malformed message cursors', async () => {
    await AdminChatlogDetailPage({
      params: Promise.resolve({ tenantId: 'tenant_1', venueId: 'venue_1', sessionId: 'session_1' }),
      searchParams: Promise.resolve({ beforeSequence: '-1-or-more' }),
    })
    expect(mocks.getSessionChatlog).toHaveBeenCalledWith(
      expect.objectContaining({ beforeSequence: undefined }),
    )
  })
})
