import { TRPCError } from '@trpc/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  setOpenAiEmbeddingsClientForTesting,
  type AnthropicCreateParams,
  type AnthropicMessagesClient,
  type OpenAiEmbeddingsClient,
} from '@pathfinder/ai'

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

const { checkRateLimit } = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
}))

vi.mock('../lib/rate-limit', () => ({ checkRateLimit }))

const semanticSearch = vi.hoisted(() => ({ places: vi.fn(), knowledge: vi.fn() }))
vi.mock('@pathfinder/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/db')>()),
  searchPlacesByEmbedding: semanticSearch.places,
  searchKnowledgeByEmbedding: semanticSearch.knowledge,
}))

import { router } from '../core'
import type { TRPCContext } from '../context'
import { _setAnthropicClientForTesting, chatRouter, enforceResponseWordCap } from './chat'

describe('enforceResponseWordCap', () => {
  it('leaves short text untouched', () => {
    expect(enforceResponseWordCap('Near the entrance.', 60)).toBe('Near the entrance.')
  })

  it('drops trailing sentences that push past the cap', () => {
    const text = 'One two three four five. Six seven eight nine ten.'
    expect(enforceResponseWordCap(text, 5)).toBe('One two three four five.')
  })

  it('keeps at least the first sentence even if it alone exceeds the cap', () => {
    const text = 'One two three four five six seven. Eight nine.'
    expect(enforceResponseWordCap(text, 3)).toBe('One two three four five six seven.')
  })
})

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

const dbQueryRaw = vi.fn()
const sessionUpsert = vi.fn()
const sessionUpdateMany = vi.fn().mockResolvedValue({ count: 1 })
const placeFindMany = vi.fn()
const placeFindFirst = vi.fn()
const messageFindMany = vi.fn()
const messageCreate = vi.fn()
const messageFindFirst = vi.fn()
const tenantFindUnique = vi.fn()
const engagementQuestionFindMany = vi.fn()
const engagementQuestionFindFirst = vi.fn()
const engagementQuestionResponseCreate = vi.fn().mockResolvedValue({})
const aiUsageEventCreate = vi.fn().mockResolvedValue({})
const platformConfigFindUnique = vi.fn()
const aiCostBudgetFindFirst = vi.fn()
const dbTransaction = vi.fn()

const operationalUpdateFindMany = vi.fn().mockResolvedValue([])

const mockDb = {
  platformConfig: { findUnique: platformConfigFindUnique },
  venue: {},
  visitorSession: { upsert: sessionUpsert, updateMany: sessionUpdateMany },
  tenant: { findUnique: tenantFindUnique },
  engagementQuestion: {
    findMany: engagementQuestionFindMany,
    findFirst: engagementQuestionFindFirst,
  },
  engagementQuestionResponse: { create: engagementQuestionResponseCreate },
  aiUsageEvent: { create: aiUsageEventCreate },
  aiCostBudget: { findFirst: aiCostBudgetFindFirst },
  aiCostReservation: {},
  place: { findMany: placeFindMany, findFirst: placeFindFirst },
  message: { findMany: messageFindMany, create: messageCreate, findFirst: messageFindFirst },
  operationalUpdate: { findMany: operationalUpdateFindMany },
  $queryRaw: dbQueryRaw,
  $transaction: dbTransaction,
} as unknown as TRPCContext['db']

// ---------------------------------------------------------------------------
// Anthropic mock
// ---------------------------------------------------------------------------

