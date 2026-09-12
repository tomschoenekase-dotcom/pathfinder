import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  sessionFindMany: vi.fn(),
  sessionFindFirst: vi.fn(),
  messageFindMany: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  addChatlogNoteAction: vi.fn(),
  ChatlogReviewActionError: class extends Error {},
  setChatlogNotableAction: vi.fn(),
  withTenantIsolationBypass: mocks.bypass,
  db: {
    visitorSession: {
      findMany: mocks.sessionFindMany,
      findFirst: mocks.sessionFindFirst,
    },
    message: { findMany: mocks.messageFindMany },
  },
}))

import type { TRPCContext } from '../../context'
import { adminChatlogsRouter } from './chatlogs'

const caller = () =>
  adminChatlogsRouter.createCaller({
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'platform-admin',
      activeTenantId: null,
      role: 'OWNER',
      isPlatformAdmin: true,
    },
  })

describe('admin chatlog disposition boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sessionFindMany.mockResolvedValue([])
    mocks.messageFindMany.mockResolvedValue([])
  })

  it('retains structural session counts in the list while omitting content from disposed detail', async () => {
    await caller().listVenueSessions({ tenantId: 'tenant-a', venueId: 'venue-a' })

    expect(mocks.sessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ dispositionOperationId: expect.anything() }),
      }),
    )

    mocks.sessionFindFirst.mockResolvedValueOnce(null)
    await expect(
      caller().getSessionChatlog({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        sessionId: 'session-a',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    expect(mocks.sessionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'session-a',
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          dispositionOperationId: null,
        },
      }),
    )
    expect(mocks.messageFindMany).not.toHaveBeenCalled()
  })

  it('applies a second disposition guard to content rows in an ordinary detail read', async () => {
    mocks.sessionFindFirst.mockResolvedValueOnce({
      id: 'session-a',
      venueId: 'venue-a',
      startedAt: new Date('2026-09-12T00:00:00.000Z'),
      lastActiveAt: new Date('2026-09-12T00:01:00.000Z'),
      messageCount: 1,
      isNotable: false,
      experienceScope: 'PUBLIC',
      venue: { name: 'Venue A' },
      engagementResponses: [],
      adminNotes: [],
    })

    await caller().getSessionChatlog({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      sessionId: 'session-a',
    })

    expect(mocks.messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          sessionId: 'session-a',
          session: { dispositionOperationId: null },
        }),
      }),
    )
  })
})
