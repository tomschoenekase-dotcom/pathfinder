import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guestReplyKindFromFallbackCode } from '@pathfinder/contracts/guest-reply-kind'
import type { GuestQuerySource } from '../lib/guest-query-source'
import type { GeneralizedContentPayload } from '@pathfinder/contracts/universal-content-actions'

import {
  AI_MODEL_REGISTRY,
  textAttemptCostCeilingUnits,
  setOpenAiEmbeddingsClientForTesting,
  setOpenAiResponsesClientForTesting,
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

const queryTrace = vi.hoisted(() => [] as Array<{ status: string; reason: string | null }>)
vi.mock('../lib/guest-query-chat-experiment', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/guest-query-chat-experiment')>()
  return {
    ...original,
    prepareGuestChatQueryExperiment: async (
      ...args: Parameters<typeof original.prepareGuestChatQueryExperiment>
    ) => {
      const result = await original.prepareGuestChatQueryExperiment(...args)
      queryTrace.push({ status: result.status, reason: 'reason' in result ? result.reason : null })
      return result
    },
  }
})

import { router } from '../core'
import type { TRPCContext } from '../context'
import { _setAnthropicClientForTesting, chatRouter } from './chat'
import { captureGuestQueryTiming } from '../lib/guest-query-timing'
import { guestCanonicalAliasBody } from '../lib/guest-query-whole-sources'
import { isAbsolute, join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'

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

describe('Sol evaluation capture through actual chat.send and gateway (provider/DB mocked)', () => {
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
    vi.unstubAllGlobals()
    _setAnthropicClientForTesting(null)
    setOpenAiEmbeddingsClientForTesting(null)
    setOpenAiResponsesClientForTesting(null)
  })

  const restriction =
    'STRUCTURED_ONLY: minimum 48 inches; under 10 with a paid adult; closed October 20–22. Booking never waives restrictions.'
  const policy = 'STRUCTURED_POLICY: $8 per rider; weekends only; no exceptions to age or height.'
  const baseline = 'BASELINE_ONLY: Please consult the desk for the current conditions.'
  const input = { venueId: VENUE_ID, anonymousToken: TOKEN, message: 'List attractions.' }
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
    vi.stubEnv('GUEST_CHAT_DEFAULT_MODEL_KEY', 'guest-chat-sol')
    vi.stubEnv('TORCHIKO_LOCAL_DIRECT_QUERY', '')
    vi.stubEnv('TORCHIKO_LOCAL_LUNA_PLANNER_PROFILE', '')
    vi.stubEnv('TORCHIKO_LOCAL_QUERY_COMPILE_REUSE', '')
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('NETWORK_FORBIDDEN_OFFLINE_CAPTURE')
      }),
    )
    gatewayCalls.length = 0
    queryTrace.length = 0
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
  function metadata() {
    return guestTurnActions.finalize.mock.calls[0]![0].input.replayMetadata
  }
  function structuredSummary() {
    const profile = metadata().answerEvidence.sources.find(
      (row: { kind: string }) => row.kind === 'VENUE_PROFILE',
    )
    return JSON.parse(profile.snapshot).structuredQuery
  }

  function declaredSource(totalModules: number) {
    const current = source()
    const payloads: GeneralizedContentPayload[] = [
      { kind: 'SERVICE', name: 'River Skiff', placeId: null },
      {
        kind: 'OPERATIONAL_FACT',
        label: 'Moon schedule',
        value: 'Moon Ride closes at 6 PM.',
        applicability: { scope: 'SUBJECTS', subjectModuleIds: [], placeIds: ['moon'] },
      },
      {
        kind: 'OPERATIONAL_FACT',
        label: 'Admission',
        value: 'Admission ends at 5 PM.',
        applicability: { scope: 'VENUE' },
      },
      { kind: 'OPERATIONAL_FACT', label: 'Water', value: 'Drinking water is free.' },
      {
        kind: 'OPERATIONAL_FACT',
        label: 'Shared queue',
        value: 'Moon Ride and River Skiff share one queue, except during evening shows.',
        applicability: {
          scope: 'SUBJECTS',
          subjectModuleIds: ['evaluation-0'],
          placeIds: ['moon'],
        },
      },
      ...Array.from(
        { length: totalModules - 5 },
        (_, i): GeneralizedContentPayload => ({
          kind: 'OPERATIONAL_FACT',
          label: `Skiff notice ${i}`,
          value: `River Skiff boarding note ${i}.`,
          applicability: { scope: 'SUBJECTS', subjectModuleIds: ['evaluation-0'], placeIds: [] },
        }),
      ),
    ]
    current.canonicalModules = {
      contract: 'published-query-source-v1',
      modules: payloads.map((payload, i) => ({
        moduleId: `evaluation-${i}`,
        revisionId: `evaluation-r${i}`,
        publicationId: `evaluation-p${i}`,
        publicationOrder: String(i + 1),
        kind: payload.kind,
        payload,
        version: 1,
        audience: 'PUBLIC',
        effectiveFrom: null,
        effectiveUntil: null,
        evidence: [],
      })),
    }
    current.version = createHash('sha256')
      .update(JSON.stringify(current.canonicalModules))
      .digest('hex')
    current.directory.searchVersion = current.version
    return current
  }

  function sdkResponse(text: string, id: string) {
    return {
      id,
      model: 'gpt-6.1-sol',
      status: 'completed',
      output_text: text,
      service_tier: 'default',
      usage: {
        input_tokens: 123,
        output_tokens: 17,
        total_tokens: 140,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 5 },
      },
    }
  }
  function capture(name: string, value: unknown) {
    const folder = process.env.TORCHIKO_EVALUATION_CAPTURE_DIR
    if (!folder) return
    if (!isAbsolute(folder))
      throw new Error('Absolute existing external capture directory required')
    writeFileSync(join(folder, `${name}.json`), JSON.stringify(value, null, 2) + '\n', {
      flag: 'wx',
    })
  }
  it.each([5, 115, 10_000])(
    'captures a useful scoped Sol route with exactly %i modules',
    async (total) => {
      const current = declaredSource(total)
      loadQuerySource.mockResolvedValue(current)
      const create = vi
        .fn()
        .mockResolvedValueOnce(
          sdkResponse(
            JSON.stringify({ status: 'EVIDENCE_SUBJECTS', refs: ['n0'] }),
            'mock-planner',
          ),
        )
        .mockResolvedValueOnce(sdkResponse('OFFLINE_TRANSPORT_FIXTURE_ONLY', 'mock-answer'))
      setOpenAiResponsesClientForTesting({ responses: { create } })
      const timed = await captureGuestQueryTiming(() =>
        caller.chat.send({ ...input, message: 'Full details for Moon Ride.' }),
      )
      expect(create).toHaveBeenCalledTimes(2)
      expect(anthropicCreate).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
      const sdk = create.mock.calls.map(([request]) => request)
      for (const request of sdk)
        expect(request).toMatchObject({
          model: 'gpt-6.1-sol',
          reasoning: { effort: 'low' },
          store: false,
        })
      expect(sdk[0].max_output_tokens).toBe(1024)
      expect(sdk[1].max_output_tokens).toBe(2048)
      const [planner, answer] = gatewayCalls
      expect(planner!.invocationId).not.toBe(answer!.invocationId)
      expect(planner!.maxAttempts).toBe(1)
      expect(planner!.budgetGate).toBe(answer!.budgetGate)
      expect(planner!.admissionGuard).toBe(answer!.admissionGuard)
      const retained = metadata().answerEvidence.sources.filter(
        (row: { kind: string }) => row.kind === 'PUBLISHED_CONTENT',
      )
      expect(retained.map((row: { sourceId: string }) => row.sourceId).sort()).toEqual(
        [0, 1, 2, 3, 4].map((i) => `published-content:evaluation-${i}:evaluation-r${i}`),
      )
      for (const row of retained)
        expect(JSON.parse(row.snapshot)).toEqual(
          current.canonicalModules!.modules.find(
            (m) => row.sourceId === `published-content:${m.moduleId}:${m.revisionId}`,
          ),
        )
      const summary = structuredSummary()
      expect(summary.declaredFactApplicability).toEqual({
        omissionAllowed: true,
        omittedFactCount: total - 5,
        omittedFactAliasCount: 0,
      })
      const prompt = JSON.stringify(sdk[1])
      for (const body of [
        'Moon Ride closes at 6 PM.',
        'Admission ends at 5 PM.',
        'Drinking water is free.',
        'except during evening shows.',
      ])
        expect(prompt).toContain(body)
      expect(prompt).not.toContain('River Skiff boarding note')
      expect(timed.spans.some((span) => span.stage === 'planner.wait')).toBe(true)
      expect(timed.value.response).toBe('OFFLINE_TRANSPORT_FIXTURE_ONLY')
      const spec = AI_MODEL_REGISTRY['guest-chat-sol']
      const ceilings = gatewayCalls.map((call) =>
        textAttemptCostCeilingUnits({
          spec,
          system: call.system as never,
          messages: call.messages as never,
          maxOutputTokens: call.maxOutputTokens as number,
        }).toString(),
      )
      capture(`sol-scoped-${total}`, {
        schema: 'sol-router-offline-capture-v1',
        qualityMeasured: false,
        providerCalls: 0,
        mockedSdkResponses: 2,
        fixtureModules: total,
        sourceVersion: current.version,
        sdkRequests: sdk,
        ceilingsE8Usd: ceilings,
        summary,
        answerEvidence: metadata().answerEvidence,
        timingSpans: timed.spans,
        timingClass: 'MOCK_TRANSPORT_LOCAL_ONLY',
      })
    },
    120_000,
  )

  it('keeps the production baseline even when the local structured flag is set', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const create = vi
      .fn()
      .mockResolvedValue(sdkResponse('OFFLINE_BASELINE_FIXTURE_ONLY', 'mock-baseline'))
    setOpenAiResponsesClientForTesting({ responses: { create } })
    await caller.chat.send(input)
    expect(create).toHaveBeenCalledOnce()
    expect(loadQuerySource).not.toHaveBeenCalled()
    expect(gatewayCalls).toHaveLength(1)
    expect(structuredSummary()).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('separates an unsupported planner fallback from structured-route success', async () => {
    loadQuerySource.mockResolvedValue(declaredSource(115))
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        sdkResponse(
          JSON.stringify({ status: 'UNSUPPORTED', reason: 'Ambiguous selection' }),
          'mock-unsupported',
        ),
      )
      .mockResolvedValueOnce(sdkResponse('OFFLINE_FALLBACK_FIXTURE_ONLY', 'mock-fallback'))
    setOpenAiResponsesClientForTesting({ responses: { create } })
    await caller.chat.send({ ...input, message: 'Which attractions are open right now?' })
    expect(create).toHaveBeenCalledTimes(2)
    expect(structuredSummary()).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('blocks the answer SDK call after a declaration-only source change', async () => {
    const current = declaredSource(115),
      changed = structuredClone(current)
    const payload = changed.canonicalModules!.modules[5]!.payload
    if (payload.kind !== 'OPERATIONAL_FACT') throw new Error('Expected fact')
    payload.applicability = { scope: 'VENUE' }
    changed.version = createHash('sha256')
      .update(JSON.stringify(changed.canonicalModules))
      .digest('hex')
    changed.directory.searchVersion = changed.version
    loadQuerySource.mockResolvedValue(current)
    const create = vi.fn().mockImplementationOnce(async () => {
      loadQuerySource.mockResolvedValue(changed)
      return sdkResponse(
        JSON.stringify({ status: 'EVIDENCE_SUBJECTS', refs: ['n0'] }),
        'mock-stale',
      )
    })
    setOpenAiResponsesClientForTesting({ responses: { create } })
    await caller.chat.send({ ...input, message: 'Full details for Moon Ride.' })
    expect(create).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
    expect(metadata()).not.toHaveProperty('answerEvidence')
  })
  it.skipIf(!process.env.TORCHIKO_SOL_STAGE_CONFIG)(
    'runs one sealed provider-dark capture or raw replay stage',
    async () => {
      const config = JSON.parse(readFileSync(process.env.TORCHIKO_SOL_STAGE_CONFIG!, 'utf8'))
      expect(Object.keys(config).sort()).toEqual(
        ['arm', 'case', 'fixtureModules', 'output', 'phase', 'replays', 'schema'].sort(),
      )
      expect(config.schema).toBe('torchiko-sol-router-stage-v1')
      expect(Object.keys(config.case).sort()).toEqual(
        ['caseId', 'clock', 'fixtureId', 'fixtureSha256', 'question', 'timeZone'].sort(),
      )
      expect([5, 115, 10_000]).toContain(config.fixtureModules)
      expect(['FIXTURE', 'CAPTURE', 'REPLAY']).toContain(config.phase)
      expect(['STRUCTURED', 'BASELINE']).toContain(config.arm)
      expect(isAbsolute(config.output)).toBe(true)
      expect(Array.isArray(config.replays)).toBe(true)
      expect(config.replays.length).toBeLessThanOrEqual(2)
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(config.case.clock))
      try {
        const current = declaredSource(config.fixtureModules)
        current.asOf = config.case.clock
        current.directory.knowledge.push(
          ...current.canonicalModules!.modules.map((module) => {
            const body = guestCanonicalAliasBody(module)!
            return {
              ...topic(`alias-${module.moduleId}`, body.content),
              title: body.title,
              category: module.kind,
              sourceType: 'UNIVERSAL_CONTENT',
              contentModuleId: module.moduleId,
              contentRevisionId: module.revisionId,
              contentPublicationId: module.publicationId,
            }
          }),
        )
        Object.assign(fixtureDirectory, structuredClone(current.directory))
        venueKnowledgeEntryFindMany.mockResolvedValue(current.directory.knowledge)
        semanticSearch.knowledge.mockResolvedValue(
          current.directory.knowledge.slice(0, 10).map((row) => ({ ...row, distance: 0.1 })),
        )
        semanticSearch.places.mockResolvedValue(current.directory.places)
        placeFindMany.mockResolvedValue(current.directory.places)
        const underlyingSourceSha256 = createHash('sha256')
          .update(
            JSON.stringify({
              places: fixtureDirectory.places,
              knowledge: fixtureDirectory.knowledge,
              canonicalModules: current.canonicalModules,
            }),
          )
          .digest('hex')
        const sourceSha256 = createHash('sha256').update(JSON.stringify(current)).digest('hex')
        if (config.phase !== 'FIXTURE') expect(sourceSha256).toBe(config.case.fixtureSha256)
        loadQuerySource.mockResolvedValue(current)
        aiWorkloadConfigurationOverrideFindFirst.mockResolvedValue({
          enabled: true,
          isTombstone: false,
          maxAttemptsSet: true,
          maxAttempts: 1,
          fallbackEnabledSet: true,
          fallbackEnabled: false,
          fallbackModelKeys: [],
          reason: 'Local evaluation single-attempt isolation',
          unsafeChangesEnabled: false,
        })
        if (config.arm === 'BASELINE') {
          vi.stubEnv('TORCHIKO_LOCAL_STRUCTURED_QUERY', '')
          vi.stubEnv('GUEST_GUIDE_STRATEGY', '')
        }
        const requests: unknown[] = []
        const create = vi.fn().mockImplementation(async (request) => {
          request.service_tier = 'default'
          requests.push(structuredClone(request))
          const replay = config.replays[requests.length - 1]
          if (!replay) throw new Error('OFFLINE_CAPTURE_BOUNDARY_NO_PROVIDER')
          expect(createHash('sha256').update(JSON.stringify(request)).digest('hex')).toBe(
            replay.requestSha256,
          )
          return structuredClone(replay.response)
        })
        setOpenAiResponsesClientForTesting({ responses: { create } })
        const timed =
          config.phase === 'FIXTURE'
            ? null
            : await captureGuestQueryTiming(() =>
                caller.chat.send({ ...input, message: config.case.question }),
              )
        expect(fetch).not.toHaveBeenCalled()
        expect(anthropicCreate).not.toHaveBeenCalled()
        writeFileSync(
          config.output,
          JSON.stringify(
            {
              schema: 'torchiko-sol-router-stage-result-v1',
              phase: config.phase,
              arm: config.arm,
              caseId: config.case.caseId,
              fixtureModules: config.fixtureModules,
              sourceSha256,
              sourceVersion: current.version,
              underlyingSourceSha256,
              transportProfile: 'EVALUATION_EXPLICIT_STANDARD_TIER_V1',
              sourceSnapshot: config.phase === 'FIXTURE' ? current : undefined,
              requests,
              gatewayCalls: gatewayCalls.map((call) => ({
                maxAttempts: call.maxAttempts,
                maxOutputTokens: call.maxOutputTokens,
                route: call.route,
                system: call.system,
                messages: call.messages,
              })),
              response: timed?.value.response ?? null,
              metadata: guestTurnActions.finalize.mock.calls[0]?.[0]?.input.replayMetadata ?? null,
              timingSpans: timed?.spans ?? [],
              queryTrace,
              providerCalls: 0,
              replaysUsed: config.replays.length,
              qualityMeasured: false,
              evidenceClass: 'ACTUAL_ROUTER_WITH_MOCKED_DB_AND_PROVIDER_REPLAY',
            },
            null,
            2,
          ) + '\n',
          { flag: 'wx' },
        )
      } finally {
        vi.useRealTimers()
      }
    },
    120_000,
  )
})
