import Anthropic from '@anthropic-ai/sdk'
import { TRPCError } from '@trpc/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock @pathfinder/config so env validation doesn't fail in the test environment
vi.mock('@pathfinder/config', () => ({
  env: { ANTHROPIC_API_KEY: 'test-key' },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

const { emitEvent } = vi.hoisted(() => ({
  emitEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@pathfinder/analytics', () => ({
  emitEvent,
}))

import { router } from '../core'
import type { TRPCContext } from '../context'
import { _setAnthropicClientForTesting, chatRouter } from './chat'

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

const dbQueryRaw = vi.fn()
const sessionUpsert = vi.fn()
const placeFindMany = vi.fn()
const messageFindMany = vi.fn()
const messageCreate = vi.fn()
const dbTransaction = vi.fn()

const mockDb = {
  venue: {},
  visitorSession: { upsert: sessionUpsert },
  place: { findMany: placeFindMany },
  message: { findMany: messageFindMany, create: messageCreate },
  $transaction: dbTransaction,
  $queryRaw: dbQueryRaw,
} as unknown as TRPCContext['db']

// ---------------------------------------------------------------------------
// Anthropic mock
// ---------------------------------------------------------------------------

const anthropicCreate = vi.fn()
const mockAnthropicClient = {
  messages: { create: anthropicCreate },
} as unknown as Anthropic

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ctx: TRPCContext = {
  db: mockDb,
  headers: new Headers(),
  session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
}

const testRouter = router({ chat: chatRouter })
const caller = testRouter.createCaller(ctx)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VENUE_ID = 'cvenueabc123456789012'
const TOKEN = '123e4567-e89b-12d3-a456-426614174000'
const SESSION_ID = 'csessionabc1234567890'
const TENANT_ID = 'tenant_1'

const venueRow = {
  id: VENUE_ID,
  tenantId: TENANT_ID,
  name: 'City Zoo',
  description: 'A great zoo.',
  category: 'zoo',
}

const placeRows = [
  { id: 'p1', name: 'Elephants', type: 'attraction', shortDescription: null, lat: 40.7, lng: -74.0, tags: [], areaName: null, hours: null },
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chat router', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    _setAnthropicClientForTesting(mockAnthropicClient)
  })

  afterEach(() => {
    _setAnthropicClientForTesting(null)
  })

  // --- chat.session ---

  describe('chat.session', () => {
    it('creates a session and returns sessionId', async () => {
      dbQueryRaw.mockResolvedValueOnce([{ id: VENUE_ID, tenantId: TENANT_ID }])
      sessionUpsert.mockResolvedValueOnce({ id: SESSION_ID })

      const result = await caller.chat.session({ venueId: VENUE_ID, anonymousToken: TOKEN })

      expect(result).toEqual({ sessionId: SESSION_ID })
      expect(sessionUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { anonymousToken: TOKEN },
          create: expect.objectContaining({ tenantId: TENANT_ID, venueId: VENUE_ID }),
        }),
      )
    })

    it('calling session twice with same token returns same session (upsert idempotency)', async () => {
      dbQueryRaw.mockResolvedValue([{ id: VENUE_ID, tenantId: TENANT_ID }])
      sessionUpsert.mockResolvedValue({ id: SESSION_ID })

      const r1 = await caller.chat.session({ venueId: VENUE_ID, anonymousToken: TOKEN })
      const r2 = await caller.chat.session({ venueId: VENUE_ID, anonymousToken: TOKEN })

      expect(r1).toEqual(r2)
      expect(sessionUpsert).toHaveBeenCalledTimes(2)
    })

    it('throws NOT_FOUND for inactive venue', async () => {
      dbQueryRaw.mockResolvedValueOnce([])

      await expect(
        caller.chat.session({ venueId: VENUE_ID, anonymousToken: TOKEN }),
      ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))
    })
  })

  // --- chat.send ---

  describe('chat.send', () => {
    const sendInput = {
      venueId: VENUE_ID,
      anonymousToken: TOKEN,
      message: 'Where are the elephants?',
      lat: 40.7128,
      lng: -74.006,
    }

    function setupHappyPath(assistantText = 'The elephants are 50m north.') {
      dbQueryRaw.mockResolvedValueOnce([venueRow])
      sessionUpsert.mockResolvedValueOnce({ id: SESSION_ID })
      placeFindMany.mockResolvedValueOnce(placeRows)
      messageFindMany.mockResolvedValueOnce([])
      anthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: assistantText }],
      })
      dbTransaction.mockResolvedValueOnce([{}, {}])
    }

    it('returns a non-empty response string and sessionId', async () => {
      setupHappyPath('The elephants are 50m north.')

      const result = await caller.chat.send(sendInput)

      expect(result.response).toBe('The elephants are 50m north.')
      expect(result.sessionId).toBe(SESSION_ID)
      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'message.sent', sessionId: TOKEN }),
      )
      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'message.received', sessionId: TOKEN }),
      )
    })

    it('throws NOT_FOUND for non-existent venueId', async () => {
      dbQueryRaw.mockResolvedValueOnce([])

      await expect(caller.chat.send(sendInput)).rejects.toThrowError(
        expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }),
      )
    })

    it('persists user and assistant messages in a transaction', async () => {
      setupHappyPath('Near the entrance.')

      await caller.chat.send(sendInput)

      // $transaction is called once with an array of two operations
      expect(dbTransaction).toHaveBeenCalledTimes(1)
      const transactionArg = dbTransaction.mock.calls[0]?.[0] as unknown[]
      expect(transactionArg).toHaveLength(2)
    })

    it('returns fallback string on Claude API failure — does not throw TRPCError', async () => {
      dbQueryRaw.mockResolvedValueOnce([venueRow])
      sessionUpsert.mockResolvedValueOnce({ id: SESSION_ID })
      placeFindMany.mockResolvedValueOnce(placeRows)
      messageFindMany.mockResolvedValueOnce([])
      anthropicCreate.mockRejectedValueOnce(new Error('Claude API unavailable'))
      dbTransaction.mockResolvedValueOnce([{}, {}])

      const result = await caller.chat.send(sendInput)

      expect(result.response).toContain("I'm having trouble right now")
      expect(result.sessionId).toBe(SESSION_ID)
    })

    it('loads history in correct chronological order (oldest first for Claude)', async () => {
      // DB returns newest first — router must reverse before sending to Claude
      dbQueryRaw.mockResolvedValueOnce([venueRow])
      sessionUpsert.mockResolvedValueOnce({ id: SESSION_ID })
      placeFindMany.mockResolvedValueOnce([])
      messageFindMany.mockResolvedValueOnce([
        { role: 'assistant', content: 'Second message' },
        { role: 'user', content: 'First message' },
      ])
      anthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Reply.' }],
      })
      dbTransaction.mockResolvedValueOnce([{}, {}])

      await caller.chat.send(sendInput)

      const callArgs = anthropicCreate.mock.calls[0]?.[0] as Parameters<
        Anthropic['messages']['create']
      >[0]
      // First two messages are history (reversed), third is new user message
      expect(callArgs.messages[0]).toMatchObject({ role: 'user', content: 'First message' })
      expect(callArgs.messages[1]).toMatchObject({ role: 'assistant', content: 'Second message' })
    })

    it('uses cache_control ephemeral on the system prompt', async () => {
      setupHappyPath('ok')

      await caller.chat.send(sendInput)

      const callArgs = anthropicCreate.mock.calls[0]?.[0] as Parameters<
        Anthropic['messages']['create']
      >[0]
      const systemBlocks = callArgs.system as Array<{ type: string; cache_control?: { type: string } }>
      expect(systemBlocks[0]).toMatchObject({
        type: 'text',
        cache_control: { type: 'ephemeral' },
      })
    })

    it('swallows analytics failures and still returns the AI response', async () => {
      setupHappyPath('The elephants are 50m north.')
      emitEvent.mockRejectedValueOnce(new Error('analytics offline'))
      emitEvent.mockRejectedValueOnce(new Error('analytics offline'))

      const result = await caller.chat.send(sendInput)

      expect(result.response).toBe('The elephants are 50m north.')
      expect(result.sessionId).toBe(SESSION_ID)
    })
  })
})
