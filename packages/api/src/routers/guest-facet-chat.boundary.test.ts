import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { loadGuestVenueDirectory } from '../lib/guest-venue-directory'
import { guestDirectoryVersion } from '../lib/guest-directory-index-loader'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guestReplyKindFromFallbackCode } from '@pathfinder/contracts/guest-reply-kind'

import {
  setOpenAiEmbeddingsClientForTesting,
  setOpenAiResponsesClientForTesting,
  type AnthropicCreateParams,
  type AnthropicMessagesClient,
  type OpenAiEmbeddingsClient,
} from '@pathfinder/ai'

const venueRenderings = vi.hoisted(
  () =>
    [] as Array<{
      staticPart: string
      dynamicPart: string
      recordContext: { chars: number; fullBodyKeys: string[] }
      guideFullBodyKeys: string[]
    }>,
)
vi.mock('../lib/venue-context', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/venue-context')>()
  return {
    ...original,
    buildVenueSystemPromptParts: (
      ...args: Parameters<typeof original.buildVenueSystemPromptParts>
    ) => {
      const rendered = original.buildVenueSystemPromptParts(...args)
      venueRenderings.push({
        ...rendered,
        guideFullBodyKeys: [...(args[0].venueGuideRecordIds ?? [])],
      })
      return rendered
    },
  }
})
// Add at module scope beside the venue-context transparent observer.
const facetInputs = vi.hoisted(
  () => [] as Array<{ knowledge: Array<{ id: string }>; places: Array<{ id: string }> }>,
)
vi.mock('../lib/guest-facet-integration', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/guest-facet-integration')>()
  return {
    ...original,
    selectGuestFacetCollection: (
      ...args: Parameters<typeof original.selectGuestFacetCollection>
    ) => {
      // Snapshot membership only; do not change arguments, return value or call count.
      facetInputs.push({
        knowledge: args[0].directory.knowledge.map(({ id }) => ({ id })),
        places: args[0].directory.places.map(({ id }) => ({ id })),
      })
      return original.selectGuestFacetCollection(...args)
    },
  }
})

const configLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))

// Mock @pathfinder/config so env validation doesn't fail in the test environment
vi.mock('@pathfinder/config', () => ({
  env: { ANTHROPIC_API_KEY: 'test-key' },
  logger: configLogger,
}))

const { emitEvent } = vi.hoisted(() => ({
  emitEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@pathfinder/analytics', () => ({
  emitEvent,
}))

const { checkRateLimit, checkRateLimitsOrdered } = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  checkRateLimitsOrdered: vi.fn(),
}))

vi.mock('../lib/rate-limit', () => ({ checkRateLimit, checkRateLimitsOrdered }))

const readApprovedGuestPlaceMedia = vi.hoisted(() => vi.fn())
vi.mock('../lib/guest-place-media', () => ({ readApprovedGuestPlaceMedia }))

const searchGuestWebWithAccounting = vi.hoisted(() => vi.fn())
vi.mock('@pathfinder/ai/guest-web-search-accounting', () => ({ searchGuestWebWithAccounting }))

const coverageReadControls = vi.hoisted(() => ({ fail: false, mismatch: false, projections: 0 }))
const fixtureDirectory = vi.hoisted(() => ({
  knowledge: [] as Array<Record<string, unknown>>,
  places: [] as Array<Record<string, unknown>>,
  incomplete: false,
  searchVersion: 'independent-stale-directory',
}))
vi.mock('../lib/guest-venue-directory', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/guest-venue-directory')>()
  return { ...original, loadGuestVenueDirectoryCached: vi.fn(async () => fixtureDirectory) }
})
const adoptionFindMany = vi.hoisted(() => vi.fn())
const semanticSearch = vi.hoisted(() => ({ places: vi.fn(), knowledge: vi.fn() }))
const guestTurnActions = vi.hoisted(() => ({
  reserve: vi.fn(),
  claim: vi.fn(),
  dispatch: vi.fn(),
  skip: vi.fn(),
  observe: vi.fn(),
  fail: vi.fn(),
  finalize: vi.fn(),
  readAdjacentIdentity: vi.fn(),
}))
const resolvePublishedUniversalContent = vi.hoisted(() => vi.fn())
const resolveNativeGuestReadSnapshotAction = vi.hoisted(() => vi.fn())
const readActiveUnhealthyAiProviders = vi.hoisted(() => vi.fn())
const isGuestConversationDisposed = vi.hoisted(() => vi.fn())
const resolveSystemCharacterProjection = vi.hoisted(() => vi.fn())
const recordConversationLearningCandidate = vi.hoisted(() => vi.fn())
vi.mock('../lib/character-registry', () => ({ resolveSystemCharacterProjection }))
vi.mock('@pathfinder/db', async (importOriginal) => {
  const originalDb = await importOriginal<typeof import('@pathfinder/db')>()
  return {
    ...originalDb,
    applyNativeGuestContentRead: (
      input: Parameters<typeof import('@pathfinder/db').applyNativeGuestContentRead>[0],
    ) => {
      const original = originalDb.applyNativeGuestContentRead(input)
      coverageReadControls.projections += 1
      return coverageReadControls.mismatch && coverageReadControls.projections === 2
        ? { ...original, path: 'NATIVE' as const }
        : original
    },
    searchPlacesByEmbedding: semanticSearch.places,
    searchKnowledgeByEmbedding: semanticSearch.knowledge,
    reserveGuestChatTurnAction: guestTurnActions.reserve,
    claimGuestChatTurnAction: guestTurnActions.claim,
    markGuestChatProviderDispatchedAction: guestTurnActions.dispatch,
    skipGuestChatProviderOperationAction: guestTurnActions.skip,
    observeGuestChatProviderOperationAction: guestTurnActions.observe,
    failGuestChatTurnAction: guestTurnActions.fail,
    finalizeGuestChatTurnAction: guestTurnActions.finalize,
    readAdjacentGuestPlaceIdentityPendingAction: guestTurnActions.readAdjacentIdentity,
    resolveEffectivePublishedUniversalContent: resolvePublishedUniversalContent,
    resolveNativeGuestReadSnapshotAction,
    readActiveUnhealthyAiProviders,
    isGuestConversationDisposed,
    recordConversationLearningCandidate,
  }
})

import { router } from '../core'
import type { TRPCContext } from '../context'
import { _setAnthropicClientForTesting, chatRouter } from './chat'

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

