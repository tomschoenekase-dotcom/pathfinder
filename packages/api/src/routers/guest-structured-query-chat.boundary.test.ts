import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guestReplyKindFromFallbackCode } from '@pathfinder/contracts/guest-reply-kind'
import type { GuestQuerySource } from '../lib/guest-query-source'
import type { GeneralizedContentPayload } from '@pathfinder/contracts/universal-content-actions'

import {
  AI_MODEL_REGISTRY,
  textAttemptCostCeilingUnits,
  setOpenAiEmbeddingsClientForTesting,
  setOpenAiResponsesClientForTesting,
  type AnthropicCreateParams,
  type AnthropicMessagesClient,
  type OpenAiEmbeddingsClient,
} from '@pathfinder/ai'

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
    reserveAiCostAttempt: accounting.reserve,
    markAiCostAttemptDispatched: accounting.dispatch,
    settleAiCostAttemptExact: accounting.exact,
    settleAiCostAttemptAmbiguous: accounting.ambiguous,
    releaseUndispatchedAiCostAttempt: accounting.release,
    applyNativeGuestContentRead: (
      input: Parameters<typeof import('@pathfinder/db').applyNativeGuestContentRead>[0],
    ) => {
      const original = originalDb.applyNativeGuestContentRead(input)
      coverageReadControls.projections += 1
      return coverageReadControls.mismatch && coverageReadControls.projections === 2
        ? { ...original, path: 'LEGACY' as const }
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

const loadQuerySource = vi.hoisted(() => vi.fn())
vi.mock('../lib/guest-query-source', () => ({ loadGuestQuerySource: loadQuerySource }))
const gatewayCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>)
vi.mock('@pathfinder/ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@pathfinder/ai')>()
  return {
    ...original,
    generateTextForCapability: (...args: Parameters<typeof original.generateTextForCapability>) => {
      gatewayCalls.push(args[0] as unknown as Record<string, unknown>)
      return original.generateTextForCapability(...args)
    },
  }
})
const accounting = vi.hoisted(() => ({
  reserve: vi.fn(),
  dispatch: vi.fn(),
  exact: vi.fn(),
  ambiguous: vi.fn(),
  release: vi.fn(),
}))

import { router } from '../core'
import type { TRPCContext } from '../context'
import { _setAnthropicClientForTesting, chatRouter, streamChatTurn } from './chat'

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

