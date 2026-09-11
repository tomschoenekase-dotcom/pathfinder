import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RealtimeVoiceProviderAdapter } from '@pathfinder/ai'

const mocks = vi.hoisted(() => ({
  assertGlobalAiAvailable: vi.fn().mockResolvedValue(undefined),
  entitlement: vi.fn(),
  emitEvent: vi.fn().mockResolvedValue(undefined),
  publishOperationalEvent: vi.fn().mockResolvedValue(undefined),
  rateLimit: vi.fn().mockResolvedValue(true),
  nativeSnapshot: vi
    .fn()
    .mockResolvedValue({ path: 'LEGACY', reason: 'SERVER_DISABLED', releaseId: null, state: null }),
}))

vi.mock('@pathfinder/db', () => ({
  assertGlobalAiAvailable: mocks.assertGlobalAiAvailable,
  publishOperationalEvent: mocks.publishOperationalEvent,
  resolveProductEntitlement: mocks.entitlement,
  resolveNativeGuestReadSnapshotAction: mocks.nativeSnapshot,
  applyNativeGuestContentRead: vi.fn((input) => ({
    path: input.snapshot.path,
    places: input.legacyPlaces,
    knowledgeEntries: input.legacyKnowledgeEntries,
  })),
}))
vi.mock('@pathfinder/analytics', () => ({ emitEvent: mocks.emitEvent }))
vi.mock('../lib/rate-limit', () => ({ checkRateLimit: mocks.rateLimit }))

import { router } from '../core'
import type { TRPCContext } from '../context'
import { _setVoiceProviderAdapterForTesting, composeVoiceInstructions, voiceRouter } from './voice'

const VENUE_ID = 'venue-1'
const TOKEN = '123e4567-e89b-12d3-a456-426614174000'
const VOICE_ID = '11111111-1111-4111-8111-111111111111'
const scope = {
  sessionId: 'session-1',
  tenantId: 'tenant-1',
  venueId: VENUE_ID,
  experienceScope: 'PUBLIC',
  venueActive: true,
  venueSlug: 'museum',
  showPhotos: true,
  showLinks: true,
  name: 'Museum',
  description: 'A city museum.',
  category: 'museum',
  guideNotes: null,
  aiGuideNotes: null,
  aiTone: 'FRIENDLY',
  tonePreset: 'friendly',
  tonePresetVersion: 1,
  aiGuideName: 'PathFinder',
  guideMode: 'non_location',
}

const dbMocks = {
  queryRaw: vi.fn(),
  voiceCount: vi.fn(),
  voiceAggregate: vi.fn(),
  voiceCreate: vi.fn(),
  voiceUpdateMany: vi.fn(),
  voiceFindFirst: vi.fn(),
  transcriptCreateMany: vi.fn(),
  transcriptCount: vi.fn(),
  usageCreate: vi.fn(),
  executeRaw: vi.fn(),
  places: vi.fn(),
  knowledge: vi.fn(),
  updates: vi.fn(),
  media: vi.fn(),
  bot: vi.fn(),
}

const db = {
  $queryRaw: dbMocks.queryRaw,
  $executeRaw: dbMocks.executeRaw,
  voiceSession: {
    count: dbMocks.voiceCount,
    aggregate: dbMocks.voiceAggregate,
    create: dbMocks.voiceCreate,
    updateMany: dbMocks.voiceUpdateMany,
    findFirst: dbMocks.voiceFindFirst,
  },
  voiceTranscriptSegment: {
    createMany: dbMocks.transcriptCreateMany,
    count: dbMocks.transcriptCount,
  },
  aiUsageEvent: { create: dbMocks.usageCreate },
  place: { findMany: dbMocks.places },
  venueKnowledgeEntry: { findMany: dbMocks.knowledge },
  operationalUpdate: { findMany: dbMocks.updates },
  venueMediaDerivative: { findMany: dbMocks.media },
  venueBotConfiguration: { findUnique: dbMocks.bot },
} as unknown as TRPCContext['db']
;(
  db as unknown as { $transaction: (operation: (transaction: typeof db) => unknown) => unknown }
).$transaction = (operation) => operation(db)

const caller = router({ voice: voiceRouter }).createCaller({
  db,
  headers: new Headers(),
  session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
})

const provider = {
  provider: 'openai',
  authorizeSession: vi.fn(),
} as unknown as RealtimeVoiceProviderAdapter

