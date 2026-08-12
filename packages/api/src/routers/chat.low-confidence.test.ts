import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import type { AnthropicMessagesClient } from '@pathfinder/ai'

// Mock config so env validation doesn't fail in the test environment.
vi.mock('@pathfinder/config', () => ({
  env: { ANTHROPIC_API_KEY: 'test-key' },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { emitEvent } = vi.hoisted(() => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@pathfinder/analytics', () => ({ emitEvent }))

// Drive the semantic retrieval path with controllable distances.
const { searchKnowledgeByEmbedding, searchPlacesByEmbedding } = vi.hoisted(() => ({
  searchKnowledgeByEmbedding: vi.fn(),
  searchPlacesByEmbedding: vi.fn(),
}))
const guestTurnActions = vi.hoisted(() => ({
  reserve: vi.fn(),
  claim: vi.fn(),
  dispatch: vi.fn(),
  observe: vi.fn(),
  fail: vi.fn(),
  finalize: vi.fn(),
}))
vi.mock('@pathfinder/db', () => ({
  GuestChatTurnActionError: class GuestChatTurnActionError extends Error {},
  assertGlobalAiAvailable: vi.fn().mockResolvedValue(undefined),
  assertVenueAiAvailable: vi.fn().mockResolvedValue(undefined),
  isAiAdmissionControlError: (error: unknown) =>
    error instanceof Error &&
    ['GlobalAiAdmissionError', 'VenueUnavailableError', 'AiCostBudgetExceededError'].includes(
      error.name,
    ),
  reserveAiCostAttempt: vi.fn().mockResolvedValue(null),
  markAiCostAttemptDispatched: vi.fn(),
  settleAiCostAttemptExact: vi.fn(),
  settleAiCostAttemptAmbiguous: vi.fn(),
  releaseUndispatchedAiCostAttempt: vi.fn(),
  searchKnowledgeByEmbedding,
  searchPlacesByEmbedding,
  reserveGuestChatTurnAction: guestTurnActions.reserve,
  claimGuestChatTurnAction: guestTurnActions.claim,
  markGuestChatProviderDispatchedAction: guestTurnActions.dispatch,
  observeGuestChatProviderOperationAction: guestTurnActions.observe,
  failGuestChatTurnAction: guestTurnActions.fail,
  finalizeGuestChatTurnAction: guestTurnActions.finalize,
}))

// Force an embedding to exist so chat.send takes the semantic branch.
const { generateEmbedding } = vi.hoisted(() => ({ generateEmbedding: vi.fn() }))
vi.mock('../lib/guest-query-embedding', () => ({ generateGuestQueryEmbedding: generateEmbedding }))

// Rate limit always allows in tests.
vi.mock('../lib/rate-limit', () => ({ checkRateLimit: vi.fn().mockResolvedValue(true) }))

import { router } from '../core'
import type { TRPCContext } from '../context'
import { _setAnthropicClientForTesting, chatRouter } from './chat'

const dbQueryRaw = vi.fn()
const sessionUpsert = vi.fn()
const messageFindMany = vi.fn()
const messageCreate = vi.fn()
const tenantFindUnique = vi.fn()
const engagementQuestionFindMany = vi.fn()
const aiUsageEventCreate = vi.fn().mockResolvedValue({})

const mockDb = {
  visitorSession: { upsert: sessionUpsert },
  tenant: { findUnique: tenantFindUnique },
  engagementQuestion: { findMany: engagementQuestionFindMany },
  aiUsageEvent: { create: aiUsageEventCreate },
  place: { findMany: vi.fn() },
  message: { findMany: messageFindMany, create: messageCreate },
  operationalUpdate: { findMany: vi.fn().mockResolvedValue([]) },
  $queryRaw: dbQueryRaw,
} as unknown as TRPCContext['db']

const anthropicCreate = vi.fn()
const mockAnthropicClient = { messages: { create: anthropicCreate } } as AnthropicMessagesClient

const ctx: TRPCContext = {
  db: mockDb,
  headers: new Headers(),
  session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
}

const caller = router({ chat: chatRouter }).createCaller(ctx)

const VENUE_ID = 'cvenueabc123456789012'
const TOKEN = '123e4567-e89b-12d3-a456-426614174000'
const venueRow = {
  id: VENUE_ID,
  tenantId: 'tenant_1',
  name: 'City Zoo',
  guideMode: 'non_location',
  isActive: true,
}
const sendInput = { venueId: VENUE_ID, anonymousToken: TOKEN, message: 'Is there a helipad?' }

function place(distance: number) {
  return {
    id: 'p1',
    name: 'Elephants',
    type: 'attraction',
    itemType: null,
    shortDescription: null,
    longDescription: null,
    lat: null,
    lng: null,
    tags: [],
    areaName: null,
    hours: null,
    photoUrl: null,
    distance,
  }
}

function setup(places: ReturnType<typeof place>[], reply: string) {
  dbQueryRaw.mockResolvedValueOnce([venueRow])
  sessionUpsert.mockResolvedValueOnce({ id: 'sess_1' })
  generateEmbedding.mockImplementationOnce(async (...args: unknown[]) => {
    await (args[5] as (() => Promise<void>) | undefined)?.()
    return [0.1, 0.2, 0.3]
  })
  messageFindMany.mockResolvedValueOnce([])
  searchPlacesByEmbedding.mockResolvedValueOnce(places)
  searchKnowledgeByEmbedding.mockResolvedValueOnce([])
  tenantFindUnique.mockResolvedValueOnce({ engagementMode: 'STOIC' })
  engagementQuestionFindMany.mockResolvedValueOnce([])
  anthropicCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text: reply }],
    usage: { input_tokens: 20, output_tokens: 10 },
  })
  messageCreate.mockResolvedValue({})
  guestTurnActions.reserve.mockResolvedValue({
    state: 'RESERVED',
    turnId: '11111111-1111-4111-8111-111111111111',
    sessionId: 'sess_1',
    replayed: false,
  })
  guestTurnActions.claim.mockResolvedValue({
    state: 'GENERATING',
    turnId: '11111111-1111-4111-8111-111111111111',
    sessionId: 'sess_1',
    claimId: '22222222-2222-4222-8222-222222222222',
    providerOperations: [
      { kind: 'QUERY_EMBEDDING', invocationId: '33333333-3333-4333-8333-333333333333' },
      { kind: 'RESPONSE_GENERATION', invocationId: '44444444-4444-4444-8444-444444444444' },
    ],
    replayed: false,
  })
  guestTurnActions.dispatch.mockResolvedValue({ dispatched: true })
  guestTurnActions.observe.mockResolvedValue({ observed: true })
  guestTurnActions.finalize.mockImplementation(async ({ input }) => ({
    state: 'COMPLETE',
    turnId: input.turnId,
    sessionId: 'sess_1',
    userMessageId: '55555555-5555-4555-8555-555555555555',
    response: input.assistantResponse,
    places: input.replayMetadata.places,
    replayed: false,
  }))
}