const dbQueryRaw = vi.fn()
const sessionUpsert = vi.fn()
const sessionFindFirst = vi.fn()
const sessionUpdateMany = vi.fn().mockResolvedValue({ count: 1 })
const placeFindMany = vi.fn()
const placeFindFirst = vi.fn()
const venueLocationFindMany = vi.fn()
const messageFindMany = vi.fn()
const voiceTranscriptSegmentFindMany = vi.fn()
const messageCreate = vi.fn()
const messageFindFirst = vi.fn()
const guestChatTurnFindFirst = vi.fn()
const tenantFindUnique = vi.fn()
const engagementQuestionFindMany = vi.fn()
const engagementQuestionFindFirst = vi.fn()
const engagementQuestionResponseCreate = vi.fn().mockResolvedValue({})
const aiUsageEventCreate = vi.fn().mockResolvedValue({})
const platformConfigFindUnique = vi.fn()
const aiWorkloadConfigurationOverrideFindFirst = vi.fn()
const aiScopedWorkloadConfigurationOverrideFindFirst = vi.fn()
const aiCostBudgetFindFirst = vi.fn()
const operationalEventUpsert = vi.fn()
const venueFindFirst = vi.fn()
const venueFindMany = vi.fn()
const tenantFeatureFlagFindMany = vi.fn()
const tenantFeatureFlagFindUnique = vi.fn()
const venueKnowledgeEntryFindMany = vi.fn()
const dbTransaction = vi.fn()
const recommendationPolicyFindFirst = vi.fn()
const catalogItemFindMany = vi.fn()
const catalogPriorityFindMany = vi.fn()
const analyticsEventFindMany = vi.fn()

const operationalUpdateFindMany = vi.fn().mockResolvedValue([])

const liveDataConnectorFindMany = vi.hoisted(() => vi.fn())