const anthropicCreate = vi.fn()
const mockAnthropicClient = {
  messages: { create: anthropicCreate },
} as AnthropicMessagesClient
const embeddingCreate = vi.fn()
const mockOpenAiClient = { embeddings: { create: embeddingCreate } } as OpenAiEmbeddingsClient

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
  {
    id: 'p1',
    name: 'Elephants',
    type: 'attraction',
    shortDescription: null,
    lat: 40.7,
    lng: -74.0,
    tags: [],
    areaName: null,
    hours: null,
  },
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chat router', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    _setAnthropicClientForTesting(mockAnthropicClient)
    setOpenAiEmbeddingsClientForTesting(mockOpenAiClient)
    embeddingCreate.mockResolvedValue({
      data: [{ embedding: Array.from({ length: 1_536 }, () => 0.1), index: 0 }],
      usage: { prompt_tokens: 5, total_tokens: 5 },
    })
    semanticSearch.places.mockResolvedValue(placeRows)
    semanticSearch.knowledge.mockResolvedValue([])
    operationalUpdateFindMany.mockResolvedValue([])
    tenantFindUnique.mockResolvedValue({ engagementMode: 'STOIC' })
    engagementQuestionFindMany.mockResolvedValue([])
    sessionUpdateMany.mockResolvedValue({ count: 1 })
    engagementQuestionResponseCreate.mockResolvedValue({})
    aiUsageEventCreate.mockResolvedValue({})
    platformConfigFindUnique.mockResolvedValue(null)
    aiCostBudgetFindFirst.mockResolvedValue(null)
    dbTransaction.mockImplementation((callback: (client: typeof mockDb) => unknown) =>
      callback(mockDb),
    )
    checkRateLimit.mockResolvedValue(true)
  })

  afterEach(() => {
    _setAnthropicClientForTesting(null)
    setOpenAiEmbeddingsClientForTesting(null)
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
          where: {
            venueId_anonymousToken: { venueId: VENUE_ID, anonymousToken: TOKEN },
            tenantId: TENANT_ID,
          },
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

    it('scopes the same anonymous token independently for different venues', async () => {
      const otherVenueId = 'cvenueother1234567890'
      dbQueryRaw
        .mockResolvedValueOnce([{ id: VENUE_ID, tenantId: TENANT_ID }])
        .mockResolvedValueOnce([{ id: otherVenueId, tenantId: 'tenant_2' }])
      sessionUpsert
        .mockResolvedValueOnce({ id: SESSION_ID })
        .mockResolvedValueOnce({ id: 'session_2' })

      await caller.chat.session({ venueId: VENUE_ID, anonymousToken: TOKEN })
      await caller.chat.session({ venueId: otherVenueId, anonymousToken: TOKEN })

      expect(sessionUpsert).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: {
            venueId_anonymousToken: { venueId: VENUE_ID, anonymousToken: TOKEN },
            tenantId: TENANT_ID,
          },
        }),
      )
      expect(sessionUpsert).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: {
            venueId_anonymousToken: { venueId: otherVenueId, anonymousToken: TOKEN },
            tenantId: 'tenant_2',
          },
        }),
      )
    })

    it('throws NOT_FOUND for inactive venue', async () => {
      dbQueryRaw.mockResolvedValueOnce([])

      await expect(
        caller.chat.session({ venueId: VENUE_ID, anonymousToken: TOKEN }),
      ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))
    })

    it('persists visitorId on the session when provided', async () => {
      dbQueryRaw.mockResolvedValueOnce([{ id: VENUE_ID, tenantId: TENANT_ID }])
      sessionUpsert.mockResolvedValueOnce({ id: SESSION_ID })

      const visitorId = '11111111-1111-4111-8111-111111111111'
      await caller.chat.session({ venueId: VENUE_ID, anonymousToken: TOKEN, visitorId })

      expect(sessionUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ visitorId }),
          update: expect.objectContaining({ visitorId }),
        }),
      )
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

    it('denies before session or provider work when a rate-limit dependency fails closed', async () => {
      dbQueryRaw.mockResolvedValueOnce([{ id: VENUE_ID, tenantId: TENANT_ID }])
      checkRateLimit.mockResolvedValue(false)

      await expect(caller.chat.send(sendInput)).rejects.toThrowError(
        expect.objectContaining<Partial<TRPCError>>({ code: 'TOO_MANY_REQUESTS' }),
      )

      expect(checkRateLimit).toHaveBeenCalledTimes(2)
      expect(sessionUpsert).not.toHaveBeenCalled()
      expect(messageCreate).not.toHaveBeenCalled()
      expect(anthropicCreate).not.toHaveBeenCalled()
      expect(aiUsageEventCreate).not.toHaveBeenCalled()
    })

    function setupHappyPath(assistantText = 'The elephants are 50m north.') {
      dbQueryRaw.mockResolvedValueOnce([venueRow])
      sessionUpsert.mockResolvedValueOnce({ id: SESSION_ID })
      placeFindMany.mockResolvedValueOnce(placeRows)
      messageFindMany.mockResolvedValueOnce([])
      tenantFindUnique.mockResolvedValueOnce({ engagementMode: 'STOIC' })
      engagementQuestionFindMany.mockResolvedValueOnce([
        {
          id: 'question_1',
          questionType: 'OPEN_ENDED',
          prompt: 'Ask whether the guest had trouble finding their way.',
          choiceOptions: [],
          intensity: 5,
        },
      ])
      anthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: assistantText }],
        usage: {
          input_tokens: 20,
          output_tokens: 10,
          cache_creation_input_tokens: 4,
          cache_read_input_tokens: 3,
        },
      })
      messageCreate.mockResolvedValue({})
    }

    function getConcatenatedSystemPrompt() {
      const callArgs = anthropicCreate.mock.calls[0]?.[0] as AnthropicCreateParams
      const systemBlocks = callArgs.system as Array<{ type: string; text: string }>

      return systemBlocks.map((block) => block.text).join('')
    }

    it('returns a non-empty response string and sessionId', async () => {
      setupHappyPath('The elephants are 50m north.')

      const result = await caller.chat.send(sendInput)

      expect(result.response).toBe('The elephants are 50m north.')
      expect(result.sessionId).toBe(SESSION_ID)
      expect(aiUsageEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            venueId: VENUE_ID,
            sessionId: SESSION_ID,
            feature: 'guest-chat',
            surface: 'guest-web',
            inputTokens: 20,
            outputTokens: 10,
            cacheCreationInputTokens: 4,
            cacheReadInputTokens: 3,
            totalTokens: 37,
            success: true,
          }),
        }),
      )
      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'message.sent', sessionId: TOKEN }),
      )
      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'message.received',
          sessionId: TOKEN,
          metadata: expect.objectContaining({
            fallback: false,
            retrievalMode: 'semantic',
            embeddingMs: expect.any(Number),
            retrievalMs: expect.any(Number),
            promptAssemblyMs: expect.any(Number),
            modelMs: expect.any(Number),
            persistenceMs: expect.any(Number),
            totalMs: expect.any(Number),
          }),
        }),
      )
      expect(emitEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'message.fallback' }),
      )
    })

    it('returns a generic 503 without provider or message writes when paused mid-request', async () => {
      setupHappyPath()
      platformConfigFindUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          value: { schemaVersion: 1, paused: true, reason: 'private incident detail' },
          updatedAt: new Date('2026-08-08T20:00:00.000Z'),
          updatedBy: 'admin_1',
        })

      await expect(caller.chat.send(sendInput)).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        message: 'The AI service is temporarily unavailable. Please try again later.',
      })
      expect(anthropicCreate).not.toHaveBeenCalled()
      expect(messageCreate).not.toHaveBeenCalled()
    })

    it('loads only published, started, active, unexpired updates for the next message', async () => {
      setupHappyPath('The Reptile House is closed.')
      operationalUpdateFindMany.mockResolvedValueOnce([
        {
          updateType: 'TEMPORARY_CLOSURE',
          severity: 'CLOSURE',
          priority: 'URGENT',
          title: 'Reptile House closed',
          body: 'Use the west trail.',
          redirectTo: '/west-trail',
          place: { name: 'Reptile House' },
        },
      ])

      await caller.chat.send(sendInput)

      const query = operationalUpdateFindMany.mock.calls[0]?.[0] as {
        where: {
          tenantId: string
          venueId: string
          status: string
          isActive: boolean
          startsAt: { lte: Date }
          expiresAt: { gt: Date }
        }
        orderBy: unknown
        take: number
      }
      expect(query.where).toMatchObject({
        tenantId: TENANT_ID,
        venueId: VENUE_ID,
        status: 'PUBLISHED',
        isActive: true,
      })
      expect(query.where.startsAt.lte).toBe(query.where.expiresAt.gt)
      expect(query.orderBy).toEqual([{ priority: 'desc' }, { startsAt: 'desc' }, { id: 'asc' }])
      expect(query.take).toBe(20)
      expect(getConcatenatedSystemPrompt()).toContain(
        '[URGENT TEMPORARY_CLOSURE CLOSURE] Reptile House closed (affected location: Reptile House)',
      )
    })

    it('returns the provider response when durable usage reporting fails', async () => {
      setupHappyPath('The elephants are nearby.')
      aiUsageEventCreate.mockRejectedValueOnce(new Error('usage database unavailable'))

      await expect(caller.chat.send(sendInput)).resolves.toMatchObject({
        response: 'The elephants are nearby.',
        sessionId: SESSION_ID,
      })
    })

    it('returns the provider response when best-effort analytics reporting fails', async () => {
      setupHappyPath('The elephants are nearby.')
      emitEvent.mockRejectedValue(new Error('analytics database unavailable'))

      await expect(caller.chat.send(sendInput)).resolves.toMatchObject({
        response: 'The elephants are nearby.',
        sessionId: SESSION_ID,
      })
    })

    it('throws NOT_FOUND for non-existent venueId', async () => {
      dbQueryRaw.mockResolvedValueOnce([])

      await expect(caller.chat.send(sendInput)).rejects.toThrowError(
        expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }),
      )
    })

    it('persists user and assistant messages in order', async () => {
      setupHappyPath('Near the entrance.')

      await caller.chat.send(sendInput)

      expect(sessionUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            venueId_anonymousToken: { venueId: VENUE_ID, anonymousToken: TOKEN },
            tenantId: TENANT_ID,
          },
        }),
      )

      expect(messageCreate).toHaveBeenCalledTimes(2)
      expect(messageCreate).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.objectContaining({ role: 'user', content: sendInput.message }),
        }),
      )
      expect(messageCreate).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({ role: 'assistant', content: 'Near the entrance.' }),
        }),
      )
    })

    it('returns fallback string on Claude API failure — does not throw TRPCError', async () => {
      dbQueryRaw.mockResolvedValueOnce([venueRow])
      sessionUpsert.mockResolvedValueOnce({ id: SESSION_ID })
      placeFindMany.mockResolvedValueOnce(placeRows)
      messageFindMany.mockResolvedValueOnce([])
      anthropicCreate.mockRejectedValueOnce(new Error('Claude API unavailable'))
      messageCreate.mockResolvedValue({})

      const result = await caller.chat.send(sendInput)

      expect(result.response).toContain("I'm having trouble right now")
      expect(result.sessionId).toBe(SESSION_ID)
      expect(aiUsageEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            venueId: VENUE_ID,
            sessionId: SESSION_ID,
            feature: 'guest-chat',
            success: false,
            errorCode: 'provider-error',
          }),
        }),
      )
      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'message.fallback',
          sessionId: TOKEN,
          metadata: expect.objectContaining({
            failureStage: 'generation',
            failureCode: 'provider-error',
            totalMs: expect.any(Number),
          }),
        }),
      )
      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'message.received',
          metadata: expect.objectContaining({
            fallback: true,
            failureCode: 'provider-error',
          }),
        }),
      )
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
        usage: { input_tokens: 20, output_tokens: 10 },
      })
      messageCreate.mockResolvedValue({})

      await caller.chat.send(sendInput)

      const callArgs = anthropicCreate.mock.calls[0]?.[0] as AnthropicCreateParams
      // First two messages are history (reversed), third is new user message
      expect(callArgs.messages[0]).toMatchObject({ role: 'user', content: 'First message' })
      expect(callArgs.messages[1]).toMatchObject({ role: 'assistant', content: 'Second message' })
    })

    it('uses cache_control ephemeral only on the static system prompt block', async () => {
      setupHappyPath('ok')

      await caller.chat.send(sendInput)

      const callArgs = anthropicCreate.mock.calls[0]?.[0] as AnthropicCreateParams
      const systemBlocks = callArgs.system as Array<{
        type: string
        text: string
        cache_control?: { type: string }
      }>
      expect(systemBlocks).toHaveLength(2)
      expect(systemBlocks[0]).toMatchObject({
        type: 'text',
        cache_control: { type: 'ephemeral' },
      })
      expect(systemBlocks[1]).toMatchObject({ type: 'text' })
      expect(systemBlocks[1]?.cache_control).toBeUndefined()

      const concatenatedSystemPrompt = `${systemBlocks[0]?.text}${systemBlocks[1]?.text}`
      expect(concatenatedSystemPrompt).toContain('City Zoo')
      expect(concatenatedSystemPrompt).toContain('Elephants')
    })

    it('does not inject an engagement question when the tenant mode is STOIC', async () => {
      setupHappyPath('ok')

      await caller.chat.send(sendInput)

      const callArgs = anthropicCreate.mock.calls[0]?.[0] as AnthropicCreateParams
      const systemBlocks = callArgs.system as Array<{ type: string; text: string }>

      expect(systemBlocks.map((block) => block.text).join('')).not.toContain(
        'Guest engagement moment',
      )
    })

    it('emits an engagement_question.asked event when a question is selected', async () => {
      setupHappyPath('ok')
      tenantFindUnique.mockReset()
      engagementQuestionFindMany.mockReset()
      tenantFindUnique.mockResolvedValueOnce({ engagementMode: 'CURIOUS' })
      engagementQuestionFindMany.mockResolvedValueOnce([
        {
          id: 'question_selected',
          questionType: 'OPEN_ENDED',
          prompt: 'Ask about wayfinding.',
          choiceOptions: [],
          intensity: 5,
        },
      ])
      const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0)

      await caller.chat.send(sendInput)

      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'engagement_question.asked',
          metadata: expect.objectContaining({
            engagementQuestionId: 'question_selected',
            aiInventionAllowed: true,
          }),
        }),
      )
      random.mockRestore()
    })

    it('lets Curious mode offer an invented question when there are no authored questions', async () => {
      setupHappyPath('ok')
      tenantFindUnique.mockReset()
      engagementQuestionFindMany.mockReset()
      tenantFindUnique.mockResolvedValueOnce({ engagementMode: 'CURIOUS' })
      engagementQuestionFindMany.mockResolvedValueOnce([])
      const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0)

      try {
        await caller.chat.send(sendInput)

        const systemPrompt = getConcatenatedSystemPrompt()
        expect(systemPrompt).toContain('Guest engagement moment')
        expect(systemPrompt).not.toContain("Operator's intent")
        expect(emitEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: 'engagement_question.asked',
            metadata: expect.objectContaining({
              engagementQuestionId: null,
              aiInventionAllowed: true,
            }),
          }),
        )
      } finally {
        random.mockRestore()
      }
    })

    it('lets Curious mode offer both an authored question and invention fallback', async () => {
      setupHappyPath('ok')
      tenantFindUnique.mockReset()
      engagementQuestionFindMany.mockReset()
      tenantFindUnique.mockResolvedValueOnce({ engagementMode: 'CURIOUS' })
      engagementQuestionFindMany.mockResolvedValueOnce([
        {
          id: 'question_selected',
          questionType: 'OPEN_ENDED',
          prompt: 'Ask about wayfinding.',
          choiceOptions: [],
          intensity: 5,
        },
      ])
      const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0)

      try {
        await caller.chat.send(sendInput)

        const systemPrompt = getConcatenatedSystemPrompt()
        expect(systemPrompt).toContain("Operator's intent")
        expect(systemPrompt).toContain('your own invention')
        expect(emitEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: 'engagement_question.asked',
            metadata: expect.objectContaining({
              engagementQuestionId: 'question_selected',
              aiInventionAllowed: true,
            }),
          }),
        )
      } finally {
        random.mockRestore()
      }
    })

    it('does not let Balanced mode offer invention', async () => {
      setupHappyPath('ok')
      tenantFindUnique.mockReset()
      engagementQuestionFindMany.mockReset()
      tenantFindUnique.mockResolvedValueOnce({ engagementMode: 'BALANCED' })
      engagementQuestionFindMany.mockResolvedValueOnce([
        {
          id: 'question_selected',
          questionType: 'OPEN_ENDED',
          prompt: 'Ask about wayfinding.',
          choiceOptions: [],
          intensity: 5,
        },
      ])
      const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0)

      try {
        await caller.chat.send(sendInput)

        const systemPrompt = getConcatenatedSystemPrompt()
        expect(systemPrompt).toContain("Operator's intent")
        expect(systemPrompt).not.toContain('your own invention')
        expect(emitEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: 'engagement_question.asked',
            metadata: expect.objectContaining({
              engagementQuestionId: 'question_selected',
              aiInventionAllowed: false,
            }),
          }),
        )
      } finally {
        random.mockRestore()
      }
    })

    it('strips the [[ENGAGEMENT_ASKED]] marker before it reaches the guest or gets persisted', async () => {
      setupHappyPath('ok')
      tenantFindUnique.mockReset()
      engagementQuestionFindMany.mockReset()
      tenantFindUnique.mockResolvedValueOnce({ engagementMode: 'CURIOUS' })
      engagementQuestionFindMany.mockResolvedValueOnce([])
      const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0)
      anthropicCreate.mockReset()
      anthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Some reply.\n[[ENGAGEMENT_ASKED]]' }],
        usage: { input_tokens: 20, output_tokens: 10 },
      })
      messageCreate
        .mockResolvedValueOnce({ id: 'user_msg_1' })
        .mockResolvedValueOnce({ id: 'assistant_msg_1' })

      try {
        const result = await caller.chat.send(sendInput)

        expect(result.response).not.toContain('[[ENGAGEMENT_ASKED]]')
        expect(result.response).toBe('Some reply.')
        expect(messageCreate).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            data: expect.objectContaining({ role: 'assistant', content: 'Some reply.' }),
          }),
        )
      } finally {
        random.mockRestore()
      }
    })

    it('ignores the marker when no engagement question was offered this turn (guards against a hallucinated marker)', async () => {
      setupHappyPath('ok')
      // STOIC (default in beforeEach) never passes the gate, so no question is offered.
      anthropicCreate.mockReset()
      anthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Some reply.\n[[ENGAGEMENT_ASKED]]' }],
        usage: { input_tokens: 20, output_tokens: 10 },
      })
      messageCreate
        .mockResolvedValueOnce({ id: 'user_msg_1' })
        .mockResolvedValueOnce({ id: 'assistant_msg_1' })

      await caller.chat.send(sendInput)

      expect(sessionUpdateMany).not.toHaveBeenCalled()
    })

    it('marks the session pending after a self-reported ask', async () => {
      setupHappyPath('ok')
      tenantFindUnique.mockReset()
      engagementQuestionFindMany.mockReset()
      tenantFindUnique.mockResolvedValueOnce({ engagementMode: 'CURIOUS' })
      engagementQuestionFindMany.mockResolvedValueOnce([
        {
          id: 'question_selected',
          questionType: 'OPEN_ENDED',
          prompt: 'Ask about wayfinding.',
          choiceOptions: [],
          intensity: 5,
        },
      ])
      const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0)
      anthropicCreate.mockReset()
      anthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Some reply.\n[[ENGAGEMENT_ASKED]]' }],
        usage: { input_tokens: 20, output_tokens: 10 },
      })
      messageCreate
        .mockResolvedValueOnce({ id: 'user_msg_1' })
        .mockResolvedValueOnce({ id: 'assistant_msg_1' })

      try {
        await caller.chat.send(sendInput)

        expect(sessionUpdateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: SESSION_ID, tenantId: TENANT_ID },
            data: expect.objectContaining({
              pendingEngagementQuestionId: 'question_selected',
              pendingEngagementAskedMessageId: 'assistant_msg_1',
            }),
          }),
        )
      } finally {
        random.mockRestore()
      }
    })

    it('captures the answer on the following turn from an authored pending question', async () => {
      setupHappyPath('Reply without a marker.')
      sessionUpsert.mockReset()
      sessionUpsert.mockResolvedValueOnce({
        id: SESSION_ID,
        pendingEngagementQuestionId: 'question_prev',
        pendingEngagementIsInvented: false,
        pendingEngagementAskedMessageId: 'assistant_msg_prev',
        pendingEngagementAskedAt: new Date('2026-07-01T00:00:00.000Z'),
      })
      engagementQuestionFindFirst.mockResolvedValueOnce({
        prompt: 'Ask about wayfinding.',
        questionType: 'OPEN_ENDED',
      })
      messageCreate
        .mockResolvedValueOnce({ id: 'user_msg_new' })
        .mockResolvedValueOnce({ id: 'assistant_msg_new' })

      await caller.chat.send(sendInput)

      expect(engagementQuestionResponseCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            engagementQuestionId: 'question_prev',
            isAiInvented: false,
            questionText: 'Ask about wayfinding.',
            askedMessageId: 'assistant_msg_prev',
            answerMessageId: 'user_msg_new',
            answerText: sendInput.message,
          }),
        }),
      )
      expect(sessionUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: SESSION_ID, tenantId: TENANT_ID },
          data: expect.objectContaining({
            pendingEngagementQuestionId: null,
            pendingEngagementAskedMessageId: null,
          }),
        }),
      )
    })

    it('captures the answer to an AI-invented pending question by reading the asked message content', async () => {
      setupHappyPath('Reply without a marker.')
      sessionUpsert.mockReset()
      sessionUpsert.mockResolvedValueOnce({
        id: SESSION_ID,
        pendingEngagementQuestionId: null,
        pendingEngagementIsInvented: true,
        pendingEngagementAskedMessageId: 'assistant_msg_prev',
        pendingEngagementAskedAt: new Date('2026-07-01T00:00:00.000Z'),
      })
      messageFindFirst.mockResolvedValueOnce({
        content: 'What was your favorite part of the visit so far?',
      })
      messageCreate
        .mockResolvedValueOnce({ id: 'user_msg_new' })
        .mockResolvedValueOnce({ id: 'assistant_msg_new' })

      await caller.chat.send(sendInput)

      expect(engagementQuestionFindFirst).not.toHaveBeenCalled()
      expect(messageFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'assistant_msg_prev' }) }),
      )
      expect(engagementQuestionResponseCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            engagementQuestionId: null,
            isAiInvented: true,
            questionText: 'What was your favorite part of the visit so far?',
            answerMessageId: 'user_msg_new',
          }),
        }),
      )
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

  describe('chat.history', () => {
    it('binds both venue and anonymous token before loading messages', async () => {
      dbQueryRaw.mockResolvedValueOnce([{ id: SESSION_ID, venueId: VENUE_ID, tenantId: TENANT_ID }])
      messageFindMany.mockResolvedValueOnce([{ role: 'assistant', content: 'Welcome.' }])

      const result = await caller.chat.history({ venueId: VENUE_ID, anonymousToken: TOKEN })

      expect(dbQueryRaw.mock.calls[0]?.slice(1)).toEqual([VENUE_ID, TOKEN])
      expect(messageFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { sessionId: SESSION_ID, tenantId: TENANT_ID },
        }),
      )
      expect(result).toEqual({ messages: [{ role: 'assistant', content: 'Welcome.' }] })
    })

    it('does not load messages when no venue-scoped session exists', async () => {
      dbQueryRaw.mockResolvedValueOnce([])

      await expect(
        caller.chat.history({ venueId: VENUE_ID, anonymousToken: TOKEN }),
      ).resolves.toEqual({ messages: [] })
      expect(messageFindMany).not.toHaveBeenCalled()
    })
  })
})
