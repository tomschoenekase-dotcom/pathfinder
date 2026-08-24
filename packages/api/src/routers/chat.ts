import { randomUUID } from 'node:crypto'

import { TRPCError } from '@trpc/server'

import {
  AiGatewayError,
  AiRoutingError,
  generateTextForCapability,
  routeAiCapability,
  setAnthropicClientForTesting,
  type AnthropicMessagesClient,
} from '@pathfinder/ai'
import { emitEvent } from '@pathfinder/analytics'
import { CustomPersonalityBoundsSchema } from '@pathfinder/contracts'
import {
  assertVenueAiAvailable,
  applyNativeGuestContentRead,
  claimGuestChatTurnAction,
  failGuestChatTurnAction,
  finalizeGuestChatTurnAction,
  GuestChatReplayMetadata,
  GuestChatTurnActionError,
  isAiAdmissionControlError,
  searchKnowledgeByEmbedding,
  searchPlacesByEmbedding,
  resolveEffectivePublishedUniversalContent,
  markGuestChatProviderDispatchedAction,
  observeGuestChatProviderOperationAction,
  skipGuestChatProviderOperationAction,
  reserveGuestChatTurnAction,
  recordConversationInsightSignals,
  publishOperationalEvent,
  readActiveUnhealthyAiProviders,
  resolveRuntimeAiWorkloadConfiguration,
  resolveNativeGuestReadSnapshotAction,
} from '@pathfinder/db'

import { logger } from '@pathfinder/config'
import { isFeatureEnabled, TOCHI_TENANT_FLAG_KEYS } from '@pathfinder/config/feature-flags'
import { GLOBAL_AI_UNAVAILABLE_MESSAGE } from '@pathfinder/config/incident-control'

import { publicTRPCError, router } from '../core'
import type { TRPCContext } from '../context'
import { createApiAiUsageRecorder } from '../lib/api-ai-usage'
import { resolveSystemCharacterProjection } from '../lib/character-registry'
import { rollEngagementGate, selectAuthoredQuestion } from '../lib/engagement-questions'
import { findNearestPlaces } from '../lib/geo'
import { generateGuestQueryEmbedding } from '../lib/guest-query-embedding'
import { buildGuestPlaceCards } from '../lib/guest-place-card'
import { checkRateLimit } from '../lib/rate-limit'
import { buildVenueSystemPromptParts } from '../lib/venue-context'
import { buildGuestCitations } from '../lib/guest-citations'
import { requireGlobalAi } from '../middleware/require-global-ai'
import { ChatHistoryInput, ChatSendInput, ChatSessionInput } from '../schemas/chat'
import { MAX_GUEST_OPERATIONAL_UPDATES } from '../schemas/operational-update'
import { publicProcedure } from '../trpc'

function aiUnavailable(): TRPCError {
  return publicTRPCError({
    code: 'SERVICE_UNAVAILABLE',
    message: GLOBAL_AI_UNAVAILABLE_MESSAGE,
    publicCode: 'PROVIDER_UNAVAILABLE',
  })
}

function venueUnavailable(): TRPCError {
  return publicTRPCError({
    code: 'SERVICE_UNAVAILABLE',
    message: 'This venue guide is temporarily unavailable.',
    publicCode: 'CONTENT_UNAVAILABLE',
  })
}

function guestChatTurnError(error: unknown): never {
  if (!(error instanceof GuestChatTurnActionError)) throw error
  const code =
    error.code === 'INVALID_INPUT'
      ? 'BAD_REQUEST'
      : error.code === 'IN_PROGRESS'
        ? 'TOO_MANY_REQUESTS'
        : error.code === 'UNKNOWN_PROVIDER_OUTCOME'
          ? 'SERVICE_UNAVAILABLE'
          : error.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : error.code === 'FAILED'
              ? 'PRECONDITION_FAILED'
              : 'CONFLICT'
  const publicCode =
    error.code === 'UNKNOWN_PROVIDER_OUTCOME'
      ? 'OUTCOME_AMBIGUOUS'
      : error.code === 'INVALID_INPUT'
        ? 'REJECTED'
        : error.code === 'IN_PROGRESS'
          ? 'RATE_LIMITED'
          : error.code === 'NOT_FOUND'
            ? 'CONTENT_UNAVAILABLE'
            : error.code === 'FAILED'
              ? 'TRANSIENT_FAILURE'
              : 'REJECTED'
  throw publicTRPCError({ code, message: error.message, publicCode })
}

// ---------------------------------------------------------------------------
// Provider test seam (the production singleton is owned by @pathfinder/ai)
// ---------------------------------------------------------------------------

// Exported for test injection while provider ownership lives in @pathfinder/ai.
export function _setAnthropicClientForTesting(client: AnthropicMessagesClient | null): void {
  setAnthropicClientForTesting(client)
}

const NEAREST_PLACES_LIMIT = 8
const KNOWLEDGE_ENTRIES_LIMIT = 5
const HISTORY_LIMIT = 10
const HISTORY_LOAD_LIMIT = 40
const ENGAGEMENT_ASKED_MARKER = '[[ENGAGEMENT_ASKED]]'
// Backstop for the word-count rules in venue-context.ts. Prompt instructions
// are honored loosely by the model, not exactly — this guarantees the cap
// guests actually see, regardless of how closely the model followed the prompt.
const MAX_RESPONSE_WORDS = 60
const SESSION_SYNC_GLOBAL_LIMIT = 3000
const SESSION_SYNC_SESSION_LIMIT = 120
const SESSION_SYNC_VENUE_LIMIT = 3000
const HISTORY_GLOBAL_LIMIT = 3000
const HISTORY_SESSION_LIMIT = 60
const HISTORY_VENUE_LIMIT = 3000
const CHAT_GLOBAL_INGRESS_LIMIT = 600
const CHAT_INGRESS_VENUE_LIMIT = 120

type PublicChatVenue = {
  id: string
  tenantId: string
  name: string
  description: string | null
  guideNotes: string | null
  aiGuideNotes: string | null
  aiFeaturedPlaceId: string | null
  aiTone: string | null
  tonePreset: string | null
  tonePresetVersion: number | null
  aiGuideName: string | null
  category: string | null
  guideMode: string | null
  defaultCenterLat: number | null
  defaultCenterLng: number | null
  isActive: boolean
  secondLayerEnabled: boolean
  secondLayerLabel: string
  secondLayerAccessKey: string | null
  customWarmth?: number | null
  customBrevity?: number | null
  customEnergy?: number | null
  customFormality?: number | null
  customInstruction?: string | null
  venueBotPresentationMode?: 'CLASSIC' | 'CHARACTER' | null
  venueBotCharacterKey?: string | null
}

type ChatExperienceScope = 'PUBLIC' | 'SECOND_LAYER'