const mockDb = {
  liveDataConnector: { findMany: liveDataConnectorFindMany },
  platformConfig: { findUnique: platformConfigFindUnique },
  aiWorkloadConfigurationOverride: { findFirst: aiWorkloadConfigurationOverrideFindFirst },
  aiScopedWorkloadConfigurationOverride: {
    findFirst: aiScopedWorkloadConfigurationOverrideFindFirst,
  },
  venue: { findFirst: venueFindFirst, findMany: venueFindMany },
  tenantFeatureFlag: {
    findMany: tenantFeatureFlagFindMany,
    findUnique: tenantFeatureFlagFindUnique,
  },
  visitorSession: {
    upsert: sessionUpsert,
    updateMany: sessionUpdateMany,
    findFirst: sessionFindFirst,
  },
  tenant: { findUnique: tenantFindUnique },
  engagementQuestion: {
    findMany: engagementQuestionFindMany,
    findFirst: engagementQuestionFindFirst,
  },
  engagementQuestionResponse: { create: engagementQuestionResponseCreate },
  aiUsageEvent: { create: aiUsageEventCreate },
  aiCostBudget: { findFirst: aiCostBudgetFindFirst },
  aiCostReservation: {},
  operationalEvent: { upsert: operationalEventUpsert },
  place: { findMany: placeFindMany, findFirst: placeFindFirst },
  venueLocation: { findMany: venueLocationFindMany },
  message: { findMany: messageFindMany, create: messageCreate, findFirst: messageFindFirst },
  voiceTranscriptSegment: { findMany: voiceTranscriptSegmentFindMany },
  guestChatTurn: { findFirst: guestChatTurnFindFirst },
  operationalUpdate: { findMany: operationalUpdateFindMany },
  venueKnowledgeEntry: { findMany: venueKnowledgeEntryFindMany },
  legacyKnowledgeAdoptionActivation: { findMany: adoptionFindMany },
  venueRecommendationPolicy: { findFirst: recommendationPolicyFindFirst },
  venueCatalogItem: { findMany: catalogItemFindMany },
  venueCatalogItemPriority: { findMany: catalogPriorityFindMany },
  analyticsEvent: { findMany: analyticsEventFindMany },
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
  isActive: true,
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

describe('facet actual chat independent boundaries', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    Object.assign(coverageReadControls, { fail: false, mismatch: false, projections: 0 })
    _setAnthropicClientForTesting(mockAnthropicClient)
    setOpenAiEmbeddingsClientForTesting(mockOpenAiClient)
    embeddingCreate.mockResolvedValue({
      data: [{ embedding: Array.from({ length: 1_536 }, () => 0.1), index: 0 }],
      usage: { prompt_tokens: 5, total_tokens: 5 },
    })
    semanticSearch.places.mockResolvedValue(placeRows)
    semanticSearch.knowledge.mockResolvedValue([])
    // Lexical place recall shares this delegate; tests queue explicit rows where they matter.
    placeFindMany.mockResolvedValue([])
    venueKnowledgeEntryFindMany.mockResolvedValue([])
    operationalUpdateFindMany.mockResolvedValue([])
    venueLocationFindMany.mockResolvedValue([])
    resolvePublishedUniversalContent.mockResolvedValue([])
    resolveNativeGuestReadSnapshotAction.mockResolvedValue({
      path: 'LEGACY',
      reason: 'SERVER_DISABLED',
      releaseId: null,
      state: null,
    })
    readActiveUnhealthyAiProviders.mockResolvedValue([])
    isGuestConversationDisposed.mockResolvedValue(false)
    tenantFindUnique.mockResolvedValue({ engagementMode: 'STOIC' })
    engagementQuestionFindMany.mockResolvedValue([])
    sessionUpdateMany.mockResolvedValue({ count: 1 })
    engagementQuestionResponseCreate.mockResolvedValue({})
    aiUsageEventCreate.mockResolvedValue({})
    platformConfigFindUnique.mockResolvedValue(null)
    aiWorkloadConfigurationOverrideFindFirst.mockResolvedValue(null)
    aiScopedWorkloadConfigurationOverrideFindFirst.mockResolvedValue(null)
    aiCostBudgetFindFirst.mockResolvedValue(null)
    operationalEventUpsert.mockResolvedValue({ id: 'event_1', state: 'OPEN', occurrenceCount: 1 })
    venueFindFirst.mockResolvedValue({ isActive: true })
    venueFindMany.mockResolvedValue([])
    resolveSystemCharacterProjection.mockReturnValue(null)
    tenantFeatureFlagFindMany.mockResolvedValue([])
    voiceTranscriptSegmentFindMany.mockResolvedValue([])
    sessionFindFirst.mockResolvedValue({ id: SESSION_ID, experienceScope: 'PUBLIC' })
    dbTransaction.mockImplementation((callback: (client: typeof mockDb) => unknown) =>
      callback(mockDb),
    )
    guestTurnActions.reserve.mockImplementation(async () => {
      const prior = await sessionUpsert({
        where: {
          venueId_anonymousToken: { venueId: VENUE_ID, anonymousToken: TOKEN },
          tenantId: TENANT_ID,
        },
        create: { tenantId: TENANT_ID, venueId: VENUE_ID },
      })
      return {
        state: 'RESERVED',
        turnId: '11111111-1111-4111-8111-111111111111',
        sessionId: prior?.id ?? SESSION_ID,
        replayed: false,
      }
    })
    guestTurnActions.claim.mockResolvedValue({
      state: 'GENERATING',
      turnId: '11111111-1111-4111-8111-111111111111',
      turnSequence: 2,
      sessionId: SESSION_ID,
      claimId: '22222222-2222-4222-8222-222222222222',
      providerOperations: [
        { kind: 'QUERY_EMBEDDING', invocationId: '33333333-3333-4333-8333-333333333333' },
        { kind: 'RESPONSE_GENERATION', invocationId: '44444444-4444-4444-8444-444444444444' },
      ],
      replayed: false,
    })
    guestTurnActions.dispatch.mockResolvedValue({ dispatched: true })
    guestTurnActions.skip.mockResolvedValue({ skipped: true })
    guestTurnActions.observe.mockResolvedValue({ observed: true })
    guestTurnActions.fail.mockResolvedValue({ failed: true })
    guestTurnActions.readAdjacentIdentity.mockResolvedValue(null)
    guestTurnActions.finalize.mockImplementation(async ({ input }) => {
      await messageCreate({ data: { role: 'user', content: input.message } })
      await messageCreate({ data: { role: 'assistant', content: input.assistantResponse } })
      return {
        state: 'COMPLETE',
        turnId: input.turnId,
        sessionId: SESSION_ID,
        userMessageId: '55555555-5555-4555-8555-555555555555',
        response: input.assistantResponse,
        replyKind: guestReplyKindFromFallbackCode(input.fallbackCode),
        places: input.replayMetadata.places,
        citations: input.replayMetadata.citations,
        actionPlacements: input.replayMetadata.actionPlacements,
        replayed: false,
      }
    })
    checkRateLimit.mockResolvedValue(true)
    checkRateLimitsOrdered.mockResolvedValue(0)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    _setAnthropicClientForTesting(null)
    setOpenAiEmbeddingsClientForTesting(null)
    setOpenAiResponsesClientForTesting(null)
  })

  const oldBody =
    'Hours: Orchid Museum, 12 pm - 6 pm Saturday\nOLD_POLICY_SENTINEL: children need an adult.'
  function topic(content = oldBody) {
    return {
      id: 'independent-hours',
      title: 'Opening hours',
      category: 'hours',
      content,
      sourceType: 'MANUAL',
      sourceName: 'Synthetic source',
      sourceUrl: null,
      updatedAt: new Date('2026-10-01'),
      lastReviewedAt: null,
      contentModuleId: null,
      contentRevisionId: null,
      contentPublicationId: null,
    }
  }
  const input = { venueId: VENUE_ID, anonymousToken: TOKEN, message: 'What are the opening hours?' }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-17T14:00:00Z'))
    fixtureDirectory.knowledge = [topic()]
    fixtureDirectory.incomplete = false
    semanticSearch.places.mockResolvedValue([])
    semanticSearch.knowledge.mockResolvedValue([{ ...topic(), distance: 0.1 }])
    vi.stubEnv('GUEST_GUIDE_STRATEGY', 'evidence')
    dbQueryRaw.mockResolvedValue([
      { ...venueRow, name: 'Orchid Museum', chatAppearance: { timeZone: 'America/Chicago' } },
    ])
    sessionUpsert.mockResolvedValue({ id: SESSION_ID, experienceScope: 'PUBLIC' })
    messageFindMany.mockResolvedValue([])
    messageCreate.mockResolvedValue({})
    anthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Please check the current schedule.' }],
      usage: { input_tokens: 20, output_tokens: 10 },
    })
  })
  afterEach(() => vi.useRealTimers())
  function prompt() {
    expect(anthropicCreate).toHaveBeenCalledOnce()
    const call = anthropicCreate.mock.calls[0]![0] as AnthropicCreateParams
    return (call.system as Array<{ text: string }>).map((block) => block.text).join('')
  }

  type Row = Record<string, unknown> & { id: string }
  const marker = (id: string) => `WHOLE_BODY_${id}_END`
  function rideTopic(
    id: string,
    body = `${marker(id)} Kind: ride; Minimum age: 5 years; Minimum height: 100 cm; Adult accompaniment: required.`,
  ): Row {
    return {
      ...topic(body),
      id,
      title: `Ride specimen ${id}`,
      category: 'RIDES',
      tenantId: TENANT_ID,
      venueId: VENUE_ID,
      isEnabled: true,
      visibility: 'PUBLIC',
    }
  }
  function ridePlace(
    id: string,
    body = `${marker(id)} Kind: ride; Minimum height: 100 cm. Staff supervise boarding.`,
  ): Row {
    return {
      id,
      tenantId: TENANT_ID,
      venueId: VENUE_ID,
      isActive: true,
      visibility: 'PUBLIC',
      name: `Ride place ${id}`,
      type: 'attraction',
      itemType: 'ride',
      shortDescription: null,
      longDescription: body,
      lat: 0,
      lng: 0,
      tags: [],
      areaName: null,
      hours: null,
      photoUrl: null,
      sourceType: 'MANUAL',
      sourceName: null,
      sourceUrl: null,
      updatedAt: new Date('2026-10-01'),
    }
  }
  const fixture = {
    knowledge: [] as Row[],
    places: [] as Row[],
    liveKnowledge: [] as Row[],
    livePlaces: [] as Row[],
    lexicalKnowledge: [] as Row[],
    onHydrate: undefined as (() => void) | undefined,
    strict: false,
    activatedIds: [] as string[],
    failMetadata: false,
    failHydration: false,
    onKnowledgeHydrate: undefined as ((ids: string[]) => void) | undefined,
  }
  beforeEach(() => {
    venueRenderings.length = 0
    facetInputs.length = 0
    Object.assign(fixture, {
      knowledge: [],
      places: [],
      liveKnowledge: [],
      livePlaces: [],
      lexicalKnowledge: [],
      onHydrate: undefined,
      onKnowledgeHydrate: undefined,
      strict: false,
      activatedIds: [],
      failMetadata: false,
      failHydration: false,
    })
    fixtureDirectory.knowledge = []
    fixtureDirectory.places = []
    fixtureDirectory.searchVersion = ''
    fixtureDirectory.incomplete = false
    semanticSearch.knowledge.mockResolvedValue([])
    placeFindMany.mockImplementation(async (args) => read('places', args))
    venueKnowledgeEntryFindMany.mockImplementation(async (args) => read('knowledge', args))
    placeFindFirst.mockImplementation(
      async (args) =>
        fixture.livePlaces.find((row) =>
          fixture.strict ? strictMatches(row, args.where) : row.id === args.where.id,
        ) ?? null,
    )
    adoptionFindMany.mockImplementation(async (args) => {
      expect(args.where).toEqual({ tenantId: TENANT_ID, venueId: VENUE_ID })
      return fixture.activatedIds.map((id) => ({ adoption: { legacyKnowledgeEntryId: id } }))
    })
  })
  function strictMatches(actual: unknown, condition: unknown): boolean {
    if (condition === null || typeof condition !== 'object') return (actual ?? null) === condition
    const value = actual as Record<string, unknown> | null
    return Object.entries(condition).every(([key, expected]) => {
      if (key === 'AND')
        return (Array.isArray(expected) ? expected : [expected]).every((part) =>
          strictMatches(actual, part),
        )
      if (key === 'OR') return (expected as unknown[]).some((part) => strictMatches(actual, part))
      if (key === 'NOT') return !strictMatches(actual, expected)
      if (key === 'is' || key === 'equals') return strictMatches(actual, expected)
      if (key === 'not') return !strictMatches(actual, expected)
      if (key === 'in') return (expected as unknown[]).includes(actual)
      if (key === 'gt') return (actual as number) > (expected as number)
      if (key === 'lte') return (actual as number) <= (expected as number)
      if (key === 'startsWith')
        return typeof actual === 'string' && actual.startsWith(expected as string)
      if (key === 'contains')
        return (
          typeof actual === 'string' &&
          actual.toLowerCase().includes((expected as string).toLowerCase())
        )
      if (key === 'mode') {
        expect(expected).toBe('insensitive')
        return true
      }
      const allowed = new Set([
        'id',
        'tenantId',
        'venueId',
        'isActive',
        'isEnabled',
        'visibility',
        'sourceType',
        'contentModuleId',
        'contentRevisionId',
        'contentPublicationId',
        'contentPublication',
        'action',
        'contentRevision',
        'audience',
        'effectiveFrom',
        'effectiveUntil',
        'kind',
        'operationalFact',
        'expiresAt',
        'universalContentAdoption',
        'activation',
        'createdBy',
        'title',
        'category',
        'content',
        'name',
        'type',
        'itemType',
        'shortDescription',
        'longDescription',
        'tags',
        'has',
        'hasSome',
      ])
      if (!allowed.has(key)) throw new Error(`Unsupported strict predicate: ${key}`)
      if (key === 'has') return Array.isArray(actual) && actual.includes(expected)
      if (key === 'hasSome')
        return (
          Array.isArray(actual) && (expected as unknown[]).some((item) => actual.includes(item))
        )
      return strictMatches(value?.[key] ?? null, expected)
    })
  }
  function read(kind: 'knowledge' | 'places', args: Record<string, unknown>) {
    if (fixture.strict) {
      const where = args.where as Record<string, unknown>
      expect(where.tenantId).toBe(TENANT_ID)
      expect(where.venueId).toBe(VENUE_ID)
      expect(where.visibility).toBe('PUBLIC')
      expect(where[kind === 'places' ? 'isActive' : 'isEnabled']).toBe(true)
      const pool = kind === 'knowledge' ? fixture.liveKnowledge : fixture.livePlaces
      return pool
        .filter((row) => strictMatches(row, where))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, args.take as number | undefined)
    }
    const where = args.where as {
      id?: { in?: string[]; gt?: string }
      tenantId?: string
      venueId?: string
    }
    const select = args.select as Record<string, unknown>
    const metadata = kind === 'knowledge' ? select?.content !== true : select?.name !== true
    if (metadata) {
      if (fixture.failMetadata) throw new Error('synthetic metadata unavailable')
      return fixture[kind]
        .filter(
          (row) =>
            (!where.id?.gt || row.id > where.id.gt) &&
            row.tenantId === where.tenantId &&
            row.venueId === where.venueId,
        )
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, args.take as number)
    }
    if (where.id?.in) {
      if (fixture.failHydration) throw new Error('synthetic hydration unavailable')
      // Existing semantic retrieval's independent authority check is not the collection hydrate.
      if (kind === 'knowledge' && args.take === 20 && fixture.lexicalKnowledge.length)
        return fixture.lexicalKnowledge.filter((row) => where.id!.in!.includes(row.id))
      if (kind === 'knowledge') fixture.onKnowledgeHydrate?.(where.id.in)
      fixture.onHydrate?.()
      return (kind === 'knowledge' ? fixture.liveKnowledge : fixture.livePlaces).filter((row) =>
        where.id!.in!.includes(row.id),
      )
    }
    return kind === 'knowledge' ? fixture.lexicalKnowledge : []
  }
  async function install(knowledge: Row[], places: Row[] = []) {
    fixture.knowledge = knowledge
    fixture.places = places
    fixture.liveKnowledge = knowledge.map((row) => ({ ...row }))
    fixture.livePlaces = places.map((row) => ({ ...row }))
    fixtureDirectory.knowledge = knowledge
    fixtureDirectory.places = places
    const version = await guestDirectoryVersion({
      reader: mockDb,
      tenantId: TENANT_ID,
      venueId: VENUE_ID,
      includeSecondLayer: false,
      asOf: new Date(),
    })
    fixtureDirectory.searchVersion = `independent-scoped-version:${version}`
    placeFindMany.mockClear()
    venueKnowledgeEntryFindMany.mockClear()
  }
  function finalEvidence() {
    expect(guestTurnActions.finalize).toHaveBeenCalledOnce()
    return guestTurnActions.finalize.mock.calls[0]![0].input.replayMetadata.answerEvidence as {
      system: { staticPart: string; dynamicPart: string }
      sources: Array<{ sourceId: string; kind: string; snapshot: string }>
    }
  }
  function retainedBodyKeys() {
    return finalEvidence()
      .sources.filter((source) => source.kind === 'PLACE' || source.kind === 'KNOWLEDGE')
      .map((source) => source.sourceId)
      .sort()
  }
  function finalRecordRendering() {
    const dynamic = finalEvidence().system.dynamicPart
    const final = venueRenderings
      .filter((rendered) => dynamic.startsWith(rendered.dynamicPart))
      .at(-1)
    expect(final, 'actual final provider prompt must originate in measured renderer').toBeDefined()
    return final!
  }
  function assertBodyBudgetAndTypedIdentity() {
    const rendered = finalRecordRendering()
    expect(rendered.recordContext.chars).toBeLessThanOrEqual(30_000)
    // W3 DIRECTORY core whole bodies can live in the static index as well as the dynamic block.
    expect(
      [...new Set([...rendered.recordContext.fullBodyKeys, ...rendered.guideFullBodyKeys])].sort(),
    ).toEqual(retainedBodyKeys())
    // Independently read the actual provider-bound record block, with no identity ambiguity fixture.
    const dynamic = finalEvidence().system.dynamicPart
    const heading = 'MOST RELEVANT PLACES FOR THIS QUERY:'
    const at = dynamic.indexOf(heading)
    expect(at).toBeGreaterThanOrEqual(0)
    const start = dynamic.lastIndexOf('<untrusted_venue_data>', at)
    const end = dynamic.indexOf('</untrusted_venue_data>', at) + '</untrusted_venue_data>'.length
    const block = dynamic.slice(start, end)
    if (rendered.recordContext.chars === 0) {
      expect(retainedBodyKeys()).toEqual([])
      return
    }
    expect(block.length).toBe(rendered.recordContext.chars)
    expect(block.length).toBeLessThanOrEqual(30_000)
  }
  const listQuery = 'List rides for a 7-year-old who is 46 inches tall.'
  const send = (message = listQuery) => caller.chat.send({ ...input, message })
  const counters = 'Records with recognized explicit'

  it('retains thirteen whole knowledge bodies and their typed IDs past the old ten-topic cap', async () => {
    const rows = Array.from({ length: 13 }, (_, i) => rideTopic(`topic-${i}`))
    await install(rows)
    await send()
    expect(retainedBodyKeys()).toEqual(rows.map((row) => `knowledge:${row.id}`).sort())
    for (const row of rows) expect(prompt()).toContain(marker(row.id))
    assertBodyBudgetAndTypedIdentity()
  })

  it('retains eleven whole place bodies past three additions and the final eight-place cap', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ridePlace(`place-${i}`))
    await install([], rows)
    await send()
    expect(retainedBodyKeys()).toEqual(rows.map((row) => `place:${row.id}`).sort())
    for (const row of rows) expect(prompt()).toContain(marker(row.id))
    assertBodyBudgetAndTypedIdentity()
  })

  it('retains a mixed collection of twenty-four bodies with matching types rather than applying a hidden top-k', async () => {
    const knowledge = Array.from({ length: 13 }, (_, i) => rideTopic(`mixed-topic-${i}`))
    const places = Array.from({ length: 11 }, (_, i) => ridePlace(`mixed-place-${i}`))
    await install(knowledge, places)
    await send()
    expect(retainedBodyKeys()).toHaveLength(24)
    for (const row of [...knowledge, ...places]) expect(prompt()).toContain(marker(row.id))
    assertBodyBudgetAndTypedIdentity()
  })

  it('retains unknown prose and exactly-one-failure boundaries without treating selection as eligibility', async () => {
    const unknown = rideTopic(
      'unknown',
      'UNKNOWN_PROSE: A staff member decides the age and height exception after meeting the child.',
    )
    const ageFailure = rideTopic(
      'age-boundary',
      'Kind: ride; Minimum age: 8 years; Minimum height: 100 cm.',
    )
    ageFailure.title = 'Kind: ride'
    ageFailure.category = 'Kind: ride'
    const heightFailure = rideTopic(
      'height-boundary',
      'Kind: ride; Minimum age: 5 years; Minimum height: 130 cm.',
    )
    heightFailure.title = 'Kind: ride'
    heightFailure.category = 'Kind: ride'
    await install([unknown, ageFailure, heightFailure])
    await send()
    expect(prompt()).toContain(unknown.content as string)
    expect(prompt()).toContain(ageFailure.content as string)
    expect(prompt()).toContain(heightFailure.content as string)
    expect(prompt()).toContain('Decide all conditions only from full source bodies')
    assertBodyBudgetAndTypedIdentity()
  })

  it('reports ordinary named canonical and policy prose as hard-unknown while retaining soft hints and whole bodies', async () => {
    const canonical = rideTopic(
      'named-canonical',
      'Kind: ride; Minimum age: 5 years; Minimum height: 100 cm',
    )
    canonical.title = 'Oak Glider'
    canonical.category = 'Rides'
    const exception = rideTopic(
      'named-exception',
      'Minimum height: 140 cm; Staff may authorize a shorter child when the restraint fits after an individual check.',
    )
    exception.title = 'Copper Twist'
    exception.category = 'Rides'
    await install([canonical, exception])
    await send()
    expect(prompt()).toContain(canonical.content as string)
    expect(prompt()).toContain(exception.content as string)
    expect(prompt()).toContain('Records with recognized explicit minHeightCm statement: 0')
    const facetOwner = '../lib/guest-facet-integration'
    const { guestFacetIndex } = await import(facetOwner)
    const index: Array<{
      key: string
      facets: { minHeightCm: number | null }
      softFacets?: { minHeightCm: number | null }
    }> = guestFacetIndex(fixtureDirectory, '2026-10-17')
    const actual = index.filter(
      (row) => row.key === 'knowledge:named-canonical' || row.key === 'knowledge:named-exception',
    )
    expect(actual).toHaveLength(2)
    expect(actual.map((row) => row.facets.minHeightCm)).toEqual([null, null])
    expect(actual.map((row) => row.softFacets?.minHeightCm)).toEqual([100, 140])
    expect(retainedBodyKeys()).toEqual(['knowledge:named-canonical', 'knowledge:named-exception'])
    assertBodyBudgetAndTypedIdentity()
  })
  it('does not claim none or an eligible total when the recognized hard union has no matches', async () => {
    // Every source clause including title/category belongs to the recognized complete grammar.
    const excluded = rideTopic('two-failures', 'Minimum age: 12 years; Minimum height: 190 cm')
    excluded.title = 'Kind: ride'
    excluded.category = 'Kind: ride'
    await install([excluded])
    await send()
    expect(finalEvidence().system.dynamicPart).toMatch(
      /do not claim.*none|not.*real-world.*inventory/iu,
    )
    expect(finalEvidence().system.dynamicPart).not.toMatch(/eligible (?:offerings|rides):\s*0/iu)
    assertBodyBudgetAndTypedIdentity()
  })

  it('reports partial coverage when unknown and one-failure bodies overflow the shared budget', async () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      rideTopic(
        `overflow-${i}`,
        `${marker(`overflow-${i}`)} ${'unparsed conditional prose '.repeat(55)}`,
      ),
    )
    await install(rows)
    await send()
    expect(retainedBodyKeys().length).toBeLessThan(rows.length)
    expect(prompt()).toContain('Guide-record collection coverage is partial')
    expect(prompt()).toContain('Do not claim all matches, none, a total eligible count')
    assertBodyBudgetAndTypedIdentity()
  })

  it('drops withdrawn selected knowledge from body text and retained typed sources', async () => {
    const rows = Array.from({ length: 13 }, (_, i) => rideTopic(`knowledge-withdraw-${i}`))
    await install(rows)
    fixture.liveKnowledge = rows.slice(1)
    await send()
    expect(prompt()).not.toContain(marker(rows[0]!.id))
    expect(retainedBodyKeys()).not.toContain(`knowledge:${rows[0]!.id}`)
    // The omitted W3 core record is governing, so the stronger prohibition is required.
    expect(prompt()).toContain('Governing policy source coverage is incomplete')
    expect(prompt()).toContain('Do not decide eligibility or present examples as qualifying')
    assertBodyBudgetAndTypedIdentity()
  })
  it('prohibits eligibility examples when a mandatory governing body grows beyond final admission', async () => {
    const policy = rideTopic(
      'governing',
      'GOVERNING_OLD: All rides require an adult to accompany the child.',
    )
    policy.title = 'Ride eligibility governing policy'
    await install([policy, rideTopic('ordinary')])
    fixture.lexicalKnowledge = [policy]
    semanticSearch.knowledge.mockResolvedValue([{ ...policy, distance: 0.1 }])
    fixture.liveKnowledge = [
      { ...policy, content: `GOVERNING_CURRENT_BEGIN_${'condition '.repeat(3500)}_END` },
      rideTopic('ordinary'),
    ]
    await send()
    expect(prompt()).toContain('Governing policy source coverage is incomplete')
    expect(prompt()).toContain('Do not decide eligibility or present examples as qualifying')
    expect(prompt()).not.toContain('GOVERNING_OLD:')
    expect(prompt()).not.toContain('GOVERNING_CURRENT_BEGIN_')
    expect(retainedBodyKeys()).not.toContain('knowledge:governing')
    assertBodyBudgetAndTypedIdentity()
  })

  it('admits only whole live current bodies against one shared escaped record budget', async () => {
    const first = rideTopic('current-small', `CURRENT_SMALL_${'a'.repeat(12_000)}`)
    const growing = rideTopic('growing', 'PREDECESSOR_SMALL')
    const place = ridePlace('current-place', `CURRENT_PLACE_${'b'.repeat(12_000)}`)
    await install([first, growing], [place])
    fixture.liveKnowledge = [
      first,
      { ...growing, content: `GROWN_BODY_START_${'<&>'.repeat(2500)}_GROWN_BODY_END` },
    ]
    await send()
    expect(prompt()).not.toContain('PREDECESSOR_SMALL')
    expect(prompt()).not.toContain('GROWN_BODY_START_')
    // The omitted W3 core record is governing, so the stronger prohibition is required.
    expect(prompt()).toContain('Governing policy source coverage is incomplete')
    expect(prompt()).toContain('Do not decide eligibility or present examples as qualifying')
    expect(retainedBodyKeys()).not.toContain('knowledge:growing')
    assertBodyBudgetAndTypedIdentity()
  })

  it('drops a withdrawn selected place from prompt and typed source snapshots', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ridePlace(`withdraw-${i}`))
    await install([], rows)
    fixture.livePlaces = rows.slice(1)
    await send()
    expect(prompt()).not.toContain(marker(rows[0]!.id))
    expect(retainedBodyKeys()).not.toContain(`place:${rows[0]!.id}`)
    expect(prompt()).toContain('Guide-record collection coverage is partial')
    assertBodyBudgetAndTypedIdentity()
  })

  it.each([31_000, 16_000])(
    'suppresses independent featured interpolation for a %i-character DIRECTORY body',
    async (size) => {
      const sentinel = `FEATURED_ONLY_${size}`
      const row = ridePlace('featured', `${sentinel}_${'f'.repeat(size)}`)
      await install([], [row])
      dbQueryRaw.mockResolvedValue([
        { ...venueRow, name: 'Orchid Museum', aiFeaturedPlaceId: row.id },
      ])
      await send()
      if (size > 30_000) {
        expect(prompt()).not.toContain(sentinel)
        expect(retainedBodyKeys()).not.toContain(`place:${row.id}`)
      } else {
        expect(prompt().split(sentinel)).toHaveLength(2)
        expect(retainedBodyKeys()).toContain(`place:${row.id}`)
      }
      assertBodyBudgetAndTypedIdentity()
    },
  )

  it('emits record-statement diagnostics only across a fresh stable scoped metadata bracket', async () => {
    await install([rideTopic('stable')])
    await send()
    expect(prompt()).toContain(counters)
    const metadataReads = venueKnowledgeEntryFindMany.mock.calls.filter(
      ([args]) => args.select?.content !== true,
    )
    expect(metadataReads.length).toBeGreaterThanOrEqual(2)
    for (const [args] of metadataReads)
      expect(args.where).toMatchObject({ tenantId: TENANT_ID, venueId: VENUE_ID })
  })

  it.each(['changed', 'failed', 'absent-version', 'incomplete'])(
    'omits exact counters after %s metadata authority',
    async (mode) => {
      await install([rideTopic('drifting')])
      if (mode === 'changed')
        fixture.onHydrate = () => {
          fixture.knowledge = fixture.knowledge.map((row) => ({
            ...row,
            updatedAt: new Date('2026-10-16'),
          }))
        }
      if (mode === 'failed') fixture.failMetadata = true
      if (mode === 'absent-version') fixtureDirectory.searchVersion = ''
      if (mode === 'incomplete') fixtureDirectory.incomplete = true
      await send()
      expect(prompt()).not.toContain(counters)
      expect(prompt()).toContain('Guide-record collection coverage is partial')
    },
  )

  it('omits NATIVE record-statement counters and never hydrates native bodies from legacy IDs', async () => {
    const native = rideTopic(
      'native',
      'NATIVE_WHOLE_RIDE_BODY: Kind: ride; Minimum height: 100 cm.',
    )
    await install([rideTopic('native', 'LEGACY_COLLIDING_BODY')])
    resolveNativeGuestReadSnapshotAction.mockResolvedValue({
      path: 'NATIVE',
      reason: 'NATIVE_READY',
      releaseId: '11111111-1111-4111-8111-111111111111',
      state: { places: [], knowledgeEntries: [native] },
    })
    await send()
    expect(prompt()).toContain(native.content as string)
    expect(prompt()).not.toContain('LEGACY_COLLIDING_BODY')
    expect(prompt()).not.toContain(counters)
    expect(venueKnowledgeEntryFindMany.mock.calls.filter(([args]) => args.where?.id?.in)).toEqual(
      [],
    )
    assertBodyBudgetAndTypedIdentity()
  })

  it('keeps unsupported recommendation queries on the existing fallback lane', async () => {
    await install(Array.from({ length: 13 }, (_, i) => rideTopic(`unsupported-${i}`)))
    await send('What do you recommend nearby?')
    expect(prompt()).not.toContain('Guide-record collection coverage')
    expect(prompt()).not.toContain(counters)
  })

  it('preserves nonempty FULL featured control bytes from the frozen pre-W5 router', async () => {
    vi.stubEnv('GUEST_GUIDE_STRATEGY', undefined)
    const row = ridePlace(
      'full-control',
      'FULL_FEATURED_CONTROL: A short complete ride description.',
    )
    await install([], [row])
    dbQueryRaw.mockResolvedValue([
      { ...venueRow, name: 'Orchid Museum', aiFeaturedPlaceId: row.id },
    ])
    await send()
    const actual = {
      prompt: prompt(),
      system: finalEvidence().system,
      bodyKeys: retainedBodyKeys(),
    }
    expect(actual.prompt).toContain('VENUE GUIDE:')
    expect(actual.prompt).toContain('FULL_FEATURED_CONTROL')
    // Immutable SHA256 of the exact pre-W5 artifact captured before applying W5.
    expect(
      createHash('sha256')
        .update(JSON.stringify(actual, null, 2))
        .digest('hex'),
    ).toBe('b85049478f71595b1c1a747b62fafe6c0c6c60d890202898368b59c54fe104fc')
    const baselinePath = process.env.W5_FULL_BASELINE_READ
    if (baselinePath) expect(actual).toEqual(JSON.parse(readFileSync(baselinePath, 'utf8')))
  })
  it('keeps the native QR body through a legitimate legacy collection fallback and coherent core hydration', async () => {
    const legacyEntry = ridePlace('mixed-qr', 'LEGACY_QR_COLLISION_NEVER_SEND')
    const nativeEntry = {
      ...legacyEntry,
      longDescription: 'NATIVE_QR_WHOLE_BODY: Staff supervise this ride.',
    }
    const fallback = ridePlace('mixed-compatibility', 'AUTHORIZED_COMPATIBILITY_WHOLE_BODY')
    const oldCore = {
      ...topic('Hours: Orchid Museum, 12 pm - 6 pm Saturday. CORE_OLD_NEVER_SEND'),
      id: 'mixed-hours',
      tenantId: TENANT_ID,
      venueId: VENUE_ID,
    }
    const liveCore = {
      ...oldCore,
      content: 'Hours: Orchid Museum, 9 am - 6 pm Saturday. CORE_CURRENT_SINGLE_GENERATION',
    }
    await install([oldCore], [legacyEntry, fallback])
    fixture.liveKnowledge = [liveCore]
    semanticSearch.places.mockResolvedValue([legacyEntry, fallback])
    semanticSearch.knowledge.mockResolvedValue([])
    placeFindFirst.mockResolvedValue(legacyEntry)
    resolveNativeGuestReadSnapshotAction.mockResolvedValue({
      path: 'NATIVE',
      reason: 'NATIVE_READY',
      releaseId: '11111111-1111-4111-8111-111111111111',
      // The compatibility ID and hours ID deliberately lack release membership.
      // Entry projection succeeds; broader retrieval and directory truly fall back.
      state: { places: [nativeEntry], knowledgeEntries: [] },
    })
    let coreReads = 0
    fixture.onKnowledgeHydrate = (ids) => {
      if (ids.includes('mixed-hours') && ++coreReads > 1) {
        fixture.liveKnowledge = []
        throw new Error('Unexpected second core hydration')
      }
    }
    await caller.chat.send({ ...input, entryPlaceId: legacyEntry.id, message: listQuery })
    expect(coreReads).toBe(1)
    expect(finalEvidence().system.staticPart).toContain('CORE_CURRENT_SINGLE_GENERATION')
    expect(finalEvidence().system.staticPart).not.toContain('CORE_OLD_NEVER_SEND')
    expect(facetInputs.length).toBeGreaterThan(0)
    expect(prompt()).toContain('NATIVE_QR_WHOLE_BODY')
    expect(prompt()).not.toContain('LEGACY_QR_COLLISION_NEVER_SEND')
    expect(prompt()).toContain('AUTHORIZED_COMPATIBILITY_WHOLE_BODY')
    expect(prompt()).toContain('CORE_CURRENT_SINGLE_GENERATION')
    expect(prompt()).not.toContain('CORE_OLD_NEVER_SEND')
    expect(retainedBodyKeys()).toContain('place:mixed-qr')
    const entrySource = finalEvidence().sources.find((row) => row.sourceId === 'place:mixed-qr')
    expect(JSON.stringify(entrySource)).toContain('NATIVE_QR_WHOLE_BODY')
    expect(JSON.stringify(entrySource)).not.toContain('LEGACY_QR_COLLISION_NEVER_SEND')
    const placeHydrates = placeFindMany.mock.calls.filter(([args]) => args.where?.id?.in)
    expect(placeHydrates.length).toBeGreaterThan(0)
    for (const [args] of placeHydrates) expect(args.where.id.in).not.toContain('mixed-qr')
    const coreHydrates = venueKnowledgeEntryFindMany.mock.calls.filter(
      ([args]) => args.select?.content === true && args.where?.id?.in?.includes('mixed-hours'),
    )
    // Use no lexical candidates so this counts the core request, not independent retrieval.
    expect(coreHydrates).toHaveLength(1)
    expect(
      configLogger.info.mock.calls.some(
        ([row]) => row.action === 'guest-chat.native-content-read' && row.readPath === 'LEGACY',
      ),
    ).toBe(true)
    expect(prompt()).not.toContain(counters)
    assertBodyBudgetAndTypedIdentity()
  })

  it('does not revive a release-rejected QR ID through mixed legacy lexical retrieval', async () => {
    const rejected = ridePlace('rejected-qr', 'REJECTED_QR_BODY_NEVER_SEND')
    const nativeOther = ridePlace('released-other', 'RELEASED_OTHER_BODY')
    const fallback = ridePlace('compatibility-other', 'AUTHORIZED_FALLBACK_BODY')
    // The scoped directory never returned the rejected entry. Semantic/lexical candidates
    // deliberately still contain it, exercising the router rejection rather than only DB scope.
    await install([], [nativeOther, fallback])
    fixture.livePlaces = [nativeOther, fallback]
    semanticSearch.places.mockResolvedValue([rejected, nativeOther, fallback])
    placeFindFirst.mockResolvedValue(rejected)
    resolveNativeGuestReadSnapshotAction.mockResolvedValue({
      path: 'NATIVE',
      reason: 'NATIVE_READY',
      releaseId: '22222222-2222-4222-8222-222222222222',
      state: { places: [nativeOther], knowledgeEntries: [] },
    })
    await caller.chat.send({ ...input, entryPlaceId: rejected.id, message: listQuery })
    expect(prompt()).not.toContain('REJECTED_QR_BODY_NEVER_SEND')
    expect(retainedBodyKeys()).not.toContain('place:rejected-qr')
    expect(JSON.stringify(finalEvidence().sources)).not.toContain('REJECTED_QR_BODY_NEVER_SEND')
    expect(prompt()).toContain('AUTHORIZED_FALLBACK_BODY')
    assertBodyBudgetAndTypedIdentity()
  })

  it.each(['foreign-tenant', 'foreign-venue', 'withdrawn', 'private'])(
    'rejects a raw %s QR entry through the strict scoped entry reader',
    async (reason) => {
      const valid = ridePlace(`authorized-${reason}`, `AUTHORIZED_CONTROL_${reason}`)
      await install([], [valid])
      semanticSearch.places.mockResolvedValue([valid])
      const rejectedId = `qr-${reason}`
      const forbidden = {
        ...ridePlace(rejectedId, `FORBIDDEN_QR_${reason}`),
        ...(reason === 'foreign-tenant' ? { tenantId: 'foreign-tenant' } : {}),
        ...(reason === 'foreign-venue' ? { venueId: 'foreign-venue' } : {}),
        ...(reason === 'withdrawn' ? { isActive: false } : {}),
        ...(reason === 'private' ? { visibility: 'PRIVATE' } : {}),
      }
      fixture.strict = true
      fixture.livePlaces = [valid, forbidden]
      resolveNativeGuestReadSnapshotAction.mockResolvedValue({
        path: 'NATIVE',
        reason: 'NATIVE_READY',
        releaseId: '33333333-3333-4333-8333-333333333333',
        // Release membership alone cannot authorize the scoped-out compatibility row.
        state: { places: [valid, forbidden], knowledgeEntries: [] },
      })
      await caller.chat.send({ ...input, entryPlaceId: rejectedId, message: listQuery })
      expect(placeFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: rejectedId,
            tenantId: TENANT_ID,
            venueId: VENUE_ID,
            isActive: true,
            visibility: 'PUBLIC',
          },
        }),
      )
      expect(retainedBodyKeys()).not.toContain(`place:${rejectedId}`)
      expect(prompt()).toContain(`AUTHORIZED_CONTROL_${reason}`)
      expect(prompt()).not.toContain('FORBIDDEN_QR_')
      expect(JSON.stringify(finalEvidence().sources)).not.toContain('FORBIDDEN_QR_')
      assertBodyBudgetAndTypedIdentity()
    },
  )

  it('keeps forbidden raw authority rows out of the strict directory, facet pool and provider evidence', async () => {
    const valid = rideTopic('strict-valid', 'STRICT_VALID_WHOLE_BODY')
    const adopted = rideTopic('strict-adopted', 'FORBIDDEN_ADOPTED')
    const moduleRow = (id: string, action = 'PUBLISH') => ({
      ...rideTopic(id, `FORBIDDEN_${id}`),
      contentModuleId: `module-${id}`,
      contentRevisionId: `revision-${id}`,
      contentPublicationId: `publication-${id}`,
      contentRevision: {
        audience: 'PUBLIC',
        createdBy: 'operator',
        effectiveFrom: null as Date | null,
        effectiveUntil: null as Date | null,
        kind: 'GUIDE',
        operationalFact: null,
      },
      contentPublication: {
        action,
        eventOrder: 1n,
        module: { publications: [{ id: `publication-${id}`, eventOrder: 1n }] },
      },
    })
    const withdrawn = moduleRow('withdrawn-publication', 'WITHDRAW')
    const unpublished = { ...moduleRow('unpublished'), contentPublication: null }
    const future = moduleRow('future-revision')
    future.contentRevision.effectiveFrom = new Date('2027-01-01')
    const expired = moduleRow('expired-revision')
    expired.contentRevision.effectiveUntil = new Date('2020-01-01')
    const connectedRevision = moduleRow('connected-revision')
    connectedRevision.contentRevision.createdBy = 'source-connection:fictional'
    const knowledge = [
      valid,
      adopted,
      { ...rideTopic('foreign-tenant', 'FORBIDDEN_TENANT'), tenantId: 'another-tenant' },
      { ...rideTopic('foreign-venue', 'FORBIDDEN_VENUE'), venueId: 'another-venue' },
      { ...rideTopic('disabled', 'FORBIDDEN_DISABLED'), isEnabled: false },
      { ...rideTopic('second-layer', 'FORBIDDEN_SECOND'), visibility: 'SECOND_LAYER' },
      { ...rideTopic('source-connection', 'FORBIDDEN_CONNECTED'), sourceType: 'SOURCE_CONNECTION' },
      withdrawn,
      unpublished,
      future,
      expired,
      connectedRevision,
    ]
    const validPlace = ridePlace('strict-place', 'STRICT_VALID_PLACE_BODY')
    const places = [
      validPlace,
      { ...ridePlace('private', 'FORBIDDEN_PRIVATE'), visibility: 'PRIVATE' },
      { ...ridePlace('inactive', 'FORBIDDEN_INACTIVE'), isActive: false },
      { ...ridePlace('foreign-place', 'FORBIDDEN_FOREIGN_PLACE'), tenantId: 'another-tenant' },
    ]
    fixture.strict = true
    fixture.activatedIds = [adopted.id]
    fixture.knowledge = knowledge
    fixture.liveKnowledge = knowledge
    fixture.places = places
    fixture.livePlaces = places
    const directory = await loadGuestVenueDirectory({
      reader: mockDb,
      tenantId: TENANT_ID,
      venueId: VENUE_ID,
      includeSecondLayer: false,
      asOf: new Date(),
    })
    expect(directory.knowledge.map((row) => row.id)).toEqual([valid.id])
    expect(directory.places.map((row) => row.id)).toEqual([validPlace.id])
    fixtureDirectory.knowledge = directory.knowledge
    fixtureDirectory.places = directory.places
    fixtureDirectory.searchVersion = `strict-scoped:${await guestDirectoryVersion({ reader: mockDb, tenantId: TENANT_ID, venueId: VENUE_ID, includeSecondLayer: false, asOf: new Date() })}`
    semanticSearch.knowledge.mockResolvedValue([])
    semanticSearch.places.mockResolvedValue([])
    await send()
    expect(facetInputs.length).toBeGreaterThan(0)
    for (const seen of facetInputs) {
      expect(seen.knowledge.map((row) => row.id)).toEqual([valid.id])
      expect(seen.places.map((row) => row.id)).toEqual([validPlace.id])
    }
    expect(prompt()).toContain('STRICT_VALID_WHOLE_BODY')
    expect(prompt()).toContain('STRICT_VALID_PLACE_BODY')
    expect(prompt()).not.toContain('FORBIDDEN_')
    expect(JSON.stringify(finalEvidence().sources)).not.toContain('FORBIDDEN_')
    expect(retainedBodyKeys()).toEqual(['knowledge:strict-valid', 'place:strict-place'])
    assertBodyBudgetAndTypedIdentity()
  })
})
