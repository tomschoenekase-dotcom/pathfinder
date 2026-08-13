import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ create: vi.fn(), warn: vi.fn() }))

vi.mock('@pathfinder/config/logger', () => ({ logger: { warn: mocks.warn } }))
vi.mock('@pathfinder/db', () => ({ db: { analyticsEvent: { create: mocks.create } } }))

import { emitEvent } from './emit-event'

describe('emitEvent', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.create.mockResolvedValue({})
  })

  it('persists exact internal user-message attribution with structural metadata only', async () => {
    await emitEvent({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      sessionId: 'session_1',
      userMessageId: 'message_1',
      eventType: 'message.sent',
      metadata: { messageLength: 22 },
    })

    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        sessionId: 'session_1',
        userMessageId: 'message_1',
        eventType: 'message.sent',
        metadata: { messageLength: 22 },
      }),
    })
  })

  it('persists non-chat analytics without inventing a guest-session identity', async () => {
    await emitEvent({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      eventType: 'venue.updated',
    })

    expect(mocks.create.mock.calls[0]?.[0]?.data).not.toHaveProperty('sessionId')
    expect(mocks.create.mock.calls[0]?.[0]?.data).not.toHaveProperty('userMessageId')
  })
})