function authorizeChatExperience(
  venue: Pick<PublicChatVenue, 'tenantId' | 'secondLayerEnabled' | 'secondLayerAccessKey'>,
  session: TRPCContext['session'],
  secondLayerKey?: string,
): ChatExperienceScope {
  if (secondLayerKey === undefined) return 'PUBLIC'
  if (
    !venue.secondLayerEnabled ||
    venue.secondLayerAccessKey !== secondLayerKey ||
    session.userId === null ||
    session.activeTenantId !== venue.tenantId ||
    session.role === null
  ) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue experience not found' })
  }
  return 'SECOND_LAYER'
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt))
}

function stripEngagementMarker(text: string): { cleaned: string; markerFound: boolean } {
  const markerIndex = text.lastIndexOf(ENGAGEMENT_ASKED_MARKER)
  if (markerIndex === -1) {
    return { cleaned: text, markerFound: false }
  }
  return { cleaned: text.slice(0, markerIndex).trimEnd(), markerFound: true }
}

const admittedChatSendProcedure = publicProcedure
  .input(ChatSendInput)
  .use(async ({ ctx, input, next }) => {
    const globallyAllowed = await checkRateLimit(
      'ratelimit:chat:ingress:global',
      CHAT_GLOBAL_INGRESS_LIMIT,
      60,
    )
    if (!globallyAllowed) {
      throw publicTRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Chat is receiving too many requests. Please try again in a moment.',
        publicCode: 'RATE_LIMITED',
      })
    }

    // Resolve the caller-provided venue before creating any caller-derived rate
    // keys. The fixed global gate above bounds invalid-ID database traffic and
    // prevents arbitrary venue IDs from expanding Redis key cardinality.
    const [chatVenue] = await ctx.db.$queryRaw<PublicChatVenue[]>`
      SELECT v.id,
             v.tenant_id AS "tenantId",
             v.name,
             v.description,
             v.guide_notes AS "guideNotes",
             v.ai_guide_notes AS "aiGuideNotes",
             v.ai_featured_place_id AS "aiFeaturedPlaceId",
             v.ai_tone AS "aiTone",
             v.tone_preset AS "tonePreset",
             v.tone_preset_version AS "tonePresetVersion",
             v.ai_guide_name AS "aiGuideName",
             v.category,
             v.guide_mode AS "guideMode",
             v.default_center_lat AS "defaultCenterLat",
             v.default_center_lng AS "defaultCenterLng",
             v.is_active AS "isActive",
             v.second_layer_enabled AS "secondLayerEnabled",
             v.second_layer_label AS "secondLayerLabel",
             v.second_layer_access_key AS "secondLayerAccessKey",
             CASE WHEN vbc.personality_mode = 'CUSTOM' THEN pp.warmth END AS "customWarmth",
             CASE WHEN vbc.personality_mode = 'CUSTOM' THEN pp.brevity END AS "customBrevity",
             CASE WHEN vbc.personality_mode = 'CUSTOM' THEN pp.energy END AS "customEnergy",
             CASE WHEN vbc.personality_mode = 'CUSTOM' THEN pp.formality END AS "customFormality",
             CASE WHEN vbc.personality_mode = 'CUSTOM' THEN pp.custom_instruction END AS "customInstruction",
             vbc.presentation_mode AS "venueBotPresentationMode",
             vbc.character_key AS "venueBotCharacterKey"
      FROM venues v
      LEFT JOIN venue_bot_configurations vbc
        ON vbc.venue_id = v.id AND vbc.tenant_id = v.tenant_id
      LEFT JOIN personality_profiles pp
        ON pp.id = vbc.personality_profile_id
       AND pp.tenant_id = v.tenant_id
       AND pp.status = 'ACTIVE'
      WHERE v.id = ${input.venueId}
      LIMIT 1
    `

    if (!chatVenue) {
      throw publicTRPCError({
        code: 'NOT_FOUND',
        message: 'Venue not found',
        publicCode: 'CONTENT_UNAVAILABLE',
      })
    }
    if (!chatVenue.isActive) throw venueUnavailable()

    const experienceScope = authorizeChatExperience(chatVenue, ctx.session, input.secondLayerKey)

    return next({ ctx: { ...ctx, chatVenue, experienceScope } })
  })
  .use(async ({ ctx, input, next }) => {
    const ingressAllowed = await checkRateLimit(
      `ratelimit:chat:ingress:venue:${ctx.chatVenue.id}`,
      CHAT_INGRESS_VENUE_LIMIT,
      60,
    )
    if (!ingressAllowed) {
      throw publicTRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'This venue is receiving too many requests. Please try again in a moment.',
        publicCode: 'RATE_LIMITED',
      })
    }

    const sessionAllowed = await checkRateLimit(
      `ratelimit:chat:session:${ctx.chatVenue.id}:${input.anonymousToken}`,
      60,
      3600,
    )
    if (!sessionAllowed) {
      throw publicTRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'You have reached the message limit. Please try again later.',
        publicCode: 'RATE_LIMITED',
      })
    }

    const venueAllowed = await checkRateLimit(`ratelimit:chat:venue:${ctx.chatVenue.id}`, 30, 60)
    if (!venueAllowed) {
      throw publicTRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'This venue is receiving too many requests. Please try again in a moment.',
        publicCode: 'RATE_LIMITED',
      })
    }

    return next()
  })
  .use(requireGlobalAi)

