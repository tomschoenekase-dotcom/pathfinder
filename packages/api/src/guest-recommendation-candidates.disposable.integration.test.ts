import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it, vi } from 'vitest'

import type { AnthropicMessagesClient } from '@pathfinder/ai'

vi.mock('@pathfinder/config', () => ({
  env: { ANTHROPIC_API_KEY: 'disposable-recommendation-provider-key' },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@pathfinder/analytics', () => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@pathfinder/jobs', () => ({ enqueueEmbedPlace: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./lib/rate-limit', () => ({ checkRateLimit: vi.fn().mockResolvedValue(true) }))
vi.mock('./lib/guest-query-embedding', () => ({
  generateGuestQueryEmbedding: vi.fn(async (...args: unknown[]) => {
    const onBeforeFirstDispatch = args[5] as (() => Promise<void>) | undefined
    await onBeforeFirstDispatch?.()
    return null
  }),
}))

import { db, resolveNativeGuestReadSnapshotAction, withTenantIsolationBypass } from '@pathfinder/db'

import type { TRPCContext } from './context'
import { router } from './core'
import { buildVoiceGroundingContext } from './lib/voice-grounding-context'
import { _setAnthropicClientForTesting, chatRouter } from './routers/chat'

const enabled =
  process.env.RUN_GUEST_RECOMMENDATION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_recommendation_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('guest recommendation candidates disposable integration', () => {
  afterAll(async () => {
    _setAnthropicClientForTesting(null)
    await db.$disconnect()
  })

  it('keeps text and voice recommendation candidates scoped and visit aware', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
      const tenantId = `recommendation-tenant-${suffix}`
      const venueId = `recommendation-venue-${suffix}`
      const siblingVenueId = `recommendation-sibling-${suffix}`
      const visited = Array.from({ length: 8 }, (_, index) => ({
        id: `visited-${index + 1}-${suffix}`,
        name: `Visited Gallery ${index + 1}`,
      }))
      const unvisited = { id: `unvisited-${suffix}`, name: 'Unvisited Gallery' }
      const privatePlace = { id: `private-${suffix}`, name: 'Private Gallery' }
      const siblingPlace = { id: `sibling-${suffix}`, name: 'Sibling Gallery' }
      const placeRows = [
        ...visited.map((place, index) => ({
          ...place,
          tenantId,
          venueId,
          type: 'EXHIBIT' as const,
          visibility: 'PUBLIC' as const,
          isActive: true,
          importanceScore: 100 - index,
          shortDescription: 'A public gallery choice.',
          sourceType: 'FIXTURE',
          sourceName: 'Recommendation fixture',
        })),
        {
          ...unvisited,
          tenantId,
          venueId,
          type: 'EXHIBIT' as const,
          visibility: 'PUBLIC' as const,
          isActive: true,
          importanceScore: 1,
          shortDescription: 'A public gallery choice.',
          sourceType: 'FIXTURE',
          sourceName: 'Recommendation fixture',
        },
        {
          ...privatePlace,
          tenantId,
          venueId,
          type: 'EXHIBIT' as const,
          visibility: 'SECOND_LAYER' as const,
          isActive: true,
          importanceScore: 500,
          shortDescription: 'Private gallery marker.',
        },
        {
          ...siblingPlace,
          tenantId,
          venueId: siblingVenueId,
          type: 'EXHIBIT' as const,
          visibility: 'PUBLIC' as const,
          isActive: true,
          importanceScore: 500,
          shortDescription: 'Sibling gallery marker.',
        },
      ]
      await db.tenant.create({
        data: { id: tenantId, name: 'Recommendation fixture', slug: tenantId },
      })
      await db.venue.createMany({
        data: [venueId, siblingVenueId].map((id) => ({ id, tenantId, name: id, slug: id })),
      })
      await db.place.createMany({ data: placeRows })

      const generation = vi.fn(async () => ({
        content: [
          {
            type: 'text',
            text: `Try ${visited[0]!.name} and ${unvisited.name}.`,
          },
        ],
        usage: {
          input_tokens: 30,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }))
      _setAnthropicClientForTesting({ messages: { create: generation } } as AnthropicMessagesClient)
      const caller = router({ chat: chatRouter }).createCaller({
        db,
        headers: new Headers(),
        session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
      } satisfies TRPCContext)
      const visitContext = { visitedPlaceIds: visited.map(({ id }) => id), interests: ['gallery'] }
      const promptAt = (index: number) => {
        const calls = generation.mock.calls as unknown as Array<
          [{ system: Array<{ text: string }> }]
        >
        const call = calls[index]
        expect(call).toBeDefined()
        return call![0].system.map((block) => block.text).join('')
      }
      const send = (message: string) =>
        caller.chat.send({
          venueId,
          anonymousToken: randomUUID(),
          operationId: randomUUID(),
          message,
          visitContext,
        })

      const recommended = await send('What should I see next?')
      // The injected provider deliberately names a visited place. The runtime cannot
      // police prose, so cards and citations prove the bounded candidate eligibility fence.
      expect(recommended.response).toContain(visited[0]!.name)
      expect(recommended.response).toContain(unvisited.name)
      expect(recommended.places.map(({ id }) => id)).toEqual([unvisited.id])
      expect(recommended.citations.map(({ detail }) => detail)).toEqual([
        `Place: ${unvisited.name}`,
      ])
      expect(JSON.stringify(recommended)).not.toContain(privatePlace.name)
      expect(JSON.stringify(recommended)).not.toContain(siblingPlace.name)
      const recommendationPrompt = promptAt(0)
      expect(recommendationPrompt).toContain(unvisited.name)
      expect(recommendationPrompt).not.toContain(`1. ${visited[0]!.name} (`)
      expect(recommendationPrompt).toContain(
        'Only the supplied MOST RELEVANT PLACES are eligible new place choices',
      )

      const snapshot = await resolveNativeGuestReadSnapshotAction({
        client: db,
        tenantId,
        venueId,
        environment: {},
      })
      const voice = await buildVoiceGroundingContext({
        reader: db as never,
        tenantId,
        venueId,
        query: 'What should I see next?',
        visitContext,
        nativeSnapshot: snapshot,
      })
      expect(voice.context).toContain(`[PLACE: ${unvisited.name}]`)
      expect(voice.sourceIds).toContain(`place:${unvisited.id}`)
      for (const place of visited) {
        expect(voice.context).not.toContain(`[PLACE: ${place.name}]`)
        expect(voice.sourceIds).not.toContain(`place:${place.id}`)
      }
      expect(voice.context).not.toContain(privatePlace.name)
      expect(voice.context).not.toContain(siblingPlace.name)
      expect(voice.nativeProjection.effectiveContentPath).not.toBe('NATIVE')

      const allVisitedContext = {
        visitedPlaceIds: [...visited.map(({ id }) => id), unvisited.id],
        interests: ['gallery'],
      }
      const emptyPool = await caller.chat.send({
        venueId,
        anonymousToken: randomUUID(),
        operationId: randomUUID(),
        message: 'What should I see next?',
        visitContext: allVisitedContext,
      })
      expect(emptyPool.places).toEqual([])
      expect(emptyPool.citations).toEqual([])
      const emptyPoolPrompt = promptAt(1)
      expect(emptyPoolPrompt).toContain(
        'If no eligible place is supplied, say briefly that no new grounded option is available',
      )

      const revisit = await send(`Take me back to ${visited[0]!.name}`)
      expect(revisit.places.map(({ id }) => id)).toContain(visited[0]!.id)
      expect(revisit.citations.map(({ detail }) => detail)).toContain(`Place: ${visited[0]!.name}`)
      const directFact = await buildVoiceGroundingContext({
        reader: db as never,
        tenantId,
        venueId,
        query: `Describe ${visited[0]!.name}`,
        visitContext,
        nativeSnapshot: snapshot,
      })
      expect(directFact.sourceIds).toContain(`place:${visited[0]!.id}`)
    })
  }, 120_000)
})
