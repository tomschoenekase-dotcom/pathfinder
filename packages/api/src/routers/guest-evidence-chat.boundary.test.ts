import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guestReplyKindFromFallbackCode } from '@pathfinder/contracts/guest-reply-kind'
import { guestBeforeOpeningCue } from '../lib/guest-before-opening'

import {
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
  places: [],
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

describe('evidence strategy actual chat boundaries', () => {
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
  const currentBody =
    'Hours: Orchid Museum, 2 pm - 6 pm Saturday\nNEW_POLICY_SENTINEL: advance booking is required after 4pm.'
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
  function liveReads() {
    return venueKnowledgeEntryFindMany.mock.calls.filter(
      ([args]) => Array.isArray(args.where?.id?.in) && args.take === args.where.id.in.length,
    )
  }
  function configureLive(rows: Array<Record<string, unknown>>, failure = false) {
    venueKnowledgeEntryFindMany.mockImplementation(async (args) => {
      if (Array.isArray(args.where?.id?.in) && args.take === args.where.id.in.length) {
        if (failure) throw new Error('independent synthetic authority failure')
        return rows
      }
      return [topic()]
    })
  }

  it('replaces stale directory and already retrieved whole bodies before provider context and hours cues', async () => {
    configureLive([topic(currentBody)])
    await caller.chat.send(input)
    const text = prompt()
    expect(text).toContain(currentBody)
    expect(text).not.toContain(oldBody)
    expect(text).not.toContain('OLD_POLICY_SENTINEL')
    expect(text).not.toMatch(/regular 12 pm opening/iu)
    expect(liveReads().length).toBeGreaterThan(0)
  })

  it('uses one admitted current core body across prefix and question evidence without a second-read withdrawal race', async () => {
    semanticSearch.knowledge.mockResolvedValue([])
    let selectedIdReads = 0
    venueKnowledgeEntryFindMany.mockImplementation(async (args) => {
      if (Array.isArray(args.where?.id?.in)) {
        selectedIdReads += 1
        // A second read would observe a later withdrawal. This turn must use its one admitted
        // core observation consistently rather than mixing two versions across prompt lanes.
        return selectedIdReads === 1 ? [topic(currentBody)] : []
      }
      return []
    })
    await caller.chat.send(input)
    expect(selectedIdReads).toBe(1)
    const text = prompt()
    expect(text).toContain(currentBody)
    expect(text).not.toContain('OLD_POLICY_SENTINEL')
    const evidence = guestTurnActions.finalize.mock.calls[0]![0].input.replayMetadata.answerEvidence
    expect(evidence.system.staticPart).toContain(currentBody)
    expect(evidence.system.dynamicPart).not.toContain('OLD_POLICY_SENTINEL')
    expect(JSON.stringify(evidence.sources)).toContain('NEW_POLICY_SENTINEL')
  })

  it.each(['updated', 'withdrawn', 'failed'] as const)(
    'keeps noncore question evidence live (%s) without rereading or losing admitted core',
    async (outcome) => {
      const oldNoncore = {
        ...topic(),
        id: 'independent-exhibit',
        category: 'EXHIBITS',
        title: 'Orchid exhibit access',
        content: 'OLD_NONCORE_ACCESS: access was unrestricted.',
      }
      const currentNoncore = {
        ...oldNoncore,
        content: 'CURRENT_NONCORE_ACCESS: access requires a staff escort.',
      }
      fixtureDirectory.knowledge = [topic(), oldNoncore]
      semanticSearch.knowledge.mockResolvedValue([])
      const coreReads: string[][] = []
      const otherReads: string[][] = []
      venueKnowledgeEntryFindMany.mockImplementation(async (args) => {
        const ids = args.where?.id?.in as string[] | undefined
        if (!ids) return []
        if (ids.includes('independent-hours')) {
          coreReads.push(ids)
          return [topic(currentBody)]
        }
        otherReads.push(ids)
        if (outcome === 'failed') throw new Error('synthetic noncore body failure')
        return outcome === 'updated' ? [currentNoncore] : []
      })
      await caller.chat.send({
        ...input,
        message: 'What are the opening hours and Orchid exhibit access rules?',
      })
      const text = prompt()
      expect(coreReads).toEqual([['independent-hours']])
      expect(otherReads).toEqual([['independent-exhibit']])
      expect(text).toContain(currentBody)
      expect(text).not.toContain('OLD_POLICY_SENTINEL')
      expect(text).not.toContain('OLD_NONCORE_ACCESS')
      if (outcome === 'updated') expect(text).toContain(currentNoncore.content)
      else expect(text).not.toContain('CURRENT_NONCORE_ACCESS')
      if (outcome === 'failed')
        expect(configLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'guest-question-evidence-revalidation-failed' }),
        )
    },
  )

  it('removes withdrawn core from prefix, retrieved context and opening-status cues', async () => {
    configureLive([])
    await caller.chat.send(input)
    const text = prompt()
    expect(text).not.toContain(oldBody)
    expect(text).not.toContain('OLD_POLICY_SENTINEL')
    expect(text).not.toMatch(/regular 12 pm opening/iu)
    const evidence = guestTurnActions.finalize.mock.calls[0]![0].input.replayMetadata.answerEvidence
    expect(JSON.stringify(evidence)).not.toContain('OLD_POLICY_SENTINEL')
  })

  it('does not resurrect old core when its authority reread fails', async () => {
    configureLive([], true)
    await caller.chat.send(input)
    const text = prompt()
    expect(text).not.toContain('OLD_POLICY_SENTINEL')
    expect(text).not.toMatch(/regular 12 pm opening/iu)
    expect(configLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'guest-index-core-revalidation-failed' }),
    )
  })

  it('drops a 100k current replacement from every lane without truncation or stale fallback', async () => {
    const hugeBody = `CURRENT_HUGE_BEGIN_${'synthetic '.repeat(10_000)}_CURRENT_HUGE_END`
    configureLive([topic(hugeBody)])
    await caller.chat.send(input)
    const text = prompt()
    expect(text).not.toContain('OLD_POLICY_SENTINEL')
    expect(text).not.toContain('CURRENT_HUGE_BEGIN_')
    expect(text).not.toMatch(/regular 12 pm opening/iu)
    expect(text).toMatch(/incomplete|partial|lower bounds/iu)
    const evidence = guestTurnActions.finalize.mock.calls[0]![0].input.replayMetadata.answerEvidence
    expect(JSON.stringify(evidence)).not.toContain('OLD_POLICY_SENTINEL')
    expect(JSON.stringify(evidence)).not.toContain('CURRENT_HUGE_BEGIN_')
  })

  it('keeps native snapshot core immutable and performs no legacy selected-ID reread', async () => {
    const nativeBody = 'NATIVE_SNAPSHOT_POLICY: Admission requires a reservation.'
    resolveNativeGuestReadSnapshotAction.mockResolvedValue({
      path: 'NATIVE',
      reason: 'NATIVE_READY',
      releaseId: '11111111-1111-4111-8111-111111111111',
      state: { places: [], knowledgeEntries: [topic(nativeBody)] },
    })
    configureLive([topic('LEGACY_MUST_NOT_REPLACE_NATIVE')])
    await caller.chat.send(input)
    const text = prompt()
    expect(text).toContain(nativeBody)
    expect(text).not.toContain('LEGACY_MUST_NOT_REPLACE_NATIVE')
    expect(text).not.toContain('OLD_POLICY_SENTINEL')
    expect(liveReads()).toEqual([])
  })

  it('never derives trusted opening status from cached hours outside the validated core budget', async () => {
    const admission = {
      ...topic(),
      id: 'budget-filling-admission',
      title: 'Admission policy',
      category: 'admission',
      content: `Booking is required. ${'admission condition '.repeat(165)}`,
    }
    const excludedHours = topic(`${oldBody} ${'stale schedule detail '.repeat(55)}`)
    fixtureDirectory.knowledge = [admission, excludedHours]
    semanticSearch.knowledge.mockResolvedValue([])
    venueKnowledgeEntryFindMany.mockImplementation(async (args) =>
      Array.isArray(args.where?.id?.in) && args.where.id.in.includes(admission.id)
        ? [admission]
        : [],
    )
    const question = 'Is Orchid Museum open now?'
    // Positive control: the discarded cached row would otherwise manufacture the trusted cue.
    expect(
      guestBeforeOpeningCue({
        question,
        now: new Date(),
        timeZone: 'America/Chicago',
        knowledge: [excludedHours],
        activeUpdates: [],
      }),
    ).toContain('regular 12 pm opening time')
    await caller.chat.send({ ...input, message: question })
    const text = prompt()
    expect(text).not.toContain('OLD_POLICY_SENTINEL')
    expect(text).not.toMatch(/regular 12 pm opening/iu)
    expect(text).not.toContain('CURRENT POSTED HOURS CHECK:')
    expect(liveReads()[0]?.[0].where.id.in).toEqual([admission.id])
  })

  it('keeps nonempty default-off and unknown-env prompts byte-identical without core rereads', async () => {
    configureLive([topic('UNREQUESTED_LIVE_CORE')])
    vi.stubEnv('GUEST_GUIDE_STRATEGY', undefined)
    await caller.chat.send(input)
    const defaultText = prompt()
    const defaultEvidence =
      guestTurnActions.finalize.mock.calls[0]![0].input.replayMetadata.answerEvidence.system
    expect(defaultText).toContain('VENUE GUIDE:')
    expect(defaultText).toContain(oldBody)
    expect(liveReads()).toEqual([])
    anthropicCreate.mockClear()
    guestTurnActions.finalize.mockClear()
    vi.stubEnv('GUEST_GUIDE_STRATEGY', 'EVIDENCE')
    await caller.chat.send(input)
    expect(prompt()).toBe(defaultText)
    expect(
      guestTurnActions.finalize.mock.calls[0]![0].input.replayMetadata.answerEvidence.system,
    ).toEqual(defaultEvidence)
    expect(liveReads()).toEqual([])
  })
})