describe('voice router', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('VOICE_MODE_ENABLED', 'true')
    vi.stubEnv('OPENAI_API_KEY', 'sk-server-only')
    _setVoiceProviderAdapterForTesting(provider)
    dbMocks.queryRaw.mockResolvedValue([scope])
    mocks.entitlement.mockResolvedValue({
      capability: 'voice',
      enabled: true,
      source: 'VENUE_OVERRIDE',
      sourceId: 'grant-1',
      planTier: 'launch',
      settings: {},
      validUntil: null,
    })
    dbMocks.transcriptCount.mockResolvedValue(0)
    dbMocks.voiceCount.mockResolvedValue(0)
    dbMocks.voiceAggregate.mockResolvedValue({ _sum: { durationSeconds: 0 } })
    dbMocks.places.mockResolvedValue([])
    dbMocks.knowledge.mockResolvedValue([])
    dbMocks.updates.mockResolvedValue([])
    dbMocks.media.mockResolvedValue([])
    dbMocks.bot.mockResolvedValue(null)
    dbMocks.voiceCreate.mockResolvedValue({ id: VOICE_ID })
    dbMocks.voiceUpdateMany.mockResolvedValue({ count: 1 })
    dbMocks.usageCreate.mockResolvedValue({ id: 'usage-1' })
    dbMocks.executeRaw.mockResolvedValue(1)
    provider.authorizeSession = vi.fn().mockResolvedValue({
      provider: 'openai',
      model: 'gpt-realtime-2.1-mini',
      clientSecret: 'ek-browser-ephemeral',
      expiresAt: 1_787_000_000,
      providerSessionId: 'provider-session',
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    _setVoiceProviderAdapterForTesting(null)
  })

  it('reports only safe public availability after session and entitlement checks', async () => {
    const result = await caller.voice.availability({ venueId: VENUE_ID, anonymousToken: TOKEN })

    expect(result).toEqual({ enabled: true, premiumAvailable: true, maxDurationSeconds: 600 })
    expect(dbMocks.queryRaw).toHaveBeenCalledOnce()
    expect(mocks.entitlement).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ tenantId: 'tenant-1', venueId: VENUE_ID, capability: 'voice' }),
    )
    expect(mocks.entitlement).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ capability: 'premium-voice' }),
    )
  })

  it('authorizes a public, entitled, quota-admitted session without freezing a recency snapshot', async () => {
    const result = await caller.voice.start({
      venueId: VENUE_ID,
      anonymousToken: TOKEN,
      locale: 'en-US',
      tier: 'ECONOMY',
    })

    expect(result).toMatchObject({
      voiceSessionId: VOICE_ID,
      clientSecret: 'ek-browser-ephemeral',
      provider: 'openai',
      maxDurationSeconds: 600,
    })
    expect(result).not.toEqual(expect.objectContaining({ apiKey: expect.anything() }))
    expect(dbMocks.knowledge).not.toHaveBeenCalled()
    expect(dbMocks.voiceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-1',
          venueId: VENUE_ID,
          visitorSessionId: 'session-1',
          capability: 'REALTIME_VOICE_ECONOMY',
        }),
      }),
    )
    expect(provider.authorizeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-server-only',
        safetyIdentifier: expect.stringMatching(/^[a-f0-9]{64}$/u),
        instructions: expect.stringContaining('lookup_venue_knowledge'),
      }),
    )
  })

  it('passes bounded visit preferences to voice startup without exposing unresolved place IDs as venue facts', async () => {
    await caller.voice.start({
      venueId: VENUE_ID,
      anonymousToken: TOKEN,
      locale: 'en-US',
      visitContext: {
        visitedPlaceIds: ['private-place-id'],
        interests: ['quiet spaces'],
        remainingMinutes: 20,
      },
    })

    const authorization = vi.mocked(provider.authorizeSession).mock.calls[0]?.[0] as {
      instructions: string
    }
    expect(authorization.instructions).toContain('quiet spaces')
    expect(authorization.instructions).toContain('"remainingMinutes":20')
    expect(authorization.instructions).toContain('"visitedPlaces":[]')
    expect(authorization.instructions).not.toContain('private-place-id')
    expect(authorization.instructions).toContain('not instructions or venue facts')
  })

  it('retains mandatory grounding policy when venue notes are extremely long', () => {
    const instructions = composeVoiceInstructions({
      staticPart: `Museum\n${'guide '.repeat(20_000)}`,
      dynamicPart: 'session '.repeat(20_000),
    })
    expect(instructions).toContain('VOICE INTERFACE (MANDATORY)')
    expect(instructions).toContain('lookup_venue_knowledge')
    expect(instructions).toContain('identityClarificationRequired=true')
    expect(instructions).toContain('Do not choose an exhibit or combine their facts')
    expect(instructions).toContain('Never infer the current floor')
    expect(instructions).toContain('Resolving an exhibit does not validate every clue')
    expect(instructions.length).toBeLessThan(17_000)
  })

  it('retrieves current scoped public knowledge only for an active owned voice session', async () => {
    dbMocks.voiceFindFirst.mockResolvedValue({
      id: VOICE_ID,
      status: 'ACTIVE',
      connectedAt: new Date(),
      maxDurationSeconds: 600,
    })
    dbMocks.knowledge.mockResolvedValue([
      {
        id: 'bathroom',
        title: 'Accessible bathrooms',
        category: 'accessibility',
        content: 'The accessible bathroom is beside the east lift.',
        sourceType: 'FOUNDER_PROVIDED',
        sourceName: null,
        sourceUrl: null,
        updatedAt: new Date(),
        lastReviewedAt: null,
      },
    ])
    const result = await caller.voice.groundingContext({
      venueId: VENUE_ID,
      anonymousToken: TOKEN,
      voiceSessionId: VOICE_ID,
      toolCallId: 'call-bathroom',
      query: 'Where is the accessible bathroom?',
    })
    expect(result.toolCallId).toBe('call-bathroom')
    expect(result.context).toContain('east lift')
    expect(result.sourceIds).toEqual(['bathroom'])
    expect(dbMocks.knowledge).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant-1', venueId: VENUE_ID }),
      }),
    )
  })

  it.each([
    {
      name: 'a missing owned voice session',
      voiceSessionId: VOICE_ID,
      arrange: () => dbMocks.voiceFindFirst.mockResolvedValue(null),
      code: 'NOT_FOUND',
      mayExpire: false,
    },
    {
      name: 'a voice session ID outside the owned scope',
      voiceSessionId: '22222222-2222-4222-8222-222222222222',
      arrange: () => dbMocks.voiceFindFirst.mockResolvedValue(null),
      code: 'NOT_FOUND',
      mayExpire: false,
    },
    {
      name: 'a non-public visitor scope',
      voiceSessionId: VOICE_ID,
      arrange: () =>
        dbMocks.queryRaw.mockResolvedValue([{ ...scope, experienceScope: 'SECOND_LAYER' }]),
      code: 'NOT_FOUND',
      mayExpire: false,
    },
    {
      name: 'an expired READY authorization',
      voiceSessionId: VOICE_ID,
      arrange: () =>
        dbMocks.voiceFindFirst.mockResolvedValue({
          id: VOICE_ID,
          status: 'READY',
          connectedAt: null,
          clientSecretExpiresAt: new Date(Date.now() - 1_000),
          maxDurationSeconds: 600,
        }),
      code: 'CONFLICT',
      mayExpire: true,
    },
    {
      name: 'an ACTIVE session beyond its maximum duration',
      voiceSessionId: VOICE_ID,
      arrange: () =>
        dbMocks.voiceFindFirst.mockResolvedValue({
          id: VOICE_ID,
          status: 'ACTIVE',
          connectedAt: new Date(Date.now() - 601_000),
          clientSecretExpiresAt: null,
          maxDurationSeconds: 600,
        }),
      code: 'CONFLICT',
      mayExpire: true,
    },
    {
      name: 'a revoked voice entitlement',
      voiceSessionId: VOICE_ID,
      arrange: () => {
        dbMocks.voiceFindFirst.mockResolvedValue({
          id: VOICE_ID,
          status: 'ACTIVE',
          connectedAt: new Date(),
          clientSecretExpiresAt: null,
          maxDurationSeconds: 600,
        })
        mocks.entitlement.mockResolvedValue({
          capability: 'voice',
          enabled: false,
          source: 'VENUE_OVERRIDE',
          sourceId: 'grant-1',
          planTier: 'launch',
          settings: {},
          validUntil: null,
        })
      },
      code: 'FORBIDDEN',
      mayExpire: false,
    },
  ])('denies grounding for $name before any grounding source is read', async (testCase) => {
    testCase.arrange()

    await expect(
      caller.voice.groundingContext({
        venueId: VENUE_ID,
        anonymousToken: TOKEN,
        voiceSessionId: testCase.voiceSessionId,
        toolCallId: 'denied-call',
        query: 'Where is the gallery?',
      }),
    ).rejects.toMatchObject({ code: testCase.code })

    if (testCase.name === 'a non-public visitor scope') {
      expect(dbMocks.voiceFindFirst).not.toHaveBeenCalled()
    } else {
      expect(dbMocks.voiceFindFirst).toHaveBeenCalledWith({
        where: {
          id: testCase.voiceSessionId,
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          visitorSessionId: scope.sessionId,
        },
      })
    }
    expect(mocks.nativeSnapshot).not.toHaveBeenCalled()
    expect(dbMocks.places).not.toHaveBeenCalled()
    expect(dbMocks.knowledge).not.toHaveBeenCalled()
    expect(dbMocks.updates).not.toHaveBeenCalled()
    expect(dbMocks.media).not.toHaveBeenCalled()
    expect(dbMocks.bot).not.toHaveBeenCalled()
    expect(dbMocks.voiceUpdateMany).toHaveBeenCalledTimes(testCase.mayExpire ? 1 : 0)
  })

  it('uses server display policy for reviewed voice captions without exposing media links', async () => {
    dbMocks.voiceFindFirst.mockResolvedValue({
      id: VOICE_ID,
      status: 'ACTIVE',
      connectedAt: new Date(),
      maxDurationSeconds: 600,
    })
    dbMocks.places.mockResolvedValue([{ id: 'garden', name: 'Garden', type: 'PLACE' }])
    dbMocks.media.mockResolvedValue([
      {
        id: 'approved-image',
        approvedReviewSequence: 2,
        createdAt: new Date(),
        asset: {
          altText: 'Reviewed garden entrance',
          caption: 'A stone arch beside the gate.',
          sourceName: 'Venue staff',
          sourceUrl: 'https://example.com/source',
          placeLinks: [{ placeId: 'garden' }],
          reviews: [{ sequence: 2, action: 'APPROVE_CONTENT_USE', rightsBasis: 'VENUE_OWNED' }],
        },
      },
    ])
    const input = {
      venueId: VENUE_ID,
      anonymousToken: TOKEN,
      voiceSessionId: VOICE_ID,
      toolCallId: 'call-image',
      query: 'Tell me about the garden.',
    }
    const result = await caller.voice.groundingContext(input)
    expect(result.context).toContain('Reviewed garden entrance')
    expect(result.context).not.toContain('/api/venue-media/')
    expect(result.context).not.toContain('https://example.com/source')
    expect(result.sourceIds).toContain('media:approved-image:review:2')
    const sql = dbMocks.queryRaw.mock.calls[0]![0].join(' ')
    expect(sql).toContain('v.chat_show_photos')
    expect(sql).toContain('v.chat_show_links')
    expect(sql).toContain('v.slug')
    dbMocks.queryRaw.mockResolvedValue([{ ...scope, showPhotos: false }])
    dbMocks.media.mockClear()
    const disabled = await caller.voice.groundingContext(input)
    expect(disabled.context).not.toContain('Reviewed garden entrance')
    expect(dbMocks.media).not.toHaveBeenCalled()
  })

  it('returns visitor preferences separately from grounded voice sources', async () => {
    dbMocks.voiceFindFirst.mockResolvedValue({
      id: VOICE_ID,
      status: 'ACTIVE',
      connectedAt: new Date(),
      maxDurationSeconds: 600,
    })
    const result = await caller.voice.groundingContext({
      venueId: VENUE_ID,
      anonymousToken: TOKEN,
      voiceSessionId: VOICE_ID,
      toolCallId: 'call-recommendation',
      query: 'What should I see next?',
      visitContext: {
        visitedPlaceIds: ['private-place-id'],
        interests: ['quiet spaces'],
        remainingMinutes: 20,
      },
    })

    expect(result.visitContext).toEqual({
      interests: ['quiet spaces'],
      remainingMinutes: 20,
      visitedPlaces: [],
    })
    expect(result.context).not.toContain('private-place-id')
    expect(result.sourceIds).not.toContain('private-place-id')
    expect(result.sourceIds).not.toContain('quiet spaces')
  })

  it('rejects employee sessions at the public voice boundary before entitlement or provider work', async () => {
    dbMocks.queryRaw.mockResolvedValue([{ ...scope, experienceScope: 'EMPLOYEE' }])
    await expect(
      caller.voice.start({ venueId: VENUE_ID, anonymousToken: TOKEN, locale: 'en' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mocks.entitlement).not.toHaveBeenCalled()
    expect(provider.authorizeSession).not.toHaveBeenCalled()
  })

  it('records idempotent server-priced multimodal usage for the owned voice route', async () => {
    dbMocks.voiceFindFirst.mockResolvedValue({
      id: VOICE_ID,
      status: 'ACTIVE',
      provider: 'openai',
      model: 'gpt-realtime-2.1-mini',
      capability: 'REALTIME_VOICE_ECONOMY',
    })
    const result = await caller.voice.usage({
      venueId: VENUE_ID,
      anonymousToken: TOKEN,
      voiceSessionId: VOICE_ID,
      providerEventId: 'response-1',
      inputTokens: 1_100,
      outputTokens: 2_100,
      cachedInputTokens: 100,
      cachedAudioInputTokens: 0,
      audioInputTokens: 1_000,
      audioOutputTokens: 2_000,
    })
    expect(result).toMatchObject({ accepted: true, estimatedCostUsd: 0.050246 })
    expect(dbMocks.usageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-1',
        venueId: VENUE_ID,
        providerRequestId: 'response-1',
        audioInputTokens: 1_000,
        audioOutputTokens: 2_000,
        pricingVersion: 'openai-model-pages-2026-08-19',
      }),
    })
  })

  it('terminally fences an expired ephemeral authorization before accepting transcript text', async () => {
    dbMocks.voiceFindFirst.mockResolvedValue({
      id: VOICE_ID,
      status: 'READY',
      clientSecretExpiresAt: new Date('2000-01-01T00:00:00Z'),
      connectedAt: new Date(),
      maxDurationSeconds: 600,
    })

    await expect(
      caller.voice.transcript({
        venueId: VENUE_ID,
        anonymousToken: TOKEN,
        voiceSessionId: VOICE_ID,
        providerEventId: 'transcript-after-expiry',
        sequence: 1,
        speaker: 'ASSISTANT',
        text: 'This must not be retained.',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    expect(dbMocks.transcriptCreateMany).not.toHaveBeenCalled()
    expect(dbMocks.voiceUpdateMany).toHaveBeenCalledWith({
      where: {
        id: VOICE_ID,
        tenantId: 'tenant-1',
        venueId: VENUE_ID,
        visitorSessionId: 'session-1',
        status: { in: ['READY', 'ACTIVE'] },
      },
      data: expect.objectContaining({
        status: 'FAILED',
        errorCode: 'AUTHORIZATION_EXPIRED',
        fallbackToText: true,
      }),
    })
  })

  it('does not mistake the connection credential expiry for an active call expiry', async () => {
    dbMocks.voiceFindFirst.mockResolvedValue({
      id: VOICE_ID,
      status: 'ACTIVE',
      clientSecretExpiresAt: new Date('2000-01-01T00:00:00Z'),
      connectedAt: new Date(),
      maxDurationSeconds: 600,
    })
    dbMocks.transcriptCreateMany.mockResolvedValue({ count: 1 })

    await expect(
      caller.voice.transcript({
        venueId: VENUE_ID,
        anonymousToken: TOKEN,
        voiceSessionId: VOICE_ID,
        providerEventId: 'active-after-handshake-window',
        sequence: 2,
        speaker: 'VISITOR',
        text: 'The active call remains valid.',
      }),
    ).resolves.toEqual({ accepted: true })
    expect(dbMocks.transcriptCreateMany).toHaveBeenCalledOnce()
  })

  it('rejects usage after the maximum connected duration and does not record cost', async () => {
    dbMocks.voiceFindFirst.mockResolvedValue({
      id: VOICE_ID,
      status: 'ACTIVE',
      provider: 'openai',
      model: 'gpt-realtime-2.1-mini',
      capability: 'REALTIME_VOICE_ECONOMY',
      clientSecretExpiresAt: new Date('2999-01-01T00:00:00Z'),
      connectedAt: new Date(Date.now() - 601_000),
      maxDurationSeconds: 600,
    })

    await expect(
      caller.voice.usage({
        venueId: VENUE_ID,
        anonymousToken: TOKEN,
        voiceSessionId: VOICE_ID,
        providerEventId: 'usage-after-duration',
        inputTokens: 10,
        outputTokens: 10,
        cachedInputTokens: 0,
        cachedAudioInputTokens: 0,
        audioInputTokens: 10,
        audioOutputTokens: 10,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    expect(dbMocks.usageCreate).not.toHaveBeenCalled()
    expect(dbMocks.voiceUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ errorCode: 'SESSION_DURATION_EXCEEDED' }),
      }),
    )
  })

  it('makes repeated close idempotent and emits the terminal event only for the winning close', async () => {
    dbMocks.voiceFindFirst.mockResolvedValue({
      id: VOICE_ID,
      status: 'ENDED',
      provider: 'openai',
      model: 'gpt-realtime-2.1-mini',
      locale: 'en',
      connectedAt: new Date(),
      createdAt: new Date(),
      maxDurationSeconds: 600,
    })
    dbMocks.voiceUpdateMany.mockResolvedValue({ count: 0 })

    await expect(
      caller.voice.end({
        venueId: VENUE_ID,
        anonymousToken: TOKEN,
        voiceSessionId: VOICE_ID,
        fallbackToText: false,
      }),
    ).resolves.toMatchObject({ ended: false })
    expect(mocks.emitEvent).not.toHaveBeenCalled()
  })

  it('fails closed and publishes an actionable incident when authorization changes route identity', async () => {
    provider.authorizeSession = vi.fn().mockResolvedValue({
      provider: 'openai',
      model: 'unexpected-provider-route',
      clientSecret: 'discarded-ephemeral-secret',
      expiresAt: 1_787_000_000,
      providerSessionId: 'unexpected-provider-session',
    })

    await expect(
      caller.voice.start({
        venueId: VENUE_ID,
        anonymousToken: TOKEN,
        locale: 'en-US',
        tier: 'ECONOMY',
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(dbMocks.voiceUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: VOICE_ID,
        tenantId: 'tenant-1',
        venueId: VENUE_ID,
        status: 'AUTHORIZING',
      },
      data: expect.objectContaining({
        status: 'FAILED',
        errorCode: 'AUTHORIZATION_FAILED',
        endedAt: expect.any(Date),
      }),
    })
    await vi.waitFor(() =>
      expect(mocks.publishOperationalEvent).toHaveBeenCalledWith({
        client: db,
        event: expect.objectContaining({
          tenantId: 'tenant-1',
          venueId: VENUE_ID,
          eventType: 'voice.session.failed',
          sourceSubsystem: 'realtime-voice',
          severity: 'ERROR',
          linkedObjectType: 'voice-session',
          linkedObjectId: VOICE_ID,
          deduplicationKey: `voice-authorization-failure:${VOICE_ID}`,
        }),
      }),
    )
  })

  it('does not resurrect or overwrite a session whose authorization lease was recovered', async () => {
    dbMocks.voiceUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 0 })

    await expect(
      caller.voice.start({
        venueId: VENUE_ID,
        anonymousToken: TOKEN,
        locale: 'en-US',
        tier: 'ECONOMY',
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })

    expect(dbMocks.voiceUpdateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: expect.objectContaining({ status: 'AUTHORIZING' }) }),
    )
    expect(dbMocks.voiceUpdateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: expect.objectContaining({ status: 'AUTHORIZING' }) }),
    )
    expect(mocks.emitEvent).not.toHaveBeenCalled()
    expect(mocks.publishOperationalEvent).not.toHaveBeenCalled()
  })

  it('keeps the endpoint dark when the server kill switch is off', async () => {
    vi.stubEnv('VOICE_MODE_ENABLED', 'false')
    await expect(
      caller.voice.start({ venueId: VENUE_ID, anonymousToken: TOKEN, locale: 'en' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(dbMocks.queryRaw).not.toHaveBeenCalled()
  })

  it('keeps availability dark without performing a session lookup when voice is disabled', async () => {
    vi.stubEnv('VOICE_MODE_ENABLED', 'false')
    await expect(
      caller.voice.availability({ venueId: VENUE_ID, anonymousToken: TOKEN }),
    ).resolves.toEqual({ enabled: false })
    expect(dbMocks.queryRaw).not.toHaveBeenCalled()
  })
})
