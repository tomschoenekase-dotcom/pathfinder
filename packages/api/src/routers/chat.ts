import Anthropic from '@anthropic-ai/sdk'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { emitEvent } from '@pathfinder/analytics'
import { searchPlacesByEmbedding } from '@pathfinder/db'

import { env, logger } from '@pathfinder/config'

import { router } from '../core'
import { generateEmbedding } from '../lib/embeddings'
import { findNearestPlaces } from '../lib/geo'
import { buildVenueSystemPrompt } from '../lib/venue-context'
import { publicProcedure } from '../trpc'

// ---------------------------------------------------------------------------
// Anthropic client — module-level singleton, not re-instantiated per request
// ---------------------------------------------------------------------------

let _anthropic: Anthropic | null = null

function getAnthropicClient(): Anthropic {
  if (!_anthropic) {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not configured')
    }
    _anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  }
  return _anthropic
}

// Exported for test injection — allows tests to replace the singleton
export function _setAnthropicClientForTesting(client: Anthropic | null): void {
  _anthropic = client
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const sessionSchema = z
  .object({
    venueId: z.string().cuid(),
    anonymousToken: z.string().uuid(),
    lat: z.number().optional(),
    lng: z.number().optional(),
  })
  .strict()

const sendMessageSchema = z
  .object({
    venueId: z.string().cuid(),
    anonymousToken: z.string().uuid(),
    message: z.string().min(1).max(1000),
    lat: z.number(),
    lng: z.number(),
  })
  .strict()

const NEAREST_PLACES_LIMIT = 8
const HISTORY_LIMIT = 10
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001'
const MAX_TOKENS = 512

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

    const session = await ctx.db.visitorSession.upsert({
      where: { anonymousToken: input.anonymousToken },
      create: {
        tenantId: venue.tenantId,
        venueId: input.venueId,
        anonymousToken: input.anonymousToken,
        latestLat: input.lat ?? null,
        latestLng: input.lng ?? null,
        lastActiveAt: new Date(),
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
    const sendStartedAt = Date.now()
    // 1. Validate venue
    // $queryRaw used here because this is a public cross-tenant lookup — the caller
    // only knows the venueId, not the tenantId. No tenant_id bind needed in the
    // WHERE because we are resolving the tenant FROM this row, not filtering by it.
    const [venue] = await ctx.db.$queryRaw<{
      id: string
      tenantId: string
      name: string
      description: string | null
      guideNotes: string | null
      category: string | null
    }[]>`
      SELECT id, tenant_id AS "tenantId", name, description, guide_notes AS "guideNotes", category
      FROM venues WHERE id = ${input.venueId} AND is_active = true LIMIT 1
    `

    if (!venue) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
    }

    // 2. Upsert session, update location
    const session = await ctx.db.visitorSession.upsert({
      where: { anonymousToken: input.anonymousToken },
      create: {
        tenantId: venue.tenantId,
        venueId: input.venueId,
        anonymousToken: input.anonymousToken,
        latestLat: input.lat,
        latestLng: input.lng,
        lastActiveAt: new Date(),
      },
      update: {
        latestLat: input.lat,
        latestLng: input.lng,
        lastActiveAt: new Date(),
      },
      select: { id: true },
    })

    // 3. Embed the user query and load history in parallel.
    //    Embedding may fail (e.g. no OPENAI_API_KEY) — null triggers geo fallback.
    const [queryEmbedding, historyDesc] = await Promise.all([
      generateEmbedding(input.message).catch(() => null),
      ctx.db.message.findMany({
        where: { sessionId: session.id, tenantId: venue.tenantId },
        orderBy: { createdAt: 'desc' },
        take: HISTORY_LIMIT,
        select: { role: true, content: true },
      }),
    ])

    const isFirstMessage = historyDesc.length === 0

    try {
      await emitEvent({
        tenantId: venue.tenantId,
        venueId: input.venueId,
        sessionId: input.anonymousToken,
        eventType: 'message.sent',
        metadata: {
          isFirstMessage,
          messageLength: input.message.length,
        },
      })
    } catch {}

    // 4. Retrieve relevant places.
    //    Semantic search when embeddings are available; geo-nearest fallback otherwise.
    let relevantPlaces: Awaited<ReturnType<typeof searchPlacesByEmbedding>>
    if (queryEmbedding) {
      relevantPlaces = await searchPlacesByEmbedding({
        queryEmbedding,
        venueId: input.venueId,
        tenantId: venue.tenantId,
        userLat: input.lat,
        userLng: input.lng,
        limit: NEAREST_PLACES_LIMIT,
      })
    } else {
      // Fallback: load all active places and pick the nearest by distance
      const allPlaces = await ctx.db.place.findMany({
        where: { venueId: input.venueId, tenantId: venue.tenantId, isActive: true },
        select: {
          id: true,
          name: true,
          type: true,
          shortDescription: true,
          longDescription: true,
          lat: true,
          lng: true,
          tags: true,
          areaName: true,
          hours: true,
          photoUrl: true,
        },
      })
      relevantPlaces = findNearestPlaces(input.lat, input.lng, allPlaces, NEAREST_PLACES_LIMIT)
    }

    // 5. Build context — history arrives newest-first, reverse to oldest-first for Claude
    const systemPrompt = buildVenueSystemPrompt({
      venue,
      relevantPlaces,
      userLat: input.lat,
      userLng: input.lng,
    })
    const history = historyDesc.reverse()

    // 6. Call Claude API — failure returns graceful fallback, never throws to caller
    let assistantResponse: string
    try {
      const anthropic = getAnthropicClient()
      const result = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [
          ...history.map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          })),
          { role: 'user', content: input.message },
        ],
      })

      assistantResponse =
        result.content[0]?.type === 'text'
          ? result.content[0].text
          : "I'm sorry, I couldn't generate a response."
    } catch (err) {
      logger.error({
        action: 'chat.send.claude_failed',
        venueId: input.venueId,
        error: err instanceof Error ? err.message : 'Unknown error',
      })
      assistantResponse = "I'm having trouble right now. Please try again in a moment."
    }

    // 7. Persist both messages in a transaction
    await ctx.db.$transaction([
      ctx.db.message.create({
        data: {
          tenantId: venue.tenantId,
          sessionId: session.id,
          role: 'user',
          content: input.message,
        },
      }),
      ctx.db.message.create({
        data: {
          tenantId: venue.tenantId,
          sessionId: session.id,
          role: 'assistant',
          content: assistantResponse,
        },
      }),
    ])

    try {
      await emitEvent({
        tenantId: venue.tenantId,
        venueId: input.venueId,
        sessionId: input.anonymousToken,
        eventType: 'message.received',
        metadata: {
          placeIdsReturned: relevantPlaces.map((place) => place.id),
          responseMs: Date.now() - sendStartedAt,
        },
      })
    } catch {}

    return {
      response: assistantResponse,
      sessionId: session.id,
      places: relevantPlaces.map((p) => ({
        id: p.id,
        name: p.name,
        photoUrl: p.photoUrl ?? null,
        distanceMeters: p.distanceMeters,
        lat: p.lat,
        lng: p.lng,
      })),
    }
  }),
})
