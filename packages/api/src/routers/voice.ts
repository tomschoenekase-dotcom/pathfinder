import { createHash } from 'node:crypto'

import { TRPCError } from '@trpc/server'

import {
  openAiRealtimeVoiceAdapter,
  estimateRealtimeVoiceCostUsd,
  REALTIME_VOICE_PRICING_VERSION,
  resolveRealtimeVoiceRoute,
  type RealtimeVoiceProviderAdapter,
} from '@pathfinder/ai'
import { emitEvent } from '@pathfinder/analytics'
import { isFeatureEnabled } from '@pathfinder/config/feature-flags'
import { publishOperationalEvent, resolveProductEntitlement } from '@pathfinder/db'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { buildVenueSystemPromptParts } from '../lib/venue-context'
import { checkRateLimit } from '../lib/rate-limit'
import { resolveVoiceEntitlementSettings, voiceQuotaWindows } from '../lib/voice-session-policy'
import {
  VoiceSessionConnectedInput,
  VoiceSessionEndInput,
  VoiceSessionStartInput,
  VoiceTranscriptSegmentInput,
  VoiceUsageInput,
  VoiceAvailabilityInput,
} from '../schemas/voice'
import { publicAiProcedure, publicProcedure } from '../trpc'

let voiceProviderAdapter: RealtimeVoiceProviderAdapter = openAiRealtimeVoiceAdapter

export function _setVoiceProviderAdapterForTesting(
  adapter: RealtimeVoiceProviderAdapter | null,
): void {
  voiceProviderAdapter = adapter ?? openAiRealtimeVoiceAdapter
}

type PublicVoiceScope = {
  sessionId: string
  tenantId: string
  venueId: string
  experienceScope: string
  venueActive: boolean
  name: string
  description: string | null
  category: string | null
  guideNotes: string | null
  aiGuideNotes: string | null
  aiTone: string | null
  tonePreset: string | null
  tonePresetVersion: number | null
  aiGuideName: string | null
  guideMode: string | null
}

async function resolvePublicVoiceScope(
  ctx: TRPCContext,
  input: { venueId: string; anonymousToken: string },
): Promise<PublicVoiceScope> {
  // Deliberate public cross-tenant lookup: the anonymous token is a per-venue
  // bearer identity. The joined venue ID is required so a token cannot cross venues.
  const [scope] = await ctx.db.$queryRaw<PublicVoiceScope[]>`
    SELECT s.id AS "sessionId",
           s.tenant_id AS "tenantId",
           s.venue_id AS "venueId",
           s.experience_scope AS "experienceScope",
           v.is_active AS "venueActive",
           v.name,
           v.description,
           v.category,
           v.guide_notes AS "guideNotes",
           v.ai_guide_notes AS "aiGuideNotes",
           v.ai_tone AS "aiTone",
           v.tone_preset AS "tonePreset",
           v.tone_preset_version AS "tonePresetVersion",
           v.ai_guide_name AS "aiGuideName",
           v.guide_mode AS "guideMode"
      FROM visitor_sessions s
      JOIN venues v ON v.id = s.venue_id AND v.tenant_id = s.tenant_id
     WHERE s.anonymous_token = ${input.anonymousToken}
       AND s.venue_id = ${input.venueId}
     LIMIT 1
  `
  if (!scope || !scope.venueActive || scope.experienceScope !== 'PUBLIC') {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Voice is unavailable for this session.' })
  }
  return scope
}

async function resolveOwnedVoiceSession(
  ctx: TRPCContext,
  input: { venueId: string; anonymousToken: string; voiceSessionId: string },
) {
  const scope = await resolvePublicVoiceScope(ctx, input)
  const voiceSession = await ctx.db.voiceSession.findFirst({
    where: {
      id: input.voiceSessionId,
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      visitorSessionId: scope.sessionId,
    },
  })
  if (!voiceSession) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Voice session not found.' })
  }
  return { scope, voiceSession }
}

function quotaError(): TRPCError {
  return new TRPCError({
    code: 'TOO_MANY_REQUESTS',
    message: 'Voice time is currently unavailable. Continue in text or try again later.',
  })
}