function lowConfidenceCalls() {
  return emitEvent.mock.calls.filter(
    (call) => (call[0] as { eventType?: string }).eventType === 'message.low_confidence',
  )
}

describe('chat.send low-confidence flag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _setAnthropicClientForTesting(mockAnthropicClient)
  })

  afterEach(() => {
    _setAnthropicClientForTesting(null)
  })

  it('does NOT flag when the best place is semantically close', async () => {
    setup([place(0.1)], 'Yes, the elephants are right here.')

    await caller.chat.send(sendInput)

    expect(lowConfidenceCalls()).toHaveLength(0)
  })

  it('flags when the best place is semantically far, with the distance as score', async () => {
    setup([place(0.9)], 'Confidently worded answer that names nothing in particular.')

    await caller.chat.send(sendInput)

    const calls = lowConfidenceCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toMatchObject({
      eventType: 'message.low_confidence',
      userMessageId: '55555555-5555-4555-8555-555555555555',
      metadata: { questionLength: 19, score: 0.9 },
    })
  })

  it('attributes guest query embedding usage to the resolved tenant, venue, and session', async () => {
    setup([place(0.1)], 'The elephants are nearby.')
    generateEmbedding.mockReset()
    generateEmbedding.mockImplementationOnce(
      async (
        _text: string,
        sink: (usage: {
          provider: 'openai'
          model: string
          pricingVersion: string
          usage: {
            inputTokens: number
            outputTokens: number
            cacheCreationInputTokens: number
            cacheReadInputTokens: number
          }
          estimatedCostUsd: number
          latencyMs: number
          attempts: number
          success: boolean
        }) => Promise<void>,
        _guard?: unknown,
        _budget?: unknown,
        _invocation?: string,
        onDispatch?: () => Promise<void>,
      ) => {
        await sink({
          provider: 'openai',
          model: 'text-embedding-3-small',
          pricingVersion: 'openai-public-2026-08-07',
          usage: {
            inputTokens: 25,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          estimatedCostUsd: 0.0000005,
          latencyMs: 12,
          attempts: 1,
          success: true,
        })
        await onDispatch?.()
        return [0.1, 0.2, 0.3]
      },
    )

    await caller.chat.send(sendInput)

    expect(aiUsageEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant_1',
          venueId: VENUE_ID,
          sessionId: 'sess_1',
          feature: 'guest-chat-query-embedding',
          surface: 'guest-web',
          provider: 'openai',
          model: 'text-embedding-3-small',
          inputTokens: 25,
          totalTokens: 25,
          success: true,
        }),
      }),
    )
  })

  it('records embedding failure and preserves the guest geo fallback', async () => {
    setup([], 'I do not have that information.')
    generateEmbedding.mockReset()
    generateEmbedding.mockImplementationOnce(
      async (
        _text: string,
        sink: (usage: {
          provider: 'openai'
          model: string
          pricingVersion: string
          usage: {
            inputTokens: number
            outputTokens: number
            cacheCreationInputTokens: number
            cacheReadInputTokens: number
          }
          estimatedCostUsd: number
          latencyMs: number
          attempts: number
          success: boolean
          errorCode: string
        }) => Promise<void>,
        _guard?: unknown,
        _budget?: unknown,
        _invocation?: string,
        onDispatch?: () => Promise<void>,
      ) => {
        await sink({
          provider: 'openai',
          model: 'text-embedding-3-small',
          pricingVersion: 'openai-public-2026-08-07',
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          estimatedCostUsd: 0,
          latencyMs: 10_000,
          attempts: 2,
          success: false,
          errorCode: 'provider-http-503',
        })
        await onDispatch?.()
        throw new Error('embedding unavailable')
      },
    )
    ;(mockDb.place.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([])

    await expect(caller.chat.send(sendInput)).resolves.toMatchObject({
      response: 'I do not have that information.',
    })

    expect(aiUsageEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          feature: 'guest-chat-query-embedding',
          provider: 'openai',
          success: false,
          errorCode: 'provider-http-503',
          attempts: 2,
        }),
      }),
    )
  })

  it('flags when retrieval returned no places at all (score null)', async () => {
    setup([], 'Some answer.')

    await caller.chat.send(sendInput)

    const calls = lowConfidenceCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toMatchObject({ metadata: { score: null } })
  })
})
