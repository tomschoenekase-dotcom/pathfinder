import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

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
vi.mock('@pathfinder/db', () => ({ searchKnowledgeByEmbedding, searchPlacesByEmbedding }))

// Force an embedding to exist so chat.send takes the semantic branch.
const { generateEmbedding } = vi.hoisted(() => ({ generateEmbedding: vi.fn() }))
vi.mock('../lib/embeddings', () => ({ generateEmbedding }))

// Rate limit always allows in tests.
vi.mock('../lib/rate-limit', () => ({ checkRateLimit: vi.fn().mockResolvedValue(true) }))

import { router } from '../core'
import type { TRPCContext } from '../context'
import { _setAnthropicClientForTesting, chatRouter } from './chat'

const dbQueryRaw = vi.fn()
const sessionUpsert = vi.fn()
const messageFindMany = vi.fn()
const messageCreate = vi.fn()

const mockDb = {
  visitorSession: { upsert: sessionUpsert },
  place: { findMany: vi.fn() },
  message: { findMany: messageFindMany, create: messageCreate },
  operationalUpdate: { findMany: vi.fn().mockResolvedValue([]) },
  $queryRaw: dbQueryRaw,
} as unknown as TRPCContext['db']

const anthropicCreate = vi.fn()
const mockAnthropicClient = { messages: { create: anthropicCreate } } as unknown as Anthropic

const ctx: TRPCContext = {
  db: mockDb,
  headers: new Headers(),
  session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
}

const caller = router({ chat: chatRouter }).createCaller(ctx)

const VENUE_ID = 'cvenueabc123456789012'
const TOKEN = '123e4567-e89b-12d3-a456-426614174000'
const venueRow = { id: VENUE_ID, tenantId: 'tenant_1', name: 'City Zoo', guideMode: 'non_location' }
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
  generateEmbedding.mockResolvedValueOnce([0.1, 0.2, 0.3])
  messageFindMany.mockResolvedValueOnce([])
  searchPlacesByEmbedding.mockResolvedValueOnce(places)
  searchKnowledgeByEmbedding.mockResolvedValueOnce([])
  anthropicCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: reply }] })
  messageCreate.mockResolvedValue({})
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
      metadata: { question: 'Is there a helipad?', score: 0.9 },
    })
  })

  it('flags when retrieval returned no places at all (score null)', async () => {
    setup([], 'Some answer.')

    await caller.chat.send(sendInput)

    const calls = lowConfidenceCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toMatchObject({ metadata: { score: null } })
  })
})