export const voiceRouter = router({
  availability: publicProcedure.input(VoiceAvailabilityInput).query(async ({ ctx, input }) => {
    if (!isFeatureEnabled('voiceMode')) return { enabled: false as const }

    const scope = await resolvePublicVoiceScope(ctx, input)
    const voice = await resolveProductEntitlement({
      client: ctx.db,
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      capability: 'voice',
      featureAvailable: true,
    })
    if (!voice.enabled) return { enabled: false as const }

    const premium = await resolveProductEntitlement({
      client: ctx.db,
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      capability: 'premium-voice',
      featureAvailable: true,
    })
    const settings = resolveVoiceEntitlementSettings(voice.settings)
    return {
      enabled: true as const,
      premiumAvailable: premium.enabled,
      maxDurationSeconds: settings.maxSessionSeconds,
    }
  }),

  start: publicAiProcedure.input(VoiceSessionStartInput).mutation(async ({ ctx, input }) => {
    if (!isFeatureEnabled('voiceMode')) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Voice is not available.' })
    }
    if (!(await checkRateLimit('ratelimit:voice:start:global', 120, 60))) throw quotaError()
    const scope = await resolvePublicVoiceScope(ctx, input)
    const [sessionAllowed, venueAllowed] = await Promise.all([
      checkRateLimit(`ratelimit:voice:start:session:${scope.sessionId}`, 3, 300),
      checkRateLimit(`ratelimit:voice:start:venue:${scope.tenantId}:${scope.venueId}`, 30, 60),
    ])
    if (!sessionAllowed || !venueAllowed) throw quotaError()

    const voiceEntitlement = await resolveProductEntitlement({
      client: ctx.db,
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      capability: 'voice',
      featureAvailable: true,
    })
    if (!voiceEntitlement.enabled) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Voice is not enabled for this venue.' })
    }
    const premiumEntitlement =
      input.tier === 'PREMIUM'
        ? await resolveProductEntitlement({
            client: ctx.db,
            tenantId: scope.tenantId,
            venueId: scope.venueId,
            capability: 'premium-voice',
            featureAvailable: true,
          })
        : null
    const route = resolveRealtimeVoiceRoute({
      tier: input.tier,
      premiumEntitled: premiumEntitlement?.enabled ?? false,
    })
    const settings = resolveVoiceEntitlementSettings(voiceEntitlement.settings)
    const now = new Date()
    const { dayStart, monthStart } = voiceQuotaWindows(now)

    const [activeCount, dailyUsage, monthlyUsage] = await Promise.all([
      ctx.db.voiceSession.count({
        where: {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          status: { in: ['AUTHORIZING', 'READY', 'ACTIVE'] },
        },
      }),
      ctx.db.voiceSession.aggregate({
        where: {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          createdAt: { gte: dayStart },
        },
        _sum: { durationSeconds: true },
      }),
      ctx.db.voiceSession.aggregate({
        where: {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          createdAt: { gte: monthStart },
        },
        _sum: { durationSeconds: true },
      }),
    ])
    if (
      activeCount >= settings.maxConcurrentSessions ||
      (dailyUsage._sum.durationSeconds ?? 0) >= settings.dailySeconds ||
      (monthlyUsage._sum.durationSeconds ?? 0) >= settings.monthlySeconds
    ) {
      throw quotaError()
    }

    const [places, knowledgeEntries, activeUpdates, botConfiguration] = await Promise.all([
      ctx.db.place.findMany({
        where: {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          visibility: 'PUBLIC',
          isActive: true,
        },
        orderBy: [{ importanceScore: 'desc' }, { name: 'asc' }],
        take: 30,
        select: {
          id: true,
          name: true,
          type: true,
          itemType: true,
          shortDescription: true,
          longDescription: true,
          areaName: true,
          tags: true,
          hours: true,
        },
      }),
      ctx.db.venueKnowledgeEntry.findMany({
        where: {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          visibility: 'PUBLIC',
          isEnabled: true,
        },
        orderBy: [{ updatedAt: 'desc' }, { title: 'asc' }],
        take: 30,
        select: { title: true, category: true, content: true },
      }),
      ctx.db.operationalUpdate.findMany({
        where: {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          status: 'PUBLISHED',
          isActive: true,
          startsAt: { lte: now },
          expiresAt: { gt: now },
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        take: 10,
        select: {
          updateType: true,
          severity: true,
          priority: true,
          title: true,
          body: true,
          redirectTo: true,
          place: { select: { name: true } },
        },
      }),
      ctx.db.venueBotConfiguration.findUnique({
        where: { tenantId_venueId: { tenantId: scope.tenantId, venueId: scope.venueId } },
        select: {
          presentationMode: true,
          personalityMode: true,
          tonePreset: true,
          tonePresetVersion: true,
          publicDisplayName: true,
          greeting: true,
          voiceProfileId: true,
          revision: true,
        },
      }),
    ])
    const prompt = buildVenueSystemPromptParts({
      venue: scope,
      relevantPlaces: places,
      knowledgeEntries,
      activeUpdates,
      userLat: null,
      userLng: null,
      language: input.locale,
      guideMode: scope.guideMode,
    })
    const instructions =
      `${prompt.staticPart}\n\n${prompt.dynamicPart}\n\nVOICE INTERFACE:\nRespond conversationally and concisely. The visitor may interrupt; stop cleanly when interrupted. Never claim a location, route, or fact absent from the trusted context. Offer text or staff help when uncertain.`.slice(
        0,
        32_000,
      )
    const saved = await ctx.db.$transaction(async (tx) => {
      // Deliberate tenant/venue-scoped advisory lock: quota admission and session
      // reservation must serialize across horizontally scaled API replicas.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:voice-quota:${scope.tenantId}:${scope.venueId}`}, 0))`
      const [atomicActiveCount, atomicDailyUsage, atomicMonthlyUsage] = await Promise.all([
        tx.voiceSession.count({
          where: {
            tenantId: scope.tenantId,
            venueId: scope.venueId,
            status: { in: ['AUTHORIZING', 'READY', 'ACTIVE'] },
          },
        }),
        tx.voiceSession.aggregate({
          where: { tenantId: scope.tenantId, venueId: scope.venueId, createdAt: { gte: dayStart } },
          _sum: { durationSeconds: true },
        }),
        tx.voiceSession.aggregate({
          where: {
            tenantId: scope.tenantId,
            venueId: scope.venueId,
            createdAt: { gte: monthStart },
          },
          _sum: { durationSeconds: true },
        }),
      ])
      if (
        atomicActiveCount >= settings.maxConcurrentSessions ||
        (atomicDailyUsage._sum.durationSeconds ?? 0) >= settings.dailySeconds ||
        (atomicMonthlyUsage._sum.durationSeconds ?? 0) >= settings.monthlySeconds
      )
        throw quotaError()
      return tx.voiceSession.create({
        data: {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          visitorSessionId: scope.sessionId,
          provider: route.provider,
          model: route.model,
          capability: route.capability,
          tier: route.tier,
          locale: input.locale,
          voice: settings.voice,
          entitlementSnapshot: {
            voice: voiceEntitlement,
            ...(premiumEntitlement ? { premiumVoice: premiumEntitlement } : {}),
          },
          botConfigurationSnapshot: botConfiguration ?? {},
          maxDurationSeconds: settings.maxSessionSeconds,
        },
        select: { id: true },
      })
    })

    try {
      const apiKey = process.env.OPENAI_API_KEY
      if (!apiKey) throw new Error('Realtime voice provider is not configured')
      const language = input.locale.split('-')[0]
      const authorization = await voiceProviderAdapter.authorizeSession({
        route,
        apiKey,
        safetyIdentifier: createHash('sha256')
          .update(`${scope.tenantId}:${scope.venueId}:${scope.sessionId}`)
          .digest('hex'),
        instructions,
        voice: settings.voice,
        ...(language ? { language } : {}),
      })
      if (authorization.provider !== route.provider || authorization.model !== route.model) {
        throw new Error('Realtime voice provider returned an unexpected route identity')
      }
      await ctx.db.voiceSession.updateMany({
        where: {
          id: saved.id,
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          status: 'AUTHORIZING',
        },
        data: {
          status: 'READY',
          providerSessionId: authorization.providerSessionId,
          clientSecretExpiresAt: new Date(authorization.expiresAt * 1_000),
          lastActiveAt: new Date(),
        },
      })
      void emitEvent({
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        sessionId: scope.sessionId,
        eventType: 'voice.session.started',
        metadata: {
          voiceSessionId: saved.id,
          tier: route.tier,
          provider: route.provider,
          model: route.model,
          locale: input.locale,
        },
      })
      return {
        voiceSessionId: saved.id,
        clientSecret: authorization.clientSecret,
        expiresAt: authorization.expiresAt,
        provider: authorization.provider,
        model: authorization.model,
        maxDurationSeconds: settings.maxSessionSeconds,
      }
    } catch {
      await ctx.db.voiceSession.updateMany({
        where: { id: saved.id, tenantId: scope.tenantId, venueId: scope.venueId },
        data: { status: 'FAILED', errorCode: 'AUTHORIZATION_FAILED', endedAt: new Date() },
      })
      void emitEvent({
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        sessionId: scope.sessionId,
        eventType: 'voice.session.failed',
        metadata: { voiceSessionId: saved.id, failureStage: 'authorization' },
      })
      void publishOperationalEvent({
        client: ctx.db,
        event: {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          eventType: 'voice.session.failed',
          sourceSubsystem: 'realtime-voice',
          severity: 'ERROR',
          title: 'Voice session authorization failed',
          summary:
            'A visitor voice session could not obtain provider authorization and fell back safely.',
          linkedObjectType: 'voice-session',
          linkedObjectId: saved.id,
          recommendedAction:
            'Check the realtime provider configuration and recent provider health.',
          deduplicationKey: `voice-authorization-failure:${saved.id}`,
        },
      }).catch(() => undefined)
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Voice could not connect. Continue in text or try again.',
      })
    }
  }),

  connected: publicProcedure.input(VoiceSessionConnectedInput).mutation(async ({ ctx, input }) => {
    const { scope } = await resolveOwnedVoiceSession(ctx, input)
    const connectedAt = new Date()
    const updated = await ctx.db.voiceSession.updateMany({
      where: {
        id: input.voiceSessionId,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        status: { in: ['READY', 'ACTIVE'] },
      },
      data: { status: 'ACTIVE', connectedAt, lastActiveAt: connectedAt },
    })
    return { connected: updated.count === 1 }
  }),

  transcript: publicProcedure
    .input(VoiceTranscriptSegmentInput)
    .mutation(async ({ ctx, input }) => {
      const { scope, voiceSession } = await resolveOwnedVoiceSession(ctx, input)
      if (!['READY', 'ACTIVE'].includes(voiceSession.status)) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Voice session is not active.' })
      }
      const created = await ctx.db.voiceTranscriptSegment.createMany({
        data: [
          {
            tenantId: scope.tenantId,
            venueId: scope.venueId,
            voiceSessionId: input.voiceSessionId,
            providerEventId: input.providerEventId,
            sequence: input.sequence,
            speaker: input.speaker,
            text: input.text,
            ...(input.language ? { language: input.language } : {}),
          },
        ],
        skipDuplicates: true,
      })
      await ctx.db.voiceSession.updateMany({
        where: { id: input.voiceSessionId, tenantId: scope.tenantId, venueId: scope.venueId },
        data: { lastActiveAt: new Date() },
      })
      return { accepted: created.count === 1 }
    }),

  usage: publicProcedure.input(VoiceUsageInput).mutation(async ({ ctx, input }) => {
    const { scope, voiceSession } = await resolveOwnedVoiceSession(ctx, input)
    if (!['READY', 'ACTIVE'].includes(voiceSession.status)) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Voice session is not active.' })
    }
    const estimatedCostUsd = estimateRealtimeVoiceCostUsd(voiceSession.model, {
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cachedInputTokens: input.cachedInputTokens,
      cachedAudioInputTokens: input.cachedAudioInputTokens,
      audioInputTokens: input.audioInputTokens,
      audioOutputTokens: input.audioOutputTokens,
    })
    if (estimatedCostUsd === null) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Voice pricing is not configured for this route.',
      })
    }
    try {
      await ctx.db.aiUsageEvent.create({
        data: {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          sessionId: scope.sessionId,
          feature: 'realtime-voice',
          capability: voiceSession.capability,
          requestType: 'realtime-response',
          providerRequestId: input.providerEventId,
          surface: 'guest-web',
          provider: voiceSession.provider,
          model: voiceSession.model,
          pricingVersion: REALTIME_VOICE_PRICING_VERSION,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          audioInputTokens: input.audioInputTokens,
          audioOutputTokens: input.audioOutputTokens,
          cacheReadInputTokens: input.cachedInputTokens,
          cachedAudioInputTokens: input.cachedAudioInputTokens,
          totalTokens: input.inputTokens + input.outputTokens,
          estimatedCostUsd,
          latencyMs: 0,
          attempts: 1,
          success: true,
        },
      })
      return { accepted: true, estimatedCostUsd }
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      ) {
        return { accepted: false, estimatedCostUsd }
      }
      throw error
    }
  }),

  end: publicProcedure.input(VoiceSessionEndInput).mutation(async ({ ctx, input }) => {
    const { scope, voiceSession } = await resolveOwnedVoiceSession(ctx, input)
    const endedAt = new Date()
    const startedAt = voiceSession.connectedAt ?? voiceSession.createdAt
    const durationSeconds = Math.min(
      voiceSession.maxDurationSeconds,
      Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1_000)),
    )
    const transcriptCount = await ctx.db.voiceTranscriptSegment.count({
      where: {
        voiceSessionId: input.voiceSessionId,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
      },
    })
    await ctx.db.voiceSession.updateMany({
      where: {
        id: input.voiceSessionId,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        status: { in: ['AUTHORIZING', 'READY', 'ACTIVE'] },
      },
      data: {
        status: input.errorCode ? 'FAILED' : 'ENDED',
        endedAt,
        lastActiveAt: endedAt,
        durationSeconds,
        fallbackToText: input.fallbackToText,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      },
    })
    void emitEvent({
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      sessionId: scope.sessionId,
      eventType: input.errorCode ? 'voice.session.failed' : 'voice.session.ended',
      metadata: {
        voiceSessionId: input.voiceSessionId,
        durationSeconds,
        locale: voiceSession.locale,
        provider: voiceSession.provider,
        model: voiceSession.model,
        transcriptAvailable: transcriptCount > 0,
      },
    })
    if (input.fallbackToText) {
      void emitEvent({
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        sessionId: scope.sessionId,
        eventType: 'voice.fallback_to_text',
        metadata: { voiceSessionId: input.voiceSessionId },
      })
    }
    return { ended: true, durationSeconds }
  }),
})
