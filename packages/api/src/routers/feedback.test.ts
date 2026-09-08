import { beforeEach, describe, expect, it, vi } from 'vitest'

const rateLimit = vi.hoisted(() => vi.fn())
const operationalEventUpsert = vi.fn()
vi.mock('../lib/rate-limit', () => ({ checkRateLimit: rateLimit }))

import type { TRPCContext } from '../context'
import { router } from '../core'
import { visitorHazardDeduplicationKey } from '../lib/visitor-signal-candidate'
import { feedbackRouter } from './feedback'

const queryRaw = vi.fn()
const upsert = vi.fn()
const createEvent = vi.fn()
const createInsights = vi.fn()
const db = {
  $queryRaw: queryRaw,
  $transaction: (operation: (tx: unknown) => unknown) =>
    operation({
      messageFeedback: { upsert },
      analyticsEvent: { create: createEvent },
      conversationInsight: { createMany: createInsights },
      operationalEvent: { upsert: operationalEventUpsert },
    }),
} as unknown as TRPCContext['db']
const caller = router({ feedback: feedbackRouter }).createCaller({
  db,
  headers: new Headers(),
  session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
})
const request = {
  venueId: 'cm0venue0000000000000001',
  anonymousToken: '123e4567-e89b-42d3-a456-426614174000',
  messageId: 'assistant-message-1',
  rating: 'NOT_HELPFUL' as const,
}

describe('message feedback router', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rateLimit.mockResolvedValue(true)
    upsert.mockResolvedValue({ id: 'feedback-1' })
    createEvent.mockResolvedValue({ id: 'event-1' })
    createInsights.mockResolvedValue({ count: 1 })
    operationalEventUpsert.mockResolvedValue({ id: 'event-1', state: 'OPEN', occurrenceCount: 1 })
  })

  it('writes only against the server-resolved public message scope', async () => {
    queryRaw.mockResolvedValue([
      {
        tenantId: 'tenant-1',
        venueId: request.venueId,
        sessionId: 'session-1',
        messageId: request.messageId,
        guestChatTurnId: '11111111-1111-4111-8111-111111111111',
        userMessageId: 'user-message-1',
      },
    ])
    await expect(caller.feedback.submit(request)).resolves.toEqual({ ok: true })
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ tenantId: 'tenant-1', rating: 'NOT_HELPFUL' }),
      }),
    )
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'chat.response.feedback' }),
      }),
    )
    expect(createInsights).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          category: 'VISITOR_NEGATIVE_FEEDBACK',
          confidence: 1,
          severity: 'INFO',
          evidenceMessageIds: ['user-message-1', request.messageId],
          guestChatTurnId: '11111111-1111-4111-8111-111111111111',
        }),
      ],
      skipDuplicates: true,
    })
  })

  it('does not create a negative-feedback insight for a helpful rating', async () => {
    queryRaw.mockResolvedValue([
      {
        tenantId: 'tenant-1',
        venueId: request.venueId,
        sessionId: 'session-1',
        messageId: request.messageId,
        guestChatTurnId: '11111111-1111-4111-8111-111111111111',
        userMessageId: 'user-message-1',
      },
    ])

    await expect(caller.feedback.submit({ ...request, rating: 'HELPFUL' })).resolves.toEqual({
      ok: true,
    })
    expect(createInsights).not.toHaveBeenCalled()
  })

  it('does not reveal an out-of-scope or employee message', async () => {
    queryRaw.mockResolvedValue([])
    await expect(
      caller.feedback.submit({ ...request, reason: 'There is broken glass by the entrance.' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(upsert).not.toHaveBeenCalled()
    expect(operationalEventUpsert).not.toHaveBeenCalled()
  })

  it('escalates an explicit visitor safety report through the canonical operational event', async () => {
    queryRaw.mockResolvedValue([
      {
        tenantId: 'tenant-1',
        venueId: request.venueId,
        sessionId: 'session-1',
        messageId: request.messageId,
        guestChatTurnId: '11111111-1111-4111-8111-111111111111',
        userMessageId: 'user-message-1',
      },
    ])

    await expect(
      caller.feedback.submit({ ...request, reason: 'There is broken glass by the entrance.' }),
    ).resolves.toEqual({ ok: true })
    expect(operationalEventUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant-1',
          tenantId_deduplicationKey: {
            tenantId: 'tenant-1',
            deduplicationKey: visitorHazardDeduplicationKey({
              tenantId: 'tenant-1',
              venueId: request.venueId,
              guestChatTurnId: '11111111-1111-4111-8111-111111111111',
              messageId: request.messageId,
            }),
          },
        },
        create: expect.objectContaining({
          eventType: 'visitor-feedback.potential-urgent-hazard',
          severity: 'CRITICAL',
          actionRequired: true,
          linkedObjectType: 'MessageFeedback',
          linkedObjectId: 'feedback-1',
          summary: expect.stringContaining('unverified'),
        }),
      }),
    )
  })

  it('retains a closure report as feedback evidence without escalating or changing venue content', async () => {
    queryRaw.mockResolvedValue([
      {
        tenantId: 'tenant-1',
        venueId: request.venueId,
        sessionId: 'session-1',
        messageId: request.messageId,
        guestChatTurnId: '11111111-1111-4111-8111-111111111111',
        userMessageId: 'user-message-1',
      },
    ])

    await expect(
      caller.feedback.submit({ ...request, reason: 'The greenhouse is closed today.' }),
    ).resolves.toEqual({ ok: true })
    expect(operationalEventUpsert).not.toHaveBeenCalled()
    expect(createInsights).toHaveBeenCalledOnce()
    expect(createInsights).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ summary: expect.stringContaining('closure') })],
      }),
    )
  })

  it('groups repeated potential-hazard feedback under the same per-turn event key', async () => {
    queryRaw.mockResolvedValue([
      {
        tenantId: 'tenant-1',
        venueId: request.venueId,
        sessionId: 'session-1',
        messageId: request.messageId,
        guestChatTurnId: '11111111-1111-4111-8111-111111111111',
        userMessageId: 'user-message-1',
      },
    ])
    const input = { ...request, reason: 'There is smoke by the entrance.' }

    await caller.feedback.submit(input)
    await caller.feedback.submit(input)

    const [first, second] = operationalEventUpsert.mock.calls
    expect(first?.[0].where.tenantId_deduplicationKey).toEqual(
      second?.[0].where.tenantId_deduplicationKey,
    )
  })
})
