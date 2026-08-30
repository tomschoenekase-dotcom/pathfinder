import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RealtimeVoiceProviderAdapter } from '@pathfinder/ai'

const mocks = vi.hoisted(() => ({
  assertGlobalAiAvailable: vi.fn().mockResolvedValue(undefined),
  entitlement: vi.fn(),
  emitEvent: vi.fn().mockResolvedValue(undefined),
  publishOperationalEvent: vi.fn().mockResolvedValue(undefined),
  rateLimit: vi.fn().mockResolvedValue(true),
}))

vi.mock('@pathfinder/db', () => ({
  assertGlobalAiAvailable: mocks.assertGlobalAiAvailable,
  publishOperationalEvent: mocks.publishOperationalEvent,
  resolveProductEntitlement: mocks.entitlement,
}))
vi.mock('@pathfinder/analytics', () => ({ emitEvent: mocks.emitEvent }))
vi.mock('../lib/rate-limit', () => ({ checkRateLimit: mocks.rateLimit }))

import { router } from '../core'
import type { TRPCContext } from '../context'
import { _setVoiceProviderAdapterForTesting, voiceRouter } from './voice'

const VENUE_ID = 'venue-1'
const TOKEN = '123e4567-e89b-12d3-a456-426614174000'
const VOICE_ID = '11111111-1111-4111-8111-111111111111'
const scope = {
  sessionId: 'session-1',
  tenantId: 'tenant-1',
  venueId: VENUE_ID,
  experienceScope: 'PUBLIC',
  venueActive: true,
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

  it('authorizes a public, entitled, quota-admitted session with tenant-scoped retrieval', async () => {
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
    expect(dbMocks.knowledge).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          venueId: VENUE_ID,
          visibility: 'PUBLIC',
        }),
      }),
    )
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
      }),
    )
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