// Exported for test coverage — trims to the last complete sentence that fits
// within maxWords. Always keeps at least the first sentence, even if that
// sentence alone runs over the cap, so a reply is never cut off mid-thought.
export function enforceResponseWordCap(text: string, maxWords: number): string {
  const trimmed = text.trim()
  if (trimmed.split(/\s+/).length <= maxWords) return trimmed

  const sentences = trimmed.match(/[^.!?]+[.!?]+[)'"]*|[^.!?]+$/g) ?? [trimmed]
  let result = ''
  let wordCount = 0
  for (const sentence of sentences) {
    const sentenceWords = sentence.trim().split(/\s+/).length
    if (result && wordCount + sentenceWords > maxWords) break
    result += (result ? ' ' : '') + sentence.trim()
    wordCount += sentenceWords
  }
  return result
}

// Backend-only content-gap detection (no guest-facing change, no extra model call).
// If even the best-matching place is semantically far from the question, the venue
// probably has no content for it. Reuses the retrieval distance we already compute.
// Cosine distance: 0 = identical, ~1 = orthogonal; ~0.55 ≈ similarity < ~0.45 for
// normalized OpenAI embeddings. NEEDS TUNING on real data before trusting the counts.
const LOW_CONFIDENCE_DISTANCE_THRESHOLD = 0.55

// Fallback heuristic for the geo/importance path, where there is no semantic score.
// Zero tokens — just pattern-matches the assistant reply for "no info" phrasing.
const NO_INFO_REPLY_PATTERN =
  /I don'?t have|I'?m not sure|check with (the )?(staff|front desk|reception)|couldn'?t find|don'?t have (that |any )?information|no information/i

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const chatRouter = router({
  /**
   * Idempotent session creation / update. Call this when the visitor first
   * opens the chat page so a session row exists before the first message.
   */
  session: publicProcedure.input(ChatSessionInput).mutation(async ({ ctx, input }) => {
    const globallyAllowed = await checkRateLimit(
      'ratelimit:chat-session:ingress:global',
      SESSION_SYNC_GLOBAL_LIMIT,
      60,
    )
    if (!globallyAllowed) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many session updates.' })
    }

    const venueAllowed = await checkRateLimit(
      `ratelimit:chat-session:venue:${input.venueId}`,
      SESSION_SYNC_VENUE_LIMIT,
      60,
    )
    if (!venueAllowed) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many session updates.' })
    }

    const sessionAllowed = await checkRateLimit(
      `ratelimit:chat-session:session:${input.venueId}:${input.anonymousToken}`,
      SESSION_SYNC_SESSION_LIMIT,
      60,
    )
    if (!sessionAllowed) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many session updates.' })
    }

    // $queryRaw used here because this is a public cross-tenant lookup — the caller
    // only knows the venueId, not the tenantId. No tenant_id bind needed in the
    // WHERE because we are resolving the tenant FROM this row, not filtering by it.
    const [venue] = await ctx.db.$queryRaw<
      {
        id: string
        tenantId: string
        guideMode: string | null
        isActive: boolean
        secondLayerEnabled: boolean
        secondLayerAccessKey: string | null
      }[]
    >`
      SELECT id,
             tenant_id AS "tenantId",
             guide_mode AS "guideMode",
             is_active AS "isActive"
             ,second_layer_enabled AS "secondLayerEnabled"
             ,second_layer_access_key AS "secondLayerAccessKey"
      FROM venues WHERE id = ${input.venueId} LIMIT 1
    `

    if (!venue) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
    }
    if (!venue.isActive) throw venueUnavailable()
    const experienceScope = authorizeChatExperience(venue, ctx.session, input.secondLayerKey)

    const isNonLocation = venue.guideMode === 'non_location'
    const updateData: Record<string, unknown> = {
      lastActiveAt: new Date(),
      latestLat: isNonLocation ? null : (input.lat ?? null),
      latestLng: isNonLocation ? null : (input.lng ?? null),
    }
    if (input.visitorId !== undefined) updateData.visitorId = input.visitorId

    const session = await ctx.db.visitorSession.upsert({
      where: {
        venueId_anonymousToken: {
          venueId: input.venueId,
          anonymousToken: input.anonymousToken,
        },
        tenantId: venue.tenantId,
      },
      create: {
        tenantId: venue.tenantId,
        venueId: input.venueId,
        anonymousToken: input.anonymousToken,
        experienceScope,
        latestLat: isNonLocation ? null : (input.lat ?? null),
        latestLng: isNonLocation ? null : (input.lng ?? null),
        lastActiveAt: new Date(),
        ...(input.visitorId !== undefined ? { visitorId: input.visitorId } : {}),
      },
      update: updateData,
      select: { id: true, experienceScope: true },
    })

    if ((session.experienceScope ?? 'PUBLIC') !== experienceScope) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Chat session not found' })
    }

    return { sessionId: session.id }
  }),

  /**
   * Send a message and receive an AI response grounded in venue + location data.
   */
  send: admittedChatSendProcedure.mutation(async ({ ctx, input }) => {
    const requestStartedAt = performance.now()
    let embeddingMs = 0
    let retrievalMs = 0
    let promptAssemblyMs = 0
    let modelMs = 0
    let persistenceMs = 0
    const trimmedInput = input.message
    const venue = ctx.chatVenue
    const includeSecondLayer = ctx.experienceScope === 'SECOND_LAYER'

    const guideMode = venue.guideMode ?? 'location_aware'
    const callerLocation =
      input.lat !== undefined && input.lng !== undefined ? { lat: input.lat, lng: input.lng } : null
    const liveLocation = guideMode === 'location_aware' ? callerLocation : null
    const defaultCenterLat = venue.defaultCenterLat
    const defaultCenterLng = venue.defaultCenterLng
    const defaultLocation =
      defaultCenterLat != null && defaultCenterLng != null
        ? { lat: defaultCenterLat, lng: defaultCenterLng }
        : null
    const rankingLocation =
      guideMode === 'location_aware' ? (liveLocation ?? defaultLocation) : null
    const hasLiveLocation = liveLocation !== null

    // 2. Reserve an exact, monotonic session turn before any provider boundary.
    // Legacy callers may omit operationId, but only an explicit client UUID can be retried safely.
    const operationId = input.operationId ?? randomUUID()
    const turnRequest = {
      tenantId: venue.tenantId,
      venueId: input.venueId,
      anonymousToken: input.anonymousToken,
      requestId: operationId,
      visitorId: input.visitorId ?? null,
      message: trimmedInput,
      language: input.language ?? null,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      retainLocation: guideMode !== 'non_location',
      experienceScope: ctx.experienceScope,
    }
    let reservation: Awaited<ReturnType<typeof reserveGuestChatTurnAction>>
    try {
      reservation = await reserveGuestChatTurnAction({ client: ctx.db, request: turnRequest })
    } catch (error) {
      guestChatTurnError(error)
    }
    if (reservation.state === 'COMPLETE') {
      return {
        response: reservation.response,
        assistantMessageId: reservation.assistantMessageId,
        sessionId: reservation.sessionId,
        places: reservation.places,
        citations: reservation.citations,
        replayed: true,
      }
    }
    if (reservation.state === 'AMBIGUOUS') {
      throw publicTRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'The original provider outcome could not be committed. Start a new message; the original operation will not be repeated.',
        publicCode: 'OUTCOME_AMBIGUOUS',
      })
    }
    const claimId = randomUUID()
    let claimed: Awaited<ReturnType<typeof claimGuestChatTurnAction>>
    try {
      claimed = await claimGuestChatTurnAction({
        client: ctx.db,
        claim: {
          tenantId: venue.tenantId,
          venueId: input.venueId,
          anonymousToken: input.anonymousToken,
          requestId: operationId,
          turnId: reservation.turnId,
          claimId,
        },
      })
    } catch (error) {
      guestChatTurnError(error)
    }
    if (claimed.state === 'COMPLETE') {
      return {
        response: claimed.response,
        assistantMessageId: claimed.assistantMessageId,
        sessionId: claimed.sessionId,
        places: claimed.places,
        citations: claimed.citations,
        replayed: true,
      }
    }
    if (claimed.state !== 'GENERATING') {
      throw new TRPCError({ code: 'CONFLICT', message: 'Chat turn claim is incomplete.' })
    }
    const session = { id: claimed.sessionId }
    const embeddingInvocationId = claimed.providerOperations.find(
      (operation) => operation.kind === 'QUERY_EMBEDDING',
    )?.invocationId
    const generationInvocationId = claimed.providerOperations.find(
      (operation) => operation.kind === 'RESPONSE_GENERATION',
    )?.invocationId
    if (!embeddingInvocationId || !generationInvocationId) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Chat provider evidence is incomplete.' })
    }

    // 3. Embed the user query, load history, and fetch active alerts in parallel.
    //    Embedding may fail (e.g. no OPENAI_API_KEY) — null triggers geo fallback.
    const embeddingStartedAt = performance.now()
    const embeddingAccounting = createApiAiUsageRecorder({
      db: ctx.db,
      tenantId: venue.tenantId,
      venueId: input.venueId,
      sessionId: session.id,
      feature: 'guest-chat-query-embedding',
      surface: 'guest-web',
    })
    const turnOperationBase = {
      tenantId: venue.tenantId,
      venueId: input.venueId,
      anonymousToken: input.anonymousToken,
      requestId: operationId,
      turnId: reservation.turnId,
      claimId,
    }
    const recordGuestAiFailure = async (
      category:
        | 'provider-unavailable'
        | 'pre-dispatch-failure'
        | 'provider-failure'
        | 'route-exhausted',
      routeConfigurationVersion?: string,
    ) => {
      const routeExhausted = category === 'route-exhausted'
      await publishOperationalEvent({
        client: ctx.db,
        event: {
          tenantId: venue.tenantId,
          venueId: input.venueId,
          eventType: routeExhausted ? 'guest-chat.route-degraded' : `guest-chat.${category}`,
          sourceSubsystem: 'guest-chat',
          severity: routeExhausted || category === 'provider-failure' ? 'ERROR' : 'WARNING',
          title: routeExhausted ? 'Visitor chat used its safe fallback' : 'Guest guide AI failure',
          summary: routeExhausted
            ? 'Every configured guest-chat route candidate failed for this venue; the guest received the safe fallback response.'
            : 'A guest chat turn encountered a sanitized AI service failure.',
          actionRequired: routeExhausted || category === 'provider-failure',
          linkedObjectType: 'guest-chat-turn',
          linkedObjectId: reservation.turnId,
          recommendedAction: routeExhausted
            ? 'Review sanitized usage failures and recent chat reliability evidence before changing routing or incident controls.'
            : 'Inspect the turn and recent provider outcomes in PathFinder OS.',
          deduplicationKey: routeExhausted
            ? `guest-chat-route-degraded:${input.venueId}:${routeConfigurationVersion ?? 'unknown'}`
            : `guest-chat-failure:${reservation.turnId}:${category}`,
        },
      }).catch(() => undefined)
    }
    let unhealthyProviders: Awaited<ReturnType<typeof readActiveUnhealthyAiProviders>>
    try {
      unhealthyProviders = await readActiveUnhealthyAiProviders(ctx.db)
    } catch {
      await failGuestChatTurnAction({
        client: ctx.db,
        claim: { ...turnOperationBase, failureCode: 'PRE_DISPATCH_FAILURE' },
      })
      await recordGuestAiFailure('pre-dispatch-failure')
      throw publicTRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'The guide could not start this message. Please send it again in a moment.',
        publicCode: 'TRANSIENT_FAILURE',
      })
    }
    let embeddingDispatched = false
    const queryEmbeddingPromise = unhealthyProviders.includes('openai')
      ? skipGuestChatProviderOperationAction({
          client: ctx.db,
          operation: { ...turnOperationBase, kind: 'QUERY_EMBEDDING' },
        })
          .then(() => null)
          .catch((error: unknown) => guestChatTurnError(error))
      : generateGuestQueryEmbedding(
          trimmedInput,
          embeddingAccounting.sink,
          () =>
            assertVenueAiAvailable(ctx.db, {
              tenantId: venue.tenantId,
              venueId: input.venueId,
            }),
          embeddingAccounting.budgetGate,
          embeddingInvocationId,
          async () => {
            try {
              await markGuestChatProviderDispatchedAction({
                client: ctx.db,
                operation: { ...turnOperationBase, kind: 'QUERY_EMBEDDING' },
              })
              embeddingDispatched = true
            } catch (error) {
              guestChatTurnError(error)
            }
          },
        )
          .then(async (embedding) => {
            await observeGuestChatProviderOperationAction({
              client: ctx.db,
              operation: {
                ...turnOperationBase,
                kind: 'QUERY_EMBEDDING',
                outcomeCode: 'SUCCEEDED',
                usageReference: embeddingAccounting.usageEventIds().at(-1) ?? null,
              },
            })
            return embedding
          })
          .catch(async (error: unknown) => {
            if (error instanceof GuestChatTurnActionError) guestChatTurnError(error)
            if (!embeddingDispatched) {
              await failGuestChatTurnAction({
                client: ctx.db,
                claim: {
                  ...turnOperationBase,
                  failureCode: isAiAdmissionControlError(error)
                    ? 'AI_UNAVAILABLE'
                    : 'PRE_DISPATCH_FAILURE',
                },
              })
              if (isAiAdmissionControlError(error)) {
                await recordGuestAiFailure('provider-unavailable')
                throw aiUnavailable()
              }
              await recordGuestAiFailure('pre-dispatch-failure')
              throw publicTRPCError({
                code: 'SERVICE_UNAVAILABLE',
                message:
                  'The guide could not start this message. Please send it again in a moment.',
                publicCode: 'TRANSIENT_FAILURE',
              })
            }
            await observeGuestChatProviderOperationAction({
              client: ctx.db,
              operation: {
                ...turnOperationBase,
                kind: 'QUERY_EMBEDDING',
                outcomeCode: isAiAdmissionControlError(error)
                  ? 'ADMISSION_REJECTED'
                  : 'FAILED_FALLBACK',
              },
            })
            if (isAiAdmissionControlError(error)) {
              await failGuestChatTurnAction({
                client: ctx.db,
                claim: { ...turnOperationBase, failureCode: 'AI_UNAVAILABLE' },
              })
              await recordGuestAiFailure('provider-unavailable')
              throw aiUnavailable()
            }
            return null
          })
          .finally(() => {
            embeddingMs = elapsedMilliseconds(embeddingStartedAt)
          })

    const operationalNow = new Date()
    const [queryEmbedding, historyDesc, activeUpdates, tenantEngagement, engagementQuestions] =
      await Promise.all([
        queryEmbeddingPromise,
        ctx.db.message.findMany({
          where: { sessionId: session.id, tenantId: venue.tenantId },
          orderBy: [{ sessionSequence: 'desc' }, { id: 'desc' }],
          take: HISTORY_LIMIT,
          select: { role: true, content: true },
        }),
        ctx.db.operationalUpdate.findMany({
          where: {
            venueId: input.venueId,
            tenantId: venue.tenantId,
            status: 'PUBLISHED',
            isActive: true,
            startsAt: { lte: operationalNow },
            expiresAt: { gt: operationalNow },
            ...(includeSecondLayer
              ? {}
              : {
                  OR: [{ placeId: null }, { place: { visibility: 'PUBLIC' } }],
                }),
          },
          select: {
            updateType: true,
            severity: true,
            priority: true,
            title: true,
            body: true,
            redirectTo: true,
            place: { select: { name: true } },
          },
          orderBy: [{ priority: 'desc' }, { startsAt: 'desc' }, { id: 'asc' }],
          take: MAX_GUEST_OPERATIONAL_UPDATES,
        }),
        ctx.db.tenant.findUnique({
          where: { id: venue.tenantId },
          select: { engagementMode: true },
        }),
        ctx.db.engagementQuestion.findMany({
          where: { tenantId: venue.tenantId, isActive: true },
          select: {
            id: true,
            questionType: true,
            prompt: true,
            choiceOptions: true,
            intensity: true,
          },
        }),
      ])

    if (
      historyDesc.length === 1 &&
      venue.venueBotPresentationMode === 'CHARACTER' &&
      venue.venueBotCharacterKey &&
      isFeatureEnabled('venueCharacterMode') &&
      isFeatureEnabled('characterRegistry') &&
      (venue.venueBotCharacterKey !== 'tochi' || isFeatureEnabled('tochiVenueCharacter')) &&
      resolveSystemCharacterProjection(venue.venueBotCharacterKey)
    ) {
      const requiredKeys = [
        TOCHI_TENANT_FLAG_KEYS.venueCharacterMode,
        TOCHI_TENANT_FLAG_KEYS.characterRegistry,
        ...(venue.venueBotCharacterKey === 'tochi'
          ? [TOCHI_TENANT_FLAG_KEYS.tochiVenueCharacter]
          : []),
      ]
      void ctx.db.tenantFeatureFlag
        .findMany({
          where: { tenantId: venue.tenantId, enabled: true, flagKey: { in: requiredKeys } },
          select: { flagKey: true },
        })
        .then((rows) => {
          const enabled = new Set(rows.map((row) => row.flagKey))
          if (requiredKeys.every((key) => enabled.has(key))) {
            return emitEvent({
              tenantId: venue.tenantId,
              venueId: input.venueId,
              eventType: 'character_chat_started',
              metadata: {
                sessionId: session.id,
                characterKey: venue.venueBotCharacterKey,
              },
            })
          }
          return undefined
        })
        .catch(() => undefined)
    }

    // 4. Retrieve relevant places and knowledge entries.
    //    When an embedding is available both searches run in parallel (same query embedding,
    //    no inter-dependency). Geo-nearest fallback for places when embedding is absent;
    //    knowledge entries fall back to empty (no non-semantic fallback needed).
    const retrievalStartedAt = performance.now()
    const nativeReadSnapshotPromise = resolveNativeGuestReadSnapshotAction({
      client: ctx.db,
      tenantId: venue.tenantId,
      venueId: input.venueId,
    })
    let relevantPlaces: Awaited<ReturnType<typeof searchPlacesByEmbedding>>
    let relevantKnowledgeEntries: Awaited<ReturnType<typeof searchKnowledgeByEmbedding>>
    if (queryEmbedding) {
      const [places, knowledge] = await Promise.all([
        searchPlacesByEmbedding({
          queryEmbedding,
          venueId: input.venueId,
          tenantId: venue.tenantId,
          userLat: rankingLocation?.lat ?? null,
          userLng: rankingLocation?.lng ?? null,
          limit: NEAREST_PLACES_LIMIT,
          includeSecondLayer,
        }),
        searchKnowledgeByEmbedding({
          queryEmbedding,
          venueId: input.venueId,
          tenantId: venue.tenantId,
          limit: KNOWLEDGE_ENTRIES_LIMIT,
          includeSecondLayer,
        }).catch(() => []),
      ])
      relevantPlaces = hasLiveLocation
        ? places
        : places.map(({ distanceMeters, ...place }) => {
            void distanceMeters
            return place
          })
      relevantKnowledgeEntries = knowledge
    } else {
      relevantKnowledgeEntries = []
      const fallbackPlaces = await ctx.db.place.findMany({
        where: {
          venueId: input.venueId,
          tenantId: venue.tenantId,
          isActive: true,
          ...(includeSecondLayer ? {} : { visibility: 'PUBLIC' }),
        },
        select: {
          id: true,
          name: true,
          type: true,
          itemType: true,
          shortDescription: true,
          longDescription: true,
          lat: true,
          lng: true,
          tags: true,
          areaName: true,
          hours: true,
          photoUrl: true,
          sourceType: true,
          sourceName: true,
          sourceUrl: true,
          importanceScore: true,
        },
        orderBy: { importanceScore: 'desc' },
        take: NEAREST_PLACES_LIMIT,
      })
      const importanceRankedPlaces = fallbackPlaces.map(({ importanceScore, ...place }) => {
        void importanceScore
        return place
      })
      if (rankingLocation) {
        const rankedPlaces = findNearestPlaces(
          rankingLocation.lat,
          rankingLocation.lng,
          importanceRankedPlaces,
          NEAREST_PLACES_LIMIT,
        )
        relevantPlaces = hasLiveLocation
          ? rankedPlaces
          : rankedPlaces.map(({ distanceMeters, ...place }) => {
              void distanceMeters
              return place
            })
      } else {
        relevantPlaces = importanceRankedPlaces
      }
    }
    const nativeReadSnapshot = await nativeReadSnapshotPromise
    const nativeRead = applyNativeGuestContentRead({
      snapshot: nativeReadSnapshot,
      legacyPlaces: relevantPlaces,
      legacyKnowledgeEntries: relevantKnowledgeEntries,
    })
    relevantPlaces = nativeRead.places
    relevantKnowledgeEntries = nativeRead.knowledgeEntries
    if (nativeReadSnapshot.reason !== 'SERVER_DISABLED')
      logger.info({
        action: 'guest-chat.native-content-read',
        tenantId: venue.tenantId,
        venueId: input.venueId,
        readPath: nativeRead.path,
        gateReason: nativeReadSnapshot.reason,
        releaseId: nativeReadSnapshot.releaseId,
      })
    retrievalMs = elapsedMilliseconds(retrievalStartedAt)

    let featuredPlace: {
      name: string
      blurb: string
    } | null = null

    if (venue.aiFeaturedPlaceId) {
      const matchingPlace = relevantPlaces.find((place) => place.id === venue.aiFeaturedPlaceId)
      const compatibilityFeaturedPlace =
        matchingPlace ??
        (await ctx.db.place.findFirst({
          where: {
            id: venue.aiFeaturedPlaceId,
            venueId: input.venueId,
            tenantId: venue.tenantId,
            isActive: true,
            ...(includeSecondLayer ? {} : { visibility: 'PUBLIC' }),
          },
          select: {
            id: true,
            name: true,
            shortDescription: true,
            longDescription: true,
          },
        }))
      const nativeFeaturedPlace =
        nativeRead.path === 'NATIVE' && compatibilityFeaturedPlace
          ? (nativeReadSnapshot.state?.places.find(
              (place) => place.id === compatibilityFeaturedPlace.id,
            ) ?? null)
          : null
      // A compatibility row is still required to authorize visibility. If the
      // exact native snapshot lacks that authorized ID, omit the optional card
      // instead of mixing read sources.
      const featuredPlaceSource =
        nativeRead.path === 'NATIVE' ? nativeFeaturedPlace : compatibilityFeaturedPlace

      if (featuredPlaceSource) {
        featuredPlace = {
          name: featuredPlaceSource.name,
          blurb:
            featuredPlaceSource.longDescription ??
            featuredPlaceSource.shortDescription ??
            'a featured stop for guests at this venue',
        }
      }
    }

    // 5. Build context — history arrives newest-first, reverse to oldest-first for Claude
    const engagementMode = tenantEngagement?.engagementMode ?? 'STOIC'
    const engagementGatePassed =
      ctx.experienceScope === 'PUBLIC' && rollEngagementGate(engagementMode)
    const selectedEngagementQuestion = engagementGatePassed
      ? selectAuthoredQuestion(engagementQuestions)
      : null
    // Curious mode invites the AI to invent its own question when the gate
    // passed, regardless of whether an authored one was also offered - it's a
    // fallback the AI uses only if the authored one (or none existing) doesn't
    // fit a natural opening this turn.
    const allowAiInventedQuestion = engagementGatePassed && engagementMode === 'CURIOUS'

    const promptAssemblyStartedAt = performance.now()
    const publishedUniversalContent = isFeatureEnabled('generalizedContentCapabilities')
      ? await resolveEffectivePublishedUniversalContent({
          db: ctx.db,
          tenantId: venue.tenantId,
          venueId: input.venueId,
          maximumModules: 50,
        }).catch((error: unknown) => {
          logger.warn({
            action: 'guest-chat.published-content-unavailable',
            tenantId: venue.tenantId,
            venueId: input.venueId,
            errorName: error instanceof Error ? error.name : 'UnknownError',
          })
          return []
        })
      : []
    const customPersonality = CustomPersonalityBoundsSchema.safeParse({
      warmth: (venue.customWarmth ?? -1) / 100,
      brevity: (venue.customBrevity ?? -1) / 100,
      energy: (venue.customEnergy ?? -1) / 100,
      formality: (venue.customFormality ?? -1) / 100,
      ...(venue.customInstruction ? { customInstruction: venue.customInstruction } : {}),
    })
    const { staticPart, dynamicPart } = buildVenueSystemPromptParts({
      venue: {
        ...venue,
        ...(customPersonality.success ? { customPersonality: customPersonality.data } : {}),
      },
      relevantPlaces,
      knowledgeEntries: relevantKnowledgeEntries,
      activeUpdates,
      publishedUniversalContent,
      userLat: liveLocation?.lat ?? null,
      userLng: liveLocation?.lng ?? null,
      featuredPlace,
      ...(input.language ? { language: input.language } : {}),
      guideMode,
      ...(selectedEngagementQuestion || allowAiInventedQuestion
        ? {
            engagementQuestion: {
              ...(selectedEngagementQuestion
                ? {
                    questionType: selectedEngagementQuestion.questionType,
                    prompt: selectedEngagementQuestion.prompt,
                    choiceOptions: selectedEngagementQuestion.choiceOptions,
                  }
                : {}),
              allowAiInvented: allowAiInventedQuestion,
            },
          }
        : {}),
    })
    const history = historyDesc.reverse()
    promptAssemblyMs = elapsedMilliseconds(promptAssemblyStartedAt)

    // 6. Call the AI gateway. Provider failure remains fail-open for the guest,
    //    while every attempt is recorded best-effort for cost and reliability evidence.
    let assistantResponse: string
    let engagementAskedThisTurn = false
    let fallbackFailureCode: string | null = null
    let fallbackWasRouteExhaustion = false
    let generationRouteConfigurationVersion: string | undefined
    const modelStartedAt = performance.now()
    const chatAccounting = createApiAiUsageRecorder({
      db: ctx.db,
      tenantId: venue.tenantId,
      venueId: input.venueId,
      sessionId: session.id,
      feature: 'guest-chat',
      surface: 'guest-web',
    })
    let generationDispatched = false
    try {
      const configuration = await resolveRuntimeAiWorkloadConfiguration(
        {
          workloadId: 'guest-chat',
          tenantId: venue.tenantId,
          venueId: input.venueId,
        },
        ctx.db,
      )
      const route = routeAiCapability({
        capability: 'STANDARD',
        workloadId: 'guest-chat',
        configuration,
        unhealthyProviders,
      })
      generationRouteConfigurationVersion = route.configurationVersion
      const result = await generateTextForCapability({
        route,
        timeoutMs: configuration.timeoutMs,
        maxAttempts: configuration.maxAttempts,
        ...(configuration.maxOutputTokens !== null
          ? { maxOutputTokens: configuration.maxOutputTokens }
          : {}),
        admissionGuard: () =>
          assertVenueAiAvailable(ctx.db, {
            tenantId: venue.tenantId,
            venueId: input.venueId,
          }),
        budgetGate: chatAccounting.budgetGate,
        system: [
          { type: 'text', text: staticPart, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: dynamicPart },
        ],
        messages: [
          ...history.map((m: { role: string; content: string }) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          })),
          { role: 'user', content: trimmedInput },
        ],
        usageSink: chatAccounting.sink,
        invocationId: generationInvocationId,
        onBeforeFirstDispatch: async () => {
          try {
            await markGuestChatProviderDispatchedAction({
              client: ctx.db,
              operation: { ...turnOperationBase, kind: 'RESPONSE_GENERATION' },
            })
            generationDispatched = true
          } catch (error) {
            guestChatTurnError(error)
          }
        },
      })

      const { cleaned: strippedResponse, markerFound } = stripEngagementMarker(result.text)
      assistantResponse = enforceResponseWordCap(strippedResponse, MAX_RESPONSE_WORDS)
      engagementAskedThisTurn =
        markerFound && (selectedEngagementQuestion !== null || allowAiInventedQuestion)
      await observeGuestChatProviderOperationAction({
        client: ctx.db,
        operation: {
          ...turnOperationBase,
          kind: 'RESPONSE_GENERATION',
          outcomeCode: 'SUCCEEDED',
          usageReference: chatAccounting.usageEventIds().at(-1) ?? null,
        },
      })
    } catch (err) {
      if (err instanceof GuestChatTurnActionError) guestChatTurnError(err)
      if (!generationDispatched) {
        await failGuestChatTurnAction({
          client: ctx.db,
          claim: {
            ...turnOperationBase,
            failureCode:
              isAiAdmissionControlError(err) || err instanceof AiRoutingError
                ? 'AI_UNAVAILABLE'
                : 'PRE_DISPATCH_FAILURE',
          },
        })
        if (isAiAdmissionControlError(err) || err instanceof AiRoutingError) {
          await recordGuestAiFailure('provider-unavailable')
          throw aiUnavailable()
        }
        await recordGuestAiFailure('pre-dispatch-failure')
        throw publicTRPCError({
          code: 'SERVICE_UNAVAILABLE',
          message: 'The guide could not start this message. Please send it again in a moment.',
          publicCode: 'TRANSIENT_FAILURE',
        })
      }
      await observeGuestChatProviderOperationAction({
        client: ctx.db,
        operation: {
          ...turnOperationBase,
          kind: 'RESPONSE_GENERATION',
          outcomeCode: isAiAdmissionControlError(err) ? 'ADMISSION_REJECTED' : 'FAILED_FALLBACK',
        },
      })
      if (isAiAdmissionControlError(err)) {
        await failGuestChatTurnAction({
          client: ctx.db,
          claim: { ...turnOperationBase, failureCode: 'AI_UNAVAILABLE' },
        })
        await recordGuestAiFailure('provider-unavailable')
        throw aiUnavailable()
      }
      fallbackFailureCode = err instanceof AiGatewayError ? err.code : 'unexpected-error'
      fallbackWasRouteExhaustion = err instanceof AiGatewayError
      logger.error({
        action: 'chat.send.ai_failed',
        venueId: input.venueId,
        error: 'Guest chat provider generation failed',
        failureCode: fallbackFailureCode,
        errorName: err instanceof AiGatewayError ? 'AiGatewayError' : 'UnexpectedError',
      })
      assistantResponse = "I'm having trouble right now. Please try again in a moment."
    } finally {
      modelMs = elapsedMilliseconds(modelStartedAt)
    }

    // 7. Commit the entire visible turn and engagement/session transition atomically.
    const persistenceStartedAt = performance.now()
    const mentionedPlaces = buildGuestPlaceCards({
      assistantResponse,
      hasLiveLocation,
      places: relevantPlaces,
    })
    const citations = buildGuestCitations({
      assistantResponse,
      candidates: [
        ...relevantPlaces.map((place) => ({
          entityId: place.id,
          entityLabel: place.name,
          entityKind: 'place' as const,
          sourceType: place.sourceType,
          sourceName: place.sourceName,
          sourceUrl: place.sourceUrl,
        })),
        ...relevantKnowledgeEntries.map((entry) => ({
          entityId: entry.id,
          entityLabel: entry.title,
          entityKind: 'knowledge' as const,
          sourceType: entry.sourceType,
          sourceName: entry.sourceName,
          sourceUrl: entry.sourceUrl,
        })),
      ],
    })
    let finalized: Awaited<ReturnType<typeof finalizeGuestChatTurnAction>>
    try {
      finalized = await finalizeGuestChatTurnAction({
        client: ctx.db,
        input: {
          ...turnRequest,
          turnId: reservation.turnId,
          claimId,
          assistantResponse,
          replayMetadata: { places: mentionedPlaces, citations },
          fallbackCode: fallbackFailureCode,
          nextPending: engagementAskedThisTurn
            ? selectedEngagementQuestion
              ? { kind: 'AUTHORED', questionId: selectedEngagementQuestion.id }
              : { kind: 'INVENTED' }
            : { kind: 'NONE' },
        },
      })
    } catch (error) {
      guestChatTurnError(error)
    }
    const userMessageId = finalized.userMessageId
    if (!userMessageId) {
      guestChatTurnError(
        new GuestChatTurnActionError(
          'CONFLICT',
          'Committed chat turn is missing user-message evidence.',
        ),
      )
    }
    persistenceMs = elapsedMilliseconds(persistenceStartedAt)

    if (fallbackFailureCode) {
      await recordGuestAiFailure(
        fallbackWasRouteExhaustion ? 'route-exhausted' : 'provider-failure',
        generationRouteConfigurationVersion,
      )
    }

    const totalMs = elapsedMilliseconds(requestStartedAt)
    const timingMetadata = {
      embeddingMs,
      retrievalMs,
      promptAssemblyMs,
      modelMs,
      persistenceMs,
      totalMs,
    }

    // Project only active, already tenant/venue-scoped retrieval results that the
    // current answer names. Location presentation data is admitted only when the
    // guest supplied a usable live position; descriptive cards remain useful in
    // non-location and location-denied experiences.
    // Employee conversations remain distinguishable through VisitorSession.experienceScope,
    // but must not feed visitor analytics, engagement prompts, content-gap rollups, or customer
    // weekly reports until those products have an explicit employee scope.
    if (ctx.experienceScope === 'PUBLIC') {
      if (fallbackFailureCode) {
        try {
          await emitEvent({
            tenantId: venue.tenantId,
            venueId: input.venueId,
            sessionId: session.id,
            userMessageId,
            eventType: 'message.fallback',
            metadata: {
              failureStage: 'generation',
              failureCode: fallbackFailureCode,
              ...timingMetadata,
            },
          })
        } catch {
          // Reliability analytics are best-effort and must not break guest chat.
        }
      }

      try {
        await emitEvent({
          tenantId: venue.tenantId,
          venueId: input.venueId,
          sessionId: session.id,
          userMessageId,
          eventType: 'message.sent',
          metadata: {
            messageLength: trimmedInput.length,
          },
        })
      } catch {
        // Interaction analytics are best-effort and must not break guest chat.
      }

      try {
        await emitEvent({
          tenantId: venue.tenantId,
          venueId: input.venueId,
          sessionId: session.id,
          userMessageId,
          eventType: 'message.received',
          metadata: {
            responseLength: assistantResponse.length,
            placesReturned: mentionedPlaces.length,
            fallback: fallbackFailureCode !== null,
            retrievalMode: queryEmbedding
              ? hasLiveLocation
                ? 'semantic'
                : 'semantic-without-live-location'
              : hasLiveLocation
                ? 'geo'
                : rankingLocation
                  ? 'default-center-without-live-location'
                  : 'importance-without-location',
            ...(fallbackFailureCode ? { failureCode: fallbackFailureCode } : {}),
            ...timingMetadata,
          },
        })
      } catch {
        // Response analytics are best-effort and must not break guest chat.
      }

      if (selectedEngagementQuestion || allowAiInventedQuestion) {
        try {
          await emitEvent({
            tenantId: venue.tenantId,
            venueId: input.venueId,
            sessionId: session.id,
            eventType: 'engagement_question.asked',
            metadata: {
              engagementQuestionId: selectedEngagementQuestion?.id ?? null,
              intensity: selectedEngagementQuestion?.intensity ?? null,
              aiInventionAllowed: allowAiInventedQuestion,
              mode: engagementMode,
            },
          })
        } catch {
          // Engagement analytics are best-effort and must not break guest chat.
        }
      }

      // Backend-only low-confidence detection (decision E). Invisible to the guest —
      // the reply above already projected confidence; this only feeds content-gap
      // analytics. No extra model call: reuse the retrieval distance, or fall back to
      // a zero-token reply heuristic when the geo path ran (no semantic score).
      const retrievalDistances = [
        relevantPlaces[0]?.distance,
        relevantKnowledgeEntries[0]?.distance,
      ].filter((distance): distance is number => typeof distance === 'number')
      const topDistance = queryEmbedding
        ? retrievalDistances.length > 0
          ? Math.min(...retrievalDistances)
          : null
        : null
      const isLowConfidence =
        NO_INFO_REPLY_PATTERN.test(assistantResponse) ||
        (queryEmbedding !== null &&
          (topDistance === null || topDistance > LOW_CONFIDENCE_DISTANCE_THRESHOLD))

      if (isLowConfidence) {
        try {
          await emitEvent({
            tenantId: venue.tenantId,
            venueId: input.venueId,
            sessionId: session.id,
            userMessageId,
            eventType: 'message.low_confidence',
            metadata: {
              questionLength: trimmedInput.length,
              score: topDistance,
            },
          })
        } catch {
          // Low-confidence analytics are best-effort and must not break guest chat.
        }

        try {
          await recordConversationInsightSignals({
            client: ctx.db,
            signals: [
              {
                tenantId: venue.tenantId,
                venueId: input.venueId,
                sessionId: session.id,
                guestChatTurnId: reservation.turnId,
                category: 'LOW_CONFIDENCE_ANSWER',
                confidence: topDistance === null ? 0.7 : Math.min(1, Math.max(0, topDistance)),
                severity: 'LOW',
                summary:
                  'The guest answer was generated without sufficiently strong trusted retrieval evidence.',
                suggestedAction:
                  'Review the source conversation and determine whether venue knowledge needs improvement.',
                evidenceMessageIds: [userMessageId],
                capability: 'CLASSIFICATION',
                provider: 'pathfinder',
                model: 'retrieval-confidence-rules',
                analyzerVersion: 'guest-turn-signals-v1',
              },
              {
                tenantId: venue.tenantId,
                venueId: input.venueId,
                sessionId: session.id,
                guestChatTurnId: reservation.turnId,
                category: 'KNOWLEDGE_GAP',
                confidence: topDistance === null ? 0.65 : Math.min(1, Math.max(0, topDistance)),
                severity: 'MEDIUM',
                summary:
                  'This conversation may identify missing or hard-to-retrieve public venue knowledge.',
                suggestedAction:
                  'Verify the visitor question against canonical public knowledge before proposing an update.',
                evidenceMessageIds: [userMessageId],
                capability: 'CLASSIFICATION',
                provider: 'pathfinder',
                model: 'retrieval-confidence-rules',
                analyzerVersion: 'guest-turn-signals-v1',
              },
            ],
          })
          await publishOperationalEvent({
            client: ctx.db,
            event: {
              tenantId: venue.tenantId,
              venueId: input.venueId,
              eventType: 'knowledge.gap.detected',
              sourceSubsystem: 'conversation-intelligence',
              severity: 'WARNING',
              title: 'Possible visitor knowledge gap',
              summary: 'A public answer lacked sufficiently strong trusted retrieval evidence.',
              actionRequired: true,
              linkedObjectType: 'guest-chat-turn',
              linkedObjectId: reservation.turnId,
              recommendedAction:
                'Review the source conversation before proposing a canonical knowledge change.',
              deduplicationKey: `knowledge-gap:${reservation.turnId}`,
            },
          })
        } catch {
          // Conversation intelligence is post-response evidence and cannot fail a guest turn.
        }
      }
    }

    return {
      response: finalized.response,
      assistantMessageId: finalized.assistantMessageId,
      sessionId: finalized.sessionId,
      places: finalized.places,
      citations: finalized.citations,
      replayed: finalized.replayed,
    }
  }),

  /**
   * Load the message history for an existing session by anonymous token.
   * Returns messages oldest-first. Returns an empty array if no session exists
   * yet — the chat page treats that as a fresh conversation.
   */
  history: publicProcedure.input(ChatHistoryInput).query(async ({ ctx, input }) => {
    const globallyAllowed = await checkRateLimit(
      'ratelimit:chat-history:ingress:global',
      HISTORY_GLOBAL_LIMIT,
      60,
    )
    if (!globallyAllowed) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many history requests.' })
    }

    const venueAllowed = await checkRateLimit(
      `ratelimit:chat-history:venue:${input.venueId}`,
      HISTORY_VENUE_LIMIT,
      60,
    )
    if (!venueAllowed) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many history requests.' })
    }

    const sessionAllowed = await checkRateLimit(
      `ratelimit:chat-history:session:${input.venueId}:${input.anonymousToken}`,
      HISTORY_SESSION_LIMIT,
      60,
    )
    if (!sessionAllowed) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many history requests.' })
    }

    // This is a public cross-tenant lookup, so resolve tenant ownership from the
    // venue-scoped session identity. Browser tokens are generated per venue, and
    // this lookup must never select a session from another venue.
    const [session] = await ctx.db.$queryRaw<
      {
        id: string | null
        venueId: string
        tenantId: string
        isActive: boolean
        experienceScope: string | null
        secondLayerEnabled: boolean
        secondLayerAccessKey: string | null
      }[]
    >`
        SELECT visitor_sessions.id,
               venues.id AS "venueId",
               venues.tenant_id AS "tenantId",
               venues.is_active AS "isActive"
               ,visitor_sessions.experience_scope AS "experienceScope"
               ,venues.second_layer_enabled AS "secondLayerEnabled"
               ,venues.second_layer_access_key AS "secondLayerAccessKey"
        FROM venues
        LEFT JOIN visitor_sessions
          ON visitor_sessions.venue_id = venues.id
         AND visitor_sessions.tenant_id = venues.tenant_id
         AND visitor_sessions.anonymous_token = ${input.anonymousToken}
        WHERE venues.id = ${input.venueId}
        LIMIT 1
      `

    // No session yet — fresh visitor, return empty history
    if (!session) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
    if (!session.isActive) throw venueUnavailable()
    const experienceScope = authorizeChatExperience(session, ctx.session, input.secondLayerKey)
    if (!session.id) {
      return { messages: [] }
    }
    if ((session.experienceScope ?? 'PUBLIC') !== experienceScope) {
      return { messages: [] }
    }

    const rows = await ctx.db.message.findMany({
      where: { sessionId: session.id, tenantId: session.tenantId },
      orderBy: [{ sessionSequence: 'desc' }, { id: 'desc' }],
      take: HISTORY_LOAD_LIMIT,
      select: {
        id: true,
        role: true,
        content: true,
        guestChatTurn: { select: { replayMetadata: true } },
      },
    })

    return {
      messages: rows.reverse().map((m) => {
        const replay =
          m.role === 'assistant'
            ? GuestChatReplayMetadata.safeParse(m.guestChatTurn?.replayMetadata)
            : null
        return {
          id: m.id,
          role: m.role as 'user' | 'assistant',
          content: m.content,
          ...(replay?.success && replay.data.places.length ? { places: replay.data.places } : {}),
          ...(replay?.success && replay.data.citations.length
            ? {
                blocks: [
                  {
                    type: 'citations' as const,
                    citations: replay.data.citations,
                  },
                ],
              }
            : {}),
        }
      }),
    }
  }),
})
