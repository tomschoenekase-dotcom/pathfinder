import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  AiGatewayError,
  AI_MODEL_KEYS,
  generateText,
  setAnthropicClientForTesting,
  type AnthropicMessagesClient,
} from '@pathfinder/ai'
import { emitEvent } from '@pathfinder/analytics'
import { searchKnowledgeByEmbedding, searchPlacesByEmbedding } from '@pathfinder/db'

import { logger } from '@pathfinder/config'

import { router } from '../core'
import { rollEngagementGate, selectAuthoredQuestion } from '../lib/engagement-questions'
import { findNearestPlaces } from '../lib/geo'
import { generateGuestQueryEmbedding } from '../lib/guest-query-embedding'
import { checkRateLimit } from '../lib/rate-limit'
import { buildVenueSystemPromptParts } from '../lib/venue-context'
import { MAX_GUEST_OPERATIONAL_UPDATES } from '../schemas/operational-update'
import { publicProcedure } from '../trpc'

// ---------------------------------------------------------------------------
// Provider test seam (the production singleton is owned by @pathfinder/ai)
// ---------------------------------------------------------------------------

// Exported for test injection while provider ownership lives in @pathfinder/ai.
export function _setAnthropicClientForTesting(client: AnthropicMessagesClient | null): void {
  setAnthropicClientForTesting(client)
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const sessionSchema = z
  .object({
    venueId: z.string().min(1),
    anonymousToken: z.string().uuid(),
    visitorId: z.string().uuid().optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
  })
  .strict()

const sendMessageSchema = z
  .object({
    venueId: z.string().min(1),
    anonymousToken: z.string().uuid(),
    visitorId: z.string().uuid().optional(),
    message: z.string().min(1).max(1000),
    lat: z.number().optional(),
    lng: z.number().optional(),
    language: z.string().max(50).optional(),
  })
  .strict()

const NEAREST_PLACES_LIMIT = 8
const KNOWLEDGE_ENTRIES_LIMIT = 5
const HISTORY_LIMIT = 10
const HISTORY_LOAD_LIMIT = 40
const ENGAGEMENT_ASKED_MARKER = '[[ENGAGEMENT_ASKED]]'
// Backstop for the word-count rules in venue-context.ts. Prompt instructions
// are honored loosely by the model, not exactly — this guarantees the cap
// guests actually see, regardless of how closely the model followed the prompt.
const MAX_RESPONSE_WORDS = 60

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
  session: publicProcedure.input(sessionSchema).mutation(async ({ ctx, input }) => {
    // $queryRaw used here because this is a public cross-tenant lookup — the caller
    // only knows the venueId, not the tenantId. No tenant_id bind needed in the
    // WHERE because we are resolving the tenant FROM this row, not filtering by it.
    const [venue] = await ctx.db.$queryRaw<{ id: string; tenantId: string }[]>`
      SELECT id, tenant_id AS "tenantId" FROM venues WHERE id = ${input.venueId} AND is_active = true LIMIT 1
    `

    if (!venue) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
    }

    const updateData: Record<string, unknown> = { lastActiveAt: new Date() }
    if (input.lat !== undefined) updateData.latestLat = input.lat
    if (input.lng !== undefined) updateData.latestLng = input.lng
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
        latestLat: input.lat ?? null,
        latestLng: input.lng ?? null,
        lastActiveAt: new Date(),
        ...(input.visitorId !== undefined ? { visitorId: input.visitorId } : {}),
      },
      update: updateData,
      select: { id: true },
    })

    return { sessionId: session.id }
  }),

  /**
   * Send a message and receive an AI response grounded in venue + location data.
   */
  send: publicProcedure.input(sendMessageSchema).mutation(async ({ ctx, input }) => {
    const requestStartedAt = performance.now()
    let embeddingMs = 0
    let retrievalMs = 0
    let promptAssemblyMs = 0
    let modelMs = 0
    let persistenceMs = 0
    const trimmedInput = input.message.trim()
    // 1. Validate venue
    // $queryRaw used here because this is a public cross-tenant lookup — the caller
    // only knows the venueId, not the tenantId. No tenant_id bind needed in the
    // WHERE because we are resolving the tenant FROM this row, not filtering by it.
    const [venue] = await ctx.db.$queryRaw<
      {
        id: string
        tenantId: string
        name: string
        description: string | null
        guideNotes: string | null
        aiGuideNotes: string | null
        aiFeaturedPlaceId: string | null
        aiTone: string | null
        aiGuideName: string | null
        category: string | null
        guideMode: string | null
        defaultCenterLat: number | null
        defaultCenterLng: number | null
      }[]
    >`
      SELECT id,
             tenant_id AS "tenantId",
             name,
             description,
             guide_notes AS "guideNotes",
             ai_guide_notes AS "aiGuideNotes",
             ai_featured_place_id AS "aiFeaturedPlaceId",
             ai_tone AS "aiTone",
             ai_guide_name AS "aiGuideName",
             category,
             guide_mode AS "guideMode",
             default_center_lat AS "defaultCenterLat",
             default_center_lng AS "defaultCenterLng"
      FROM venues WHERE id = ${input.venueId} AND is_active = true LIMIT 1
    `

    if (!venue) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
    }

    const guideMode = venue.guideMode ?? 'location_aware'
    const userLat = input.lat ?? venue.defaultCenterLat
    const userLng = input.lng ?? venue.defaultCenterLng

    if (guideMode === 'location_aware' && (userLat == null || userLng == null)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Location is still unavailable for this venue.',
      })
    }

    const contextLat = userLat ?? 0
    const contextLng = userLng ?? 0

    const [sessionAllowed, venueAllowed] = await Promise.all([
      checkRateLimit(`ratelimit:chat:session:${input.venueId}:${input.anonymousToken}`, 60, 3600),
      checkRateLimit(`ratelimit:chat:venue:${input.venueId}`, 30, 60),
    ])

    if (!sessionAllowed || !venueAllowed) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: sessionAllowed
          ? 'This venue is receiving too many requests. Please try again in a moment.'
          : 'You have reached the message limit. Please try again later.',
      })
    }

    // 2. Upsert session, update location
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
        latestLat: input.lat ?? null,
        latestLng: input.lng ?? null,
        lastActiveAt: new Date(),
        ...(input.visitorId !== undefined ? { visitorId: input.visitorId } : {}),
      },
      update: {
        latestLat: input.lat ?? null,
        latestLng: input.lng ?? null,
        lastActiveAt: new Date(),
        ...(input.visitorId !== undefined ? { visitorId: input.visitorId } : {}),
      },
      select: {
        id: true,
        pendingEngagementQuestionId: true,
        pendingEngagementIsInvented: true,
        pendingEngagementAskedMessageId: true,
        pendingEngagementAskedAt: true,
      },
    })
    const pendingAnswerSnapshot =
      session.pendingEngagementQuestionId != null || session.pendingEngagementIsInvented === true
        ? { ...session }
        : null

    // 3. Embed the user query, load history, and fetch active alerts in parallel.
    //    Embedding may fail (e.g. no OPENAI_API_KEY) — null triggers geo fallback.
    const embeddingStartedAt = performance.now()
    const queryEmbeddingPromise = generateGuestQueryEmbedding(trimmedInput, async (usage) => {
      try {
        await ctx.db.aiUsageEvent.create({
          data: {
            tenantId: venue.tenantId,
            venueId: input.venueId,
            sessionId: session.id,
            feature: 'guest-chat-query-embedding',
            surface: 'guest-web',
            provider: usage.provider,
            model: usage.model,
            pricingVersion: usage.pricingVersion,
            inputTokens: usage.usage.inputTokens,
            outputTokens: usage.usage.outputTokens,
            cacheCreationInputTokens: usage.usage.cacheCreationInputTokens,
            cacheReadInputTokens: usage.usage.cacheReadInputTokens,
            totalTokens:
              usage.usage.inputTokens +
              usage.usage.outputTokens +
              usage.usage.cacheCreationInputTokens +
              usage.usage.cacheReadInputTokens,
            estimatedCostUsd: usage.estimatedCostUsd,
            latencyMs: usage.latencyMs,
            attempts: usage.attempts,
            success: usage.success,
            ...(usage.errorCode ? { errorCode: usage.errorCode } : {}),
          },
        })
      } catch (usageError) {
        logger.error({
          action: 'chat.send.embedding_usage_failed',
          venueId: input.venueId,
          error: usageError instanceof Error ? usageError.message : 'Unknown error',
        })
      }
    })
      .catch(() => null)
      .finally(() => {
        embeddingMs = elapsedMilliseconds(embeddingStartedAt)
      })

    const operationalNow = new Date()
    const [queryEmbedding, historyDesc, activeUpdates, tenantEngagement, engagementQuestions] =
      await Promise.all([
        queryEmbeddingPromise,
        ctx.db.message.findMany({
          where: { sessionId: session.id, tenantId: venue.tenantId },
          orderBy: { createdAt: 'desc' },
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

    // 4. Retrieve relevant places and knowledge entries.
    //    When an embedding is available both searches run in parallel (same query embedding,
    //    no inter-dependency). Geo-nearest fallback for places when embedding is absent;
    //    knowledge entries fall back to empty (no non-semantic fallback needed).
    const retrievalStartedAt = performance.now()
    let relevantPlaces: Awaited<ReturnType<typeof searchPlacesByEmbedding>>
    let relevantKnowledgeEntries: Awaited<ReturnType<typeof searchKnowledgeByEmbedding>>
    if (queryEmbedding) {
      const [places, knowledge] = await Promise.all([
        searchPlacesByEmbedding({
          queryEmbedding,
          venueId: input.venueId,
          tenantId: venue.tenantId,
          userLat: contextLat,
          userLng: contextLng,
          limit: NEAREST_PLACES_LIMIT,
        }),
        searchKnowledgeByEmbedding({
          queryEmbedding,
          venueId: input.venueId,
          tenantId: venue.tenantId,
          limit: KNOWLEDGE_ENTRIES_LIMIT,
        }).catch(() => []),
      ])
      relevantPlaces = places
      relevantKnowledgeEntries = knowledge
    } else {
      relevantKnowledgeEntries = []
      const fallbackPlaces = await ctx.db.place.findMany({
        where: { venueId: input.venueId, tenantId: venue.tenantId, isActive: true },
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
          importanceScore: true,
        },
        orderBy: { importanceScore: 'desc' },
        take: NEAREST_PLACES_LIMIT,
      })
      relevantPlaces =
        guideMode === 'location_aware' && userLat != null && userLng != null
          ? findNearestPlaces(userLat, userLng, fallbackPlaces, NEAREST_PLACES_LIMIT)
          : fallbackPlaces.map(({ importanceScore, ...place }) => {
              void importanceScore
              return { ...place, distanceMeters: 0 }
            })
    }
    retrievalMs = elapsedMilliseconds(retrievalStartedAt)

    let featuredPlace: {
      name: string
      blurb: string
    } | null = null

    if (venue.aiFeaturedPlaceId) {
      const matchingPlace = relevantPlaces.find((place) => place.id === venue.aiFeaturedPlaceId)
      const featuredPlaceSource =
        matchingPlace ??
        (await ctx.db.place.findFirst({
          where: {
            id: venue.aiFeaturedPlaceId,
            venueId: input.venueId,
            tenantId: venue.tenantId,
            isActive: true,
          },
          select: {
            name: true,
            shortDescription: true,
            longDescription: true,
          },
        }))

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
    const engagementGatePassed = rollEngagementGate(engagementMode)
    const selectedEngagementQuestion = engagementGatePassed
      ? selectAuthoredQuestion(engagementQuestions)
      : null
    // Curious mode invites the AI to invent its own question when the gate
    // passed, regardless of whether an authored one was also offered - it's a
    // fallback the AI uses only if the authored one (or none existing) doesn't
    // fit a natural opening this turn.
    const allowAiInventedQuestion = engagementGatePassed && engagementMode === 'CURIOUS'

    const promptAssemblyStartedAt = performance.now()
    const { staticPart, dynamicPart } = buildVenueSystemPromptParts({
      venue,
      relevantPlaces,
      knowledgeEntries: relevantKnowledgeEntries,
      activeUpdates,
      userLat: contextLat,
      userLng: contextLng,
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
    const modelStartedAt = performance.now()
    try {
      const result = await generateText({
        modelKey: AI_MODEL_KEYS.GUEST_CHAT,
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
        usageSink: async (usage) => {
          try {
            await ctx.db.aiUsageEvent.create({
              data: {
                tenantId: venue.tenantId,
                venueId: input.venueId,
                sessionId: session.id,
                feature: 'guest-chat',
                surface: 'guest-web',
                provider: usage.provider,
                model: usage.model,
                pricingVersion: usage.pricingVersion,
                inputTokens: usage.usage.inputTokens,
                outputTokens: usage.usage.outputTokens,
                cacheCreationInputTokens: usage.usage.cacheCreationInputTokens,
                cacheReadInputTokens: usage.usage.cacheReadInputTokens,
                totalTokens:
                  usage.usage.inputTokens +
                  usage.usage.outputTokens +
                  usage.usage.cacheCreationInputTokens +
                  usage.usage.cacheReadInputTokens,
                estimatedCostUsd: usage.estimatedCostUsd,
                latencyMs: usage.latencyMs,
                attempts: usage.attempts,
                success: usage.success,
                ...(usage.errorCode ? { errorCode: usage.errorCode } : {}),
              },
            })
          } catch (usageError) {
            logger.error({
              action: 'chat.send.ai_usage_failed',
              venueId: input.venueId,
              error: usageError instanceof Error ? usageError.message : 'Unknown error',
            })
          }
        },
      })

      const { cleaned: strippedResponse, markerFound } = stripEngagementMarker(result.text)
      assistantResponse = enforceResponseWordCap(strippedResponse, MAX_RESPONSE_WORDS)
      engagementAskedThisTurn =
        markerFound && (selectedEngagementQuestion !== null || allowAiInventedQuestion)
    } catch (err) {
      fallbackFailureCode = err instanceof AiGatewayError ? err.code : 'unexpected-error'
      logger.error({
        action: 'chat.send.ai_failed',
        venueId: input.venueId,
        error: err instanceof Error ? err.message : 'Unknown error',
      })
      assistantResponse = "I'm having trouble right now. Please try again in a moment."
    } finally {
      modelMs = elapsedMilliseconds(modelStartedAt)
    }

    // 7. Persist messages in two separate statements so they get distinct createdAt
    //    timestamps. A single $transaction gives both rows the same now() value,
    //    making orderBy: { createdAt: 'desc' } non-deterministic on the next request.
    const persistenceStartedAt = performance.now()
    const userMessage = await ctx.db.message.create({
      data: {
        tenantId: venue.tenantId,
        sessionId: session.id,
        role: 'user',
        content: trimmedInput,
      },
      select: { id: true },
    })
    const assistantMessage = await ctx.db.message.create({
      data: {
        tenantId: venue.tenantId,
        sessionId: session.id,
        role: 'assistant',
        content: assistantResponse,
      },
      select: { id: true },
    })
    persistenceMs = elapsedMilliseconds(persistenceStartedAt)

    if (pendingAnswerSnapshot) {
      let questionText: string | null = null
      let answerType: 'OPEN_ENDED' | 'MULTIPLE_CHOICE' = 'OPEN_ENDED'

      if (pendingAnswerSnapshot.pendingEngagementQuestionId) {
        const question = await ctx.db.engagementQuestion.findFirst({
          where: {
            id: pendingAnswerSnapshot.pendingEngagementQuestionId,
            tenantId: venue.tenantId,
          },
          select: { prompt: true, questionType: true },
        })
        questionText = question?.prompt ?? null
        answerType = question?.questionType ?? 'OPEN_ENDED'
      } else if (pendingAnswerSnapshot.pendingEngagementAskedMessageId) {
        const askedMessage = await ctx.db.message.findFirst({
          where: {
            id: pendingAnswerSnapshot.pendingEngagementAskedMessageId,
            tenantId: venue.tenantId,
          },
          select: { content: true },
        })
        questionText = askedMessage?.content ?? null
      }

      if (questionText && pendingAnswerSnapshot.pendingEngagementAskedMessageId) {
        await ctx.db.engagementQuestionResponse.create({
          data: {
            tenantId: venue.tenantId,
            venueId: input.venueId,
            sessionId: session.id,
            engagementQuestionId: pendingAnswerSnapshot.pendingEngagementQuestionId,
            isAiInvented: pendingAnswerSnapshot.pendingEngagementIsInvented,
            answerType,
            questionText,
            askedMessageId: pendingAnswerSnapshot.pendingEngagementAskedMessageId,
            answerMessageId: userMessage.id,
            answerText: trimmedInput,
            askedAt: pendingAnswerSnapshot.pendingEngagementAskedAt ?? new Date(),
            answeredAt: new Date(),
          },
        })
      }

      await ctx.db.visitorSession.updateMany({
        where: { id: session.id, tenantId: venue.tenantId },
        data: {
          pendingEngagementQuestionId: null,
          pendingEngagementIsInvented: false,
          pendingEngagementAskedMessageId: null,
          pendingEngagementAskedAt: null,
        },
      })
    }

    if (engagementAskedThisTurn) {
      await ctx.db.visitorSession.updateMany({
        where: { id: session.id, tenantId: venue.tenantId },
        data: {
          pendingEngagementQuestionId: selectedEngagementQuestion?.id ?? null,
          pendingEngagementIsInvented: allowAiInventedQuestion && !selectedEngagementQuestion,
          pendingEngagementAskedMessageId: assistantMessage.id,
          pendingEngagementAskedAt: new Date(),
        },
      })
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

    if (fallbackFailureCode) {
      try {
        await emitEvent({
          tenantId: venue.tenantId,
          venueId: input.venueId,
          sessionId: input.anonymousToken,
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
        sessionId: input.anonymousToken,
        eventType: 'message.sent',
        metadata: {
          message: trimmedInput,
        },
      })
    } catch {
      // Interaction analytics are best-effort and must not break guest chat.
    }

    try {
      await emitEvent({
        tenantId: venue.tenantId,
        venueId: input.venueId,
        sessionId: input.anonymousToken,
        eventType: 'message.received',
        metadata: {
          responseLength: assistantResponse.length,
          placesReturned: relevantPlaces.length,
          fallback: fallbackFailureCode !== null,
          retrievalMode: queryEmbedding ? 'semantic' : 'geo-or-importance',
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
          sessionId: input.anonymousToken,
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
    const topDistance = queryEmbedding ? (relevantPlaces[0]?.distance ?? null) : null
    const isLowConfidence = queryEmbedding
      ? topDistance === null || topDistance > LOW_CONFIDENCE_DISTANCE_THRESHOLD
      : NO_INFO_REPLY_PATTERN.test(assistantResponse)

    if (isLowConfidence) {
      try {
        await emitEvent({
          tenantId: venue.tenantId,
          venueId: input.venueId,
          sessionId: input.anonymousToken,
          eventType: 'message.low_confidence',
          metadata: {
            question: trimmedInput,
            score: topDistance,
          },
        })
      } catch {
        // Low-confidence analytics are best-effort and must not break guest chat.
      }
    }

    // Filter places to only those Claude actually mentioned in the response.
    // Cap at 3 — more than that in a single turn is visual noise.
    const mentionedPlaces =
      guideMode === 'non_location'
        ? []
        : relevantPlaces
            .filter(
              (p) =>
                p.lat != null &&
                p.lng != null &&
                assistantResponse.toLowerCase().includes(p.name.toLowerCase()),
            )
            .slice(0, 3)

    return {
      response: assistantResponse,
      sessionId: session.id,
      places: mentionedPlaces.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        photoUrl: p.photoUrl ?? null,
        distanceMeters: p.distanceMeters,
        lat: p.lat,
        lng: p.lng,
      })),
    }
  }),

  /**
   * Load the message history for an existing session by anonymous token.
   * Returns messages oldest-first. Returns an empty array if no session exists
   * yet — the chat page treats that as a fresh conversation.
   */
  history: publicProcedure
    .input(
      z
        .object({
          venueId: z.string().min(1),
          anonymousToken: z.string().uuid(),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      // This is a public cross-tenant lookup, so resolve tenant ownership from the
      // venue-scoped session identity. Anonymous tokens are intentionally reusable
      // across venues and must never select a session from another venue.
      const [session] = await ctx.db.$queryRaw<{ id: string; venueId: string; tenantId: string }[]>`
        SELECT id, venue_id AS "venueId", tenant_id AS "tenantId"
        FROM visitor_sessions
        WHERE venue_id = ${input.venueId}
          AND anonymous_token = ${input.anonymousToken}
        LIMIT 1
      `

      // No session yet — fresh visitor, return empty history
      if (!session) {
        return { messages: [] }
      }

      const rows = await ctx.db.message.findMany({
        where: { sessionId: session.id, tenantId: session.tenantId },
        orderBy: { createdAt: 'asc' },
        take: HISTORY_LOAD_LIMIT,
        select: { role: true, content: true },
      })

      return {
        messages: rows.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      }
    }),
})