describe('structured query actual chat boundary (source/DB loaders mocked)', () => {
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

  const restriction =
    'STRUCTURED_ONLY: minimum 48 inches; under 10 with a paid adult; closed October 20–22. Booking never waives restrictions.'
  const policy = 'STRUCTURED_POLICY: $8 per rider; weekends only; no exceptions to age or height.'
  const baseline = 'BASELINE_ONLY: Please consult the desk for the current conditions.'
  const input = { venueId: VENUE_ID, anonymousToken: TOKEN, message: 'List attractions.' }
  const rawPlan = JSON.stringify({
    status: 'QUERY',
    mode: 'list',
    predicates: [{ field: 'kind', equals: 'ATTRACTION' }],
  })
  const message = (text: string) => ({
    content: [{ type: 'text', text }],
    usage: { input_tokens: 20, output_tokens: 10 },
  })
  function topic(id = 'baseline', content = baseline) {
    return {
      id,
      title: 'Visitor conditions',
      category: 'VISIT',
      content,
      sourceType: 'MANUAL',
      sourceName: null,
      sourceUrl: null,
      updatedAt: new Date('2026-10-01'),
      lastReviewedAt: null,
      contentModuleId: null,
      contentRevisionId: null,
      contentPublicationId: null,
    }
  }
  function source(version = 'v1'): GuestQuerySource {
    return {
      tenantId: TENANT_ID,
      venueId: VENUE_ID,
      version,
      asOf: '2026-10-21T05:00:00.000Z',
      coverage: 'COMPLETE',
      readPath: 'LEGACY',
      includeSecondLayer: false,
      directory: {
        searchVersion: version,
        incomplete: false,
        places: [
          {
            id: 'moon',
            name: 'Moon Ride',
            type: 'ATTRACTION',
            itemType: 'ride',
            shortDescription: null,
            longDescription: restriction,
            lat: null,
            lng: null,
            tags: [],
            areaName: 'North',
            hours: null,
            photoUrl: null,
            sourceType: 'MANUAL',
            sourceName: null,
            sourceUrl: null,
          },
        ],
        knowledge: [topic('booking', policy)],
      },
    }
  }
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('TORCHIKO_LOCAL_STRUCTURED_QUERY', '1')
    vi.stubEnv('GUEST_GUIDE_STRATEGY', 'evidence')
    gatewayCalls.length = 0
    accounting.reserve.mockImplementation(async (args) => ({
      id: args.reservationId,
      reservedUnits: args.reservedUnits,
      tenantId: args.identity.tenantId,
      venueId: args.identity.venueId,
    }))
    accounting.dispatch.mockResolvedValue(undefined)
    accounting.exact.mockResolvedValue(undefined)
    accounting.ambiguous.mockResolvedValue(undefined)
    accounting.release.mockResolvedValue(undefined)
    loadQuerySource.mockResolvedValue(source())
    fixtureDirectory.places = []
    fixtureDirectory.knowledge = [topic()]
    fixtureDirectory.incomplete = false
    semanticSearch.places.mockResolvedValue([])
    semanticSearch.knowledge.mockResolvedValue([{ ...topic(), distance: 0.1 }])
    venueKnowledgeEntryFindMany.mockResolvedValue([topic()])
    dbQueryRaw.mockResolvedValue([
      {
        ...venueRow,
        name: 'Fictional Moon Museum',
        chatAppearance: { timeZone: 'America/Chicago' },
      },
    ])
    sessionUpsert.mockResolvedValue({ id: SESSION_ID, experienceScope: 'PUBLIC' })
    messageFindMany.mockResolvedValue([])
    messageCreate.mockResolvedValue({})
    aiUsageEventCreate.mockResolvedValue({ id: 'usage-record' })
    anthropicCreate.mockResolvedValue(message('ANSWER_VISIBLE'))
  })
  const system = (index = -1) =>
    (
      (anthropicCreate.mock.calls.at(index)![0] as AnthropicCreateParams).system as Array<{
        text: string
      }>
    )
      .map((block) => block.text)
      .join('')
  function queue(plan = rawPlan) {
    anthropicCreate
      .mockResolvedValueOnce(message(plan))
      .mockResolvedValueOnce(message('ANSWER_VISIBLE'))
  }
  function metadata() {
    return guestTurnActions.finalize.mock.calls[0]![0].input.replayMetadata
  }
  function structuredSummary() {
    const profile = metadata().answerEvidence.sources.find(
      (row: { kind: string }) => row.kind === 'VENUE_PROFILE',
    )
    return JSON.parse(profile.snapshot).structuredQuery
  }
  it.each(['absent', 'production'])('keeps baseline without eligible opt-in: %s', async (mode) => {
    vi.stubEnv('TORCHIKO_LOCAL_DIRECT_QUERY', '1')
    if (mode === 'absent') vi.stubEnv('TORCHIKO_LOCAL_STRUCTURED_QUERY', '')
    else vi.stubEnv('NODE_ENV', 'production')
    await caller.chat.send(input)
    expect(loadQuerySource).not.toHaveBeenCalled()
    expect(anthropicCreate).toHaveBeenCalledOnce()
    expect(system()).not.toContain('Translate the guest question')
    expect(system()).toContain(baseline)
  })
  it.each([false, true])(
    'excludes original native admission even with projection mismatch=%s',
    async (mismatch) => {
      vi.stubEnv('TORCHIKO_LOCAL_DIRECT_QUERY', '1')
      const state = { places: [], knowledgeEntries: [topic()], generalizedModules: [] }
      resolveNativeGuestReadSnapshotAction.mockResolvedValue({
        path: 'NATIVE',
        reason: 'NATIVE_READY',
        releaseId: 'release-native',
        state,
      })
      coverageReadControls.mismatch = mismatch
      await caller.chat.send(input)
      expect(loadQuerySource).not.toHaveBeenCalled()
      expect(anthropicCreate).toHaveBeenCalledOnce()
    },
  )
  it('uses distinct accounted planner/answer IDs with the same budget and admission guard', async () => {
    queue()
    await caller.chat.send(input)
    expect(anthropicCreate).toHaveBeenCalledTimes(2)
    expect(gatewayCalls).toHaveLength(2)
    const [planner, answer] = gatewayCalls
    expect(planner!.invocationId).not.toBe(answer!.invocationId)
    expect(planner!.budgetGate).toBe(answer!.budgetGate)
    expect(planner!.admissionGuard).toBe(answer!.admissionGuard)
    expect(planner!.usageSink).toBe(answer!.usageSink)
    expect(planner!.maxAttempts).toBe(1)
    expect(planner!.maxOutputTokens).toBeGreaterThan(0)
    const route = planner!.route as {
      candidates: Array<{ modelKey: keyof typeof AI_MODEL_REGISTRY }>
    }
    for (const candidate of route.candidates)
      expect(planner!.maxOutputTokens).toBeLessThanOrEqual(
        AI_MODEL_REGISTRY[candidate.modelKey].maxOutputTokens,
      )
    expect(planner).not.toHaveProperty('onTextDelta')
    const invocationIds = accounting.reserve.mock.calls
      .filter(([args]) => args.identity.feature === 'guest-chat')
      .map(([args]) => args.identity.invocationId)
    expect(new Set(invocationIds).size).toBe(2)
    expect(accounting.exact.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(
      guestTurnActions.dispatch.mock.calls.filter(
        ([call]) => call.operation.kind === 'RESPONSE_GENERATION',
      ),
    ).toHaveLength(1)
  })
  it('retains exact answer system and source restriction bodies in finalized evidence', async () => {
    queue()
    await caller.chat.send(input)
    expect(anthropicCreate).toHaveBeenCalledTimes(2)
    const evidence = metadata().answerEvidence
    expect(JSON.stringify(evidence)).toContain(restriction)
    expect(JSON.stringify(evidence)).toContain(policy)
    expect(
      JSON.parse(
        evidence.sources.find((row: { sourceId: string }) => row.sourceId === 'place:moon')
          .snapshot,
      ),
    ).toEqual(source().directory.places[0])
    expect(
      JSON.parse(
        evidence.sources.find((row: { sourceId: string }) => row.sourceId === 'knowledge:booking')
          .snapshot,
      ),
    ).toEqual(JSON.parse(JSON.stringify(source().directory.knowledge[0])))
    // The receipt must preserve the exact strings actually dispatched, including cache partitions.
    expect(evidence.system.staticPart + evidence.system.dynamicPart).toBe(system())
    expect(structuredSummary().knownMatchCount).toBe(1)
  })
  it('retains exact canonical publication evidence through the accounted real chat path', async () => {
    const current = source()
    const payloads: GeneralizedContentPayload[] = [
      {
        kind: 'SERVICE',
        name: 'Moon counter',
        placeId: 'moon',
        availability: 'Staffed Saturdays only',
      },
      {
        kind: 'ITEM',
        name: 'Sketch kit',
        itemType: 'PRODUCT',
        description: 'Equipment rental is separate.',
      },
      {
        kind: 'RELATIONSHIP',
        fromModuleId: 'module-0',
        toModuleId: 'module-1',
        relationshipType: 'OFFERS_PRODUCT_V1',
      },
      {
        kind: 'POLICY',
        title: 'Kit terms',
        rule: 'No refunds. Children require an adult.',
        appliesTo: ['module-0'],
      },
    ]
    current.canonicalModules = {
      contract: 'published-query-source-v1',
      modules: payloads.map((payload, i) => ({
        moduleId: `module-${i}`,
        revisionId: `revision-${i}`,
        publicationId: `publication-${i}`,
        publicationOrder: String(i + 1),
        kind: payload.kind,
        payload,
        version: 1,
        audience: 'PUBLIC',
        effectiveFrom: null,
        effectiveUntil: null,
        evidence: [
          {
            sourceId: 'operator-source',
            locator: null,
            capturedAt: current.asOf,
            excerptHash: null,
          },
        ],
      })),
    }
    loadQuerySource.mockResolvedValue(current)
    queue(
      JSON.stringify({
        status: 'QUERY',
        mode: 'list',
        predicates: [{ field: 'product', name: 'Sketch kit' }],
      }),
    )
    await caller.chat.send(input)
    expect(anthropicCreate).toHaveBeenCalledTimes(2)
    expect(structuredSummary().canonicalAuthority).toBe(true)
    expect(structuredSummary().policyCoverage).toBe('UNKNOWN')
    const evidence = metadata().answerEvidence
    const canonical = evidence.sources.filter(
      (row: { kind: string }) => row.kind === 'PUBLISHED_CONTENT',
    )
    expect(canonical).toHaveLength(4)
    for (const module of current.canonicalModules.modules) {
      const retained = canonical.find(
        (row: { sourceId: string }) =>
          row.sourceId === `published-content:${module.moduleId}:${module.revisionId}`,
      )
      expect(JSON.parse(retained.snapshot)).toEqual(module)
    }
    expect(system()).toContain('Equipment rental is separate.')
    expect(system()).toContain('No refunds. Children require an adult.')
    expect(evidence.system.staticPart + evidence.system.dynamicPart).toBe(system())
    expect(accounting.exact.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
  it.each([
    JSON.stringify({ status: 'UNSUPPORTED', reason: 'age and date unsupported' }),
    JSON.stringify({
      status: 'QUERY',
      mode: 'list',
      predicates: [
        { field: 'kind', equals: 'ATTRACTION' },
        { field: 'feature', name: 'wheelchairAccessible', value: true },
      ],
    }),
    JSON.stringify({
      status: 'QUERY',
      mode: 'list',
      predicates: [
        { field: 'name', equals: 'Moon Ride' },
        { field: 'product', name: 'pizza' },
      ],
    }),
  ])(
    'falls back whole unsupported conjunction without partial structured evidence %#',
    async (plan) => {
      queue(plan)
      await caller.chat.send(input)
      expect(anthropicCreate).toHaveBeenCalledTimes(2)
      expect(system()).toContain(baseline)
      expect(system()).not.toContain(restriction)
      expect(structuredSummary()).toBeUndefined()
    },
  )
  it.each(['version', 'native', 'read-failure'])(
    'blocks stale answer when source changes between planner and answer: %s',
    async (change) => {
      anthropicCreate.mockImplementationOnce(async () => {
        if (change === 'version') loadQuerySource.mockResolvedValue(source('v2'))
        if (change === 'native')
          resolveNativeGuestReadSnapshotAction.mockResolvedValue({
            path: 'NATIVE',
            reason: 'NATIVE_READY',
            releaseId: 'new',
            state: null,
          })
        if (change === 'read-failure')
          loadQuerySource.mockRejectedValue(new Error('source unreadable'))
        return message(rawPlan)
      })
      await caller.chat.send(input)
      expect(anthropicCreate).toHaveBeenCalledOnce()
      expect(guestTurnActions.finalize).toHaveBeenCalledOnce()
      expect(guestTurnActions.finalize.mock.calls[0]![0].input.assistantResponse).not.toBe(
        'ANSWER_VISIBLE',
      )
    },
  )
  it('falls back to bounded baseline if retained sources exceed attribution source count', async () => {
    const many = source()
    many.directory.knowledge = Array.from({ length: 101 }, (_, index) =>
      topic(`policy-${index}`, `Condition ${index}: weekends only.`),
    )
    loadQuerySource.mockResolvedValue(many)
    queue()
    await caller.chat.send(input)
    expect(anthropicCreate).toHaveBeenCalledTimes(2)
    expect(system()).toContain(baseline)
    expect(system()).not.toContain(restriction)
    expect(structuredSummary()).toBeUndefined()
  })
  it('enforces one cumulative request ceiling across planner and answer', async () => {
    const spec = AI_MODEL_REGISTRY['guest-chat']
    const ceiling = textAttemptCostCeilingUnits({
      spec,
      system: [],
      messages: [],
      maxOutputTokens: spec.maxOutputTokens,
    })
    aiWorkloadConfigurationOverrideFindFirst.mockResolvedValue({
      enabled: true,
      isTombstone: false,
      requestBudgetCeilingE8UsdSet: true,
      requestBudgetCeilingE8Usd: ceiling.toString(),
      unsafeChangesEnabled: false,
      reason: 'Synthetic cumulative ceiling',
    })
    queue()
    await caller.chat.send(input)
    expect(anthropicCreate).toHaveBeenCalledOnce()
    expect(gatewayCalls).toHaveLength(2)
    expect(gatewayCalls[0]!.budgetGate).toBe(gatewayCalls[1]!.budgetGate)
    expect(
      accounting.reserve.mock.calls.filter(([args]) => args.identity.feature === 'guest-chat'),
    ).toHaveLength(1)
    expect(accounting.exact.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(guestTurnActions.finalize.mock.calls[0]![0].input.assistantResponse).not.toBe(
      'ANSWER_VISIBLE',
    )
  })
  it('rechecks source admission after answer budget reservation before dispatch', async () => {
    let chatReserves = 0
    accounting.reserve.mockImplementation(async (args) => {
      if (args.identity.feature === 'guest-chat' && ++chatReserves === 2)
        loadQuerySource.mockResolvedValue(source('withdrawn-version'))
      return { id: args.reservationId, reservedUnits: args.reservedUnits }
    })
    queue()
    await caller.chat.send(input)
    expect(chatReserves).toBe(2)
    expect(anthropicCreate).toHaveBeenCalledOnce()
    expect(accounting.release).toHaveBeenCalled()
  })
  it('falls back when current same-ID content differs from baseline prompt content', async () => {
    const current = source()
    current.directory.knowledge = [topic('baseline', policy)]
    loadQuerySource.mockResolvedValue(current)
    queue()
    await caller.chat.send(input)
    expect(anthropicCreate).toHaveBeenCalledTimes(2)
    expect(system()).toContain(baseline)
    expect(system()).not.toContain(policy)
    expect(structuredSummary()).toBeUndefined()
  })
  it('falls back when a whole required condition exceeds the result prompt bound', async () => {
    const current = source()
    current.directory.knowledge[0]!.content =
      'OVERSIZED_CONDITION_START ' + 'x'.repeat(35000) + ' OVERSIZED_CONDITION_END'
    loadQuerySource.mockResolvedValue(current)
    queue()
    await caller.chat.send(input)
    expect(anthropicCreate).toHaveBeenCalledTimes(2)
    expect(system()).toContain(baseline)
    expect(system()).not.toContain('OVERSIZED_CONDITION_START')
    expect(structuredSummary()).toBeUndefined()
  })
  it('keeps an equal same-ID body once in the retained attribution sources', async () => {
    const current = source()
    current.directory.knowledge = [
      {
        id: 'baseline',
        title: 'Visitor conditions',
        category: 'VISIT',
        content: baseline,
        sourceType: 'MANUAL',
        sourceName: null,
        sourceUrl: null,
      },
    ]
    loadQuerySource.mockResolvedValue(current)
    queue()
    await caller.chat.send(input)
    expect(structuredSummary().knownMatchCount).toBe(1)
    expect(
      metadata().answerEvidence.sources.filter(
        (row: { sourceId: string }) => row.sourceId === 'knowledge:baseline',
      ),
    ).toHaveLength(1)
  })
  it('does not stream planner JSON to guests', async () => {
    anthropicCreate.mockResolvedValueOnce(message(rawPlan))
    const stream = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ANSWER_VISIBLE' } }
      },
      finalMessage: vi.fn().mockResolvedValue(message('ANSWER_VISIBLE')),
    }))
    _setAnthropicClientForTesting({
      messages: { create: anthropicCreate, stream },
    } as unknown as AnthropicMessagesClient)
    const events = []
    for await (const event of streamChatTurn(ctx, input)) events.push(event)
    expect(anthropicCreate).toHaveBeenCalledOnce()
    expect(stream).toHaveBeenCalledOnce()
    expect(
      events
        .filter((event) => event.type === 'delta')
        .map((event) => (event.type === 'delta' ? event.delta : ''))
        .join(''),
    ).toBe('ANSWER_VISIBLE')
    expect(JSON.stringify(events)).not.toContain('"predicates"')
  })
  const countPlan = JSON.stringify({ status: 'QUERY', mode: 'count', predicates: [{ field: 'kind', equals: 'ATTRACTION' }] })
  it('uses exactly one accounted Luna planner and no answer provider for a direct count', async () => {
    vi.stubEnv('TORCHIKO_LOCAL_DIRECT_QUERY', '1')
    vi.stubEnv('GUEST_CHAT_DEFAULT_MODEL_KEY', 'guest-chat-luna-reasoning')
    const create = vi.fn().mockResolvedValue({ status: 'completed', output_text: countPlan, usage: { input_tokens: 123, output_tokens: 17, input_tokens_details: { cached_tokens: 0 } } })
    setOpenAiResponsesClientForTesting({ responses: { create } })
    const response = await caller.chat.send(input)
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0]![0]).toMatchObject({ model: 'gpt-6-luna', reasoning: { effort: 'low' }, max_output_tokens: 1024 })
    expect(anthropicCreate).not.toHaveBeenCalled()
    expect(response.response).toContain('1 matching listed record.')
    expect(accounting.reserve.mock.calls.filter(([args]) => args.identity.feature === 'guest-chat')).toHaveLength(1)
    const plannerReservation = accounting.reserve.mock.calls.find(([args]) => args.identity.feature === 'guest-chat')![0]
    expect(accounting.exact.mock.calls.filter(([args]) => args.reservation.id === plannerReservation.reservationId)).toHaveLength(1)
    const usage = aiUsageEventCreate.mock.calls.filter(([args]) => args.data.feature === 'guest-chat')
    expect(usage).toHaveLength(1)
    expect(usage[0]![0].data).toMatchObject({ provider: 'openai', model: 'gpt-6-luna', inputTokens: 123, outputTokens: 17, success: true })
    expect(guestTurnActions.observe.mock.calls.at(-1)![0].operation).toMatchObject({ outcomeCode: 'SUCCEEDED', usageReference: 'usage-record' })
  })
  it('directly counts more than100 records with only the scoped aggregate receipt retained', async () => {
    vi.stubEnv('TORCHIKO_LOCAL_DIRECT_QUERY', '1')
    const current = source()
    current.directory.places = Array.from({ length: 501 }, (_, i) => ({ ...current.directory.places[0]!, id: `ride-${i}`, name: `Ride ${i}` }))
    loadQuerySource.mockResolvedValue(current)
    anthropicCreate.mockResolvedValueOnce(message(countPlan))
    expect((await caller.chat.send(input)).response).toContain('501 matching listed records.')
    expect(anthropicCreate).toHaveBeenCalledOnce()
    expect(metadata().answerEvidence.sources).toHaveLength(1)
    const profile = JSON.parse(metadata().answerEvidence.sources[0].snapshot)
    expect(profile.structuredQuery).toMatchObject({ exactEligibleCount: 501, retainedSourceCount: 0, sourceVersion: 'v1' })
  })
  it('completes direct count with one settled planner, no answer call, exact local evidence and durable replay', async () => {
    vi.stubEnv('TORCHIKO_LOCAL_DIRECT_QUERY', '1')
    anthropicCreate.mockResolvedValueOnce(message(countPlan))
    const result = await caller.chat.send(input)
    expect(anthropicCreate).toHaveBeenCalledOnce()
    expect(gatewayCalls).toHaveLength(1)
    expect(accounting.exact.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(guestTurnActions.dispatch.mock.calls.filter(([call]) => call.operation.kind === 'RESPONSE_GENERATION')).toHaveLength(1)
    expect(guestTurnActions.finalize).toHaveBeenCalledOnce()
    expect(result.response).toBe('1 matching listed record.\n\nThis describes listed entries, not a complete physical inventory or a live availability check.')
    const retained = metadata().answerEvidence
    expect(retained.sources).toHaveLength(1)
    expect(retained.system.staticPart).toContain('notDispatchedModelPrompt=true')
    const profile = JSON.parse(retained.sources[0].snapshot)
    expect(profile.answerMode).toBe('LOCAL_DETERMINISTIC')
    expect(profile.plannerInvocationId).toBe(gatewayCalls[0]!.invocationId)
    expect(profile.plannerUsageReference).toBe('usage-record')
    expect(profile.structuredQuery).toMatchObject({ sourceVersion: 'v1', formatterVersion: 'guest-query-direct-answer-v3', query: { mode: 'count' } })
    expect(profile.structuredQuery.plannerResponse).toBe(countPlan)
    expect(retained.routeConfigurationVersion).toBe((gatewayCalls[0]!.route as { configurationVersion: string }).configurationVersion)
    expect(metadata()).not.toHaveProperty('actionPlacements')
    guestTurnActions.reserve.mockResolvedValueOnce({ state: 'COMPLETE', ...result, citations: [], replayed: true })
    expect((await caller.chat.send(input)).response).toBe(result.response)
    expect(anthropicCreate).toHaveBeenCalledOnce()
    expect(guestTurnActions.finalize).toHaveBeenCalledOnce()
  })
  it('streams exact direct conditions literally with no answer provider timing or engagement/action interpretation', async () => {
    vi.stubEnv('TORCHIKO_LOCAL_DIRECT_QUERY', '1')
    anthropicCreate.mockResolvedValueOnce(message(rawPlan))
    const events = []
    for await (const event of streamChatTurn(ctx, input)) events.push(event)
    const text = events.filter(event => event.type === 'delta').map(event => event.type === 'delta' ? event.delta : '').join('')
    expect(anthropicCreate).toHaveBeenCalledOnce()
    expect(text).toBe(guestTurnActions.finalize.mock.calls[0]![0].input.assistantResponse)
    expect(text).toContain('closed October 20–22')
    expect(events.find(event => event.type === 'delta')).toMatchObject({ providerFirstTextMs: null })
    expect(JSON.stringify(events)).not.toContain('"predicates"')
    expect(metadata()).not.toHaveProperty('actionPlacements')
    expect(guestTurnActions.finalize.mock.calls[0]![0].input.nextPending).toEqual({ kind: 'NONE' })
    expect(JSON.stringify(metadata().answerEvidence)).toContain(restriction)
  })
  it.each(['source', 'native', 'configuration'])('rejects direct authority change before any visible delta: %s', async change => {
    vi.stubEnv('TORCHIKO_LOCAL_DIRECT_QUERY', '1')
    anthropicCreate.mockImplementationOnce(async () => {
      if (change === 'source') loadQuerySource.mockResolvedValue(source('v2'))
      if (change === 'native') resolveNativeGuestReadSnapshotAction.mockResolvedValue({ path: 'NATIVE', reason: 'NATIVE_READY', releaseId: 'new-release', state: null })
      if (change === 'configuration') aiWorkloadConfigurationOverrideFindFirst.mockResolvedValue({ enabled: true, isTombstone: false, timeoutMs: 9000, timeoutMsSet: true, unsafeChangesEnabled: false, reason: 'Timeout changed during planner' })
      return message(countPlan)
    })
    const events = []
    for await (const event of streamChatTurn(ctx, input)) events.push(event)
    expect(anthropicCreate).toHaveBeenCalledOnce()
    expect(events.filter(event => event.type === 'delta')).toEqual([])
    expect(guestTurnActions.finalize).toHaveBeenCalledOnce()
    expect(guestTurnActions.finalize.mock.calls[0]![0].input.assistantResponse).not.toContain('matching listed record')
    expect(metadata()).not.toHaveProperty('answerEvidence')
  })
  it('keeps the existing one-planner one-answer path when the direct formatter is unsupported', async () => {
    vi.stubEnv('TORCHIKO_LOCAL_DIRECT_QUERY', '1')
    queue(JSON.stringify({ status: 'QUERY', mode: 'list', predicates: [{ field: 'feature', name: 'wheelchairAccessible', value: true }] }))
    expect((await caller.chat.send(input)).response).toBe('ANSWER_VISIBLE')
    expect(anthropicCreate).toHaveBeenCalledTimes(2)
    expect(gatewayCalls[0]!.budgetGate).toBe(gatewayCalls[1]!.budgetGate)
  })
  it('falls back before direct emission for a 10k-plus body that cannot pass durable finalization', async () => {
    vi.stubEnv('TORCHIKO_LOCAL_DIRECT_QUERY', '1')
    const oversized = source()
    oversized.directory.places[0]!.longDescription = 'TOO_LONG_DIRECT ' + 'x'.repeat(10_001)
    loadQuerySource.mockResolvedValue(oversized)
    queue()
    const stream = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ANSWER_VISIBLE' } }
      },
      finalMessage: vi.fn().mockResolvedValue(message('ANSWER_VISIBLE')),
    }))
    _setAnthropicClientForTesting({
      messages: { create: anthropicCreate, stream },
    } as unknown as AnthropicMessagesClient)
    const events = []
    for await (const event of streamChatTurn(ctx, input)) events.push(event)
    expect(gatewayCalls).toHaveLength(2)
    expect(
      events
        .filter((event) => event.type === 'delta')
        .map((event) => (event.type === 'delta' ? event.delta : ''))
        .join(''),
    ).not.toContain('TOO_LONG_DIRECT')
    expect(
      guestTurnActions.finalize.mock.calls[0]![0].input.assistantResponse.length,
    ).toBeLessThanOrEqual(10_000)
    expect(metadata().answerEvidence.system.staticPart).not.toContain('LOCAL_DETERMINISTIC')
  })
  it('falls back before direct emission when a retained whole source exceeds evidence snapshot bounds', async () => {
    vi.stubEnv('TORCHIKO_LOCAL_DIRECT_QUERY', '1')
    const oversized = source()
    oversized.directory.places[0]!.tags = ['x'.repeat(170_000)]
    loadQuerySource.mockResolvedValue(oversized)
    queue()
    expect((await caller.chat.send(input)).response).toBe('ANSWER_VISIBLE')
    expect(anthropicCreate).toHaveBeenCalledTimes(2)
    expect(metadata().answerEvidence.system.staticPart).not.toContain('LOCAL_DETERMINISTIC')
  })
  it.each([98, 99])('enforces 100 retained sources including profile for direct lists: %i topics', async count => {
    vi.stubEnv('TORCHIKO_LOCAL_DIRECT_QUERY', '1')
    const current = source()
    current.directory.knowledge = Array.from({ length: count }, (_, i) => topic(`condition-${i}`, 'R.'))
    loadQuerySource.mockResolvedValue(current)
    queue()
    await caller.chat.send(input)
    if (count === 98) {
      expect(anthropicCreate).toHaveBeenCalledOnce()
      expect(metadata().answerEvidence.sources).toHaveLength(100)
      expect(metadata().answerEvidence.system.staticPart).toContain('LOCAL_DETERMINISTIC')
    } else {
      expect(anthropicCreate).toHaveBeenCalledTimes(2)
      expect(metadata().answerEvidence.sources.length).toBeLessThanOrEqual(100)
      expect(metadata().answerEvidence.system.staticPart).not.toContain('LOCAL_DETERMINISTIC')
    }
  })
  it('retains exact canonical policy bodies in a direct product answer without model rewriting', async () => {
    vi.stubEnv('TORCHIKO_LOCAL_DIRECT_QUERY', '1')
    const current = source()
    current.directory.knowledge = []
    const whole = 'Each kit costs $8 — weekends only. Children under 10 need a paid adult. No refunds.'
    const payloads: GeneralizedContentPayload[] = [
      { kind: 'SERVICE', name: 'Moon counter', placeId: 'moon', availability: 'Saturdays only.' },
      { kind: 'ITEM', name: 'Sketch kit', itemType: 'PRODUCT' },
      { kind: 'RELATIONSHIP', fromModuleId: 'direct-0', toModuleId: 'direct-1', relationshipType: 'OFFERS_PRODUCT_V1' },
      { kind: 'POLICY', title: 'Purchase terms', rule: whole, appliesTo: ['direct-0'] },
    ]
    current.canonicalModules = { contract: 'published-query-source-v1', modules: payloads.map((payload, i) => ({ moduleId: `direct-${i}`, revisionId: `direct-revision-${i}`, publicationId: `direct-publication-${i}`, publicationOrder: String(i + 1), version: 1, kind: payload.kind, payload, audience: 'PUBLIC', effectiveFrom: null, effectiveUntil: null, evidence: [] })) }
    loadQuerySource.mockResolvedValue(current)
    anthropicCreate.mockResolvedValueOnce(message(JSON.stringify({ status: 'QUERY', mode: 'list', predicates: [{ field: 'product', name: 'Sketch kit' }] })))
    const events = []
    for await (const event of streamChatTurn(ctx, input)) events.push(event)
    expect(anthropicCreate).toHaveBeenCalledOnce()
    const answer = guestTurnActions.finalize.mock.calls[0]![0].input.assistantResponse
    expect(answer).toContain('$8 — weekends only')
    expect(answer).toContain('Children under 10 need a paid adult')
    const policyEvidence = metadata().answerEvidence.sources.find((s: { sourceId: string }) => s.sourceId === 'published-content:direct-3:direct-revision-3')
    expect(JSON.parse(policyEvidence.snapshot).payload.rule).toBe(whole)
    expect(events.filter(e => e.type === 'delta').map(e => e.type === 'delta' ? e.delta : '').join('')).toBe(answer)
    expect(metadata()).not.toHaveProperty('actionPlacements')
  })
  it('resolves a current-question entity ref through the one-planner direct path and retains its catalog receipt', async () => {
    vi.stubEnv('TORCHIKO_LOCAL_DIRECT_QUERY', '1')
    const raw = JSON.stringify({ status: 'QUERY', mode: 'list', domain: 'PLACE', predicates: [{ field: 'entity', ref: 'n0' }, { field: 'kind', equals: 'ATTRACTION' }, { field: 'area', equals: 'North' }] })
    anthropicCreate.mockResolvedValueOnce(message(raw))
    const question = 'Quote every condition for Moon Ride.'
    const events = []
    for await (const event of streamChatTurn(ctx, { ...input, message: question })) events.push(event)
    expect(anthropicCreate).toHaveBeenCalledOnce()
    const planner = gatewayCalls[0]!.system as Array<{ text: string }>
    expect(planner[0]!.text).toContain('"ref":"n0"')
    expect(planner[0]!.text).toContain('"name":"Moon Ride"')
    expect(planner[0]!.text).not.toContain('place:moon')
    const profile = JSON.parse(metadata().answerEvidence.sources.find((s: { kind: string }) => s.kind === 'VENUE_PROFILE').snapshot)
    expect(profile.structuredQuery.query.predicates).toEqual([{ field: 'key', equals: 'place:moon' }, { field: 'kind', equals: 'ATTRACTION' }, { field: 'area', equals: 'North' }])
    expect(profile.structuredQuery.nameCatalog).toMatchObject({ contract: 'guest-named-catalog-v1', sourceVersion: 'v1', status: 'READY', coordinates: 'NORMALIZED_UNICODE_CODEPOINTS' })
    expect(profile.structuredQuery.nameCatalog.questionSha256).toBe(profile.structuredQuery.questionSha256)
    expect(profile.structuredQuery.nameCatalog.groups[0].record.key).toBe('place:moon')
    const text = events.filter(e => e.type === 'delta').map(e => e.type === 'delta' ? e.delta : '').join('')
    expect(text).toBe(guestTurnActions.finalize.mock.calls[0]![0].input.assistantResponse)
    expect(text).toContain('closed October 20–22')
  })
  it.each(['partial', 'ambiguous', 'domain'])('rejects %s named plans before a misleading direct zero', async mode => {
    vi.stubEnv('TORCHIKO_LOCAL_DIRECT_QUERY', '1')
    const current = source()
    if (mode === 'ambiguous') current.directory.places.push({ ...current.directory.places[0]!, id: 'other-moon' })
    loadQuerySource.mockResolvedValue(current)
    queue(JSON.stringify({ status: 'QUERY', mode: 'list', domain: mode === 'domain' ? 'KNOWLEDGE' : 'PLACE', predicates: [mode === 'partial' ? { field: 'name', equals: 'Ride' } : { field: 'entity', ref: 'n0' }] }))
    const response = await caller.chat.send({ ...input, message: 'Quote every condition for Moon Ride.' })
    expect(anthropicCreate).toHaveBeenCalledTimes(2)
    expect(response.response).toBe('ANSWER_VISIBLE')
    expect(metadata().answerEvidence.system.staticPart).not.toContain('LOCAL_DETERMINISTIC')
  })
  it('does not obtain name aliases from place tags or whole descriptive prose', async () => {
    vi.stubEnv('TORCHIKO_LOCAL_DIRECT_QUERY', '1')
    const current = source()
    current.directory.places[0]!.tags = ['Secret Alias']
    current.directory.places[0]!.longDescription = 'Staff sometimes say Secret Alias. ' + restriction
    loadQuerySource.mockResolvedValue(current)
    queue(JSON.stringify({ status: 'QUERY', mode: 'list', predicates: [{ field: 'entity', ref: 'n0' }] }))
    await caller.chat.send({ ...input, message: 'Show Secret Alias.' })
    expect(anthropicCreate).toHaveBeenCalledTimes(2)
    const planner = gatewayCalls[0]!.system as Array<{ text: string }>
    expect(planner[0]!.text).toContain('"groups":[]')
    expect(planner[0]!.text).not.toContain('Secret Alias')
  })
  it('rechecks native/source authority after a named planner before emitting direct text', async () => {
    vi.stubEnv('TORCHIKO_LOCAL_DIRECT_QUERY', '1')
    anthropicCreate.mockImplementationOnce(async () => {
      const withdrawn = source('v2')
      withdrawn.directory.places = []
      loadQuerySource.mockResolvedValue(withdrawn)
      return message(JSON.stringify({ status: 'QUERY', mode: 'list', predicates: [{ field: 'entity', ref: 'n0' }] }))
    })
    const events = []
    for await (const event of streamChatTurn(ctx, { ...input, message: 'Show Moon Ride.' })) events.push(event)
    expect(anthropicCreate).toHaveBeenCalledOnce()
    expect(events.filter(e => e.type === 'delta')).toEqual([])
    expect(metadata()).not.toHaveProperty('answerEvidence')
  })
})
