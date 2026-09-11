import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it, vi } from 'vitest'

import type { AnthropicMessagesClient } from '@pathfinder/ai'

vi.mock('@pathfinder/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pathfinder/config')>()
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }
})
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

const webFixture = vi.hoisted(() => ({
  calls: [] as unknown[],
  responses: [] as unknown[],
}))
vi.mock('@pathfinder/ai/guest-web-search-accounting', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pathfinder/ai/guest-web-search-accounting')>()
  return {
    ...actual,
    searchGuestWebWithAccounting: (
      params: Parameters<typeof actual.searchGuestWebWithAccounting>[0],
    ) =>
      actual.searchGuestWebWithAccounting({
        ...params,
        request: {
          ...params.request,
          client: {
            responses: {
              create: vi.fn(async (request: unknown) => {
                webFixture.calls.push(request)
                const response = webFixture.responses.shift()
                if (!response) throw new Error('Missing injected web response')
                return response
              }),
            },
          },
        },
      }),
  }
})

import { AI_COST_BUDGET_COVERAGE_VERSION, db, withTenantIsolationBypass } from '@pathfinder/db'

import type { TRPCContext } from './context'
import { router } from './core'
import { _setAnthropicClientForTesting, chatRouter } from './routers/chat'

function isExplicitDisposableDatabase(): boolean {
  if (
    process.env.RUN_GUEST_GENERAL_WEB_DB_INTEGRATION !== '1' ||
    process.env.PATHFINDER_DISPOSABLE_GUEST_GENERAL_WEB_CONFIRMATION !==
      'pathfinder_disposable_guest_general_web'
  )
    return false
  try {
    const databaseUrl = new URL(process.env.DATABASE_URL ?? '')
    const directUrl = new URL(process.env.DIRECT_DATABASE_URL ?? '')
    const database = decodeURIComponent(databaseUrl.pathname.slice(1))
    return (
      ['postgres:', 'postgresql:'].includes(databaseUrl.protocol) &&
      ['127.0.0.1', '::1', 'localhost'].includes(databaseUrl.hostname) &&
      databaseUrl.port.length > 0 &&
      directUrl.toString() === databaseUrl.toString() &&
      /^pathfinder_disposable_guest_general_web_[a-f0-9]{12}$/u.test(database)
    )
  } catch {
    return false
  }
}

function webResponse(id: string, url: string, usage = { input: 100, cached: 20, output: 30 }) {
  const text = 'Saturn has a prominent ring system.'
  return {
    id,
    model: 'gpt-5-mini-2025-08-07',
    status: 'completed',
    usage: {
      input_tokens: usage.input,
      input_tokens_details: { cached_tokens: usage.cached },
      output_tokens: usage.output,
      total_tokens: usage.input + usage.output,
    },
    output: [
      {
        type: 'web_search_call',
        status: 'completed',
        action: { type: 'search', sources: [{ type: 'url', title: 'Saturn overview', url }] },
      },
      {
        type: 'message',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text,
            annotations: [
              { type: 'url_citation', title: 'Saturn overview', url, start_index: 0, end_index: 6 },
            ],
          },
        ],
      },
    ],
  }
}

const integrationDescribe = isExplicitDisposableDatabase() ? describe : describe.skip

integrationDescribe('guest general web disposable integration', () => {
  afterAll(async () => {
    _setAnthropicClientForTesting(null)
    await db.$disconnect()
  }, 30_000)

  it('accounts, persists, replays, revokes, and observes a known-usage failure', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `general-web-tenant-${suffix}`
      const venueId = `general-web-venue-${suffix}`
      await db.tenant.create({
        data: { id: tenantId, name: 'General web fixture', slug: tenantId },
      })
      await db.venue.create({
        data: {
          id: venueId,
          tenantId,
          name: 'General web venue',
          slug: venueId,
          chatShowLinks: true,
        },
      })
      await db.aiCostBudget.create({
        data: {
          tenantId,
          coverageVersion: AI_COST_BUDGET_COVERAGE_VERSION,
          enabled: true,
          startsAt: new Date(Date.now() - 60_000),
          endsAt: new Date(Date.now() + 3_600_000),
          limitUnits: 1_000_000_000n,
          remainingUnits: 1_000_000_000n,
          updatedBy: 'disposable-integration',
          reason: 'Disposable guest general web proof',
        },
      })
      const flag = await db.tenantFeatureFlag.create({
        data: {
          tenantId,
          flagKey: 'guest-general-web-fallback-v1',
          enabled: true,
          setBy: 'disposable-integration',
          metadata: {
            venueIds: [venueId],
            allowedDomains: ['nasa.gov'],
            modelKey: 'guest-chat-openai',
            maxOutputTokens: 128,
            timeoutMs: 5_000,
            requestBudgetCeilingE8Usd: '20000000',
          },
        },
      })

      const generation = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Saturn is a gas giant with a visible ring system.' }],
        usage: {
          input_tokens: 50,
          output_tokens: 12,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      })
      _setAnthropicClientForTesting({ messages: { create: generation } } as AnthropicMessagesClient)
      const caller = router({ chat: chatRouter }).createCaller({
        db,
        headers: new Headers(),
        session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
      } satisfies TRPCContext)
      const anonymousToken = randomUUID()
      const send = (operationId: string) =>
        caller.chat.send({
          venueId,
          anonymousToken,
          operationId,
          message: 'Why does Saturn have rings?',
        })

      webFixture.responses.push(webResponse('resp-success', 'https://science.nasa.gov/saturn/'))
      const firstOperationId = randomUUID()
      const first = await send(firstOperationId)
      expect(first.replayed).toBe(false)
      expect(first.citations).toEqual([
        expect.objectContaining({
          href: 'https://science.nasa.gov/saturn/',
          detail: 'General background',
        }),
      ])
      expect(webFixture.calls).toHaveLength(1)
      expect(generation).toHaveBeenCalledTimes(1)

      const successfulUsage = await db.aiUsageEvent.findFirstOrThrow({
        where: { tenantId, capability: 'GENERAL_WEB_SEARCH', success: true },
      })
      expect(successfulUsage).toMatchObject({
        provider: 'openai',
        model: 'gpt-5-mini-2025-08-07',
        pricingVersion: 'openai-web-search-2026-09-08',
        usageObservationStatus: 'OBSERVED',
        inputTokens: 80,
        cacheReadInputTokens: 20,
        outputTokens: 30,
        totalTokens: 130,
      })
      expect(successfulUsage.estimatedCostUsd.toFixed(8)).toBe('0.01008050')
      const successfulReservation = await db.aiCostReservation.findFirstOrThrow({
        where: { tenantId, provider: 'openai', pricingVersion: 'openai-web-search-2026-09-08' },
      })
      expect(successfulReservation).toMatchObject({
        status: 'SETTLED',
        settlementKind: 'EXACT',
        settledUnits: 1_008_050n,
      })

      const turn = await db.guestChatTurn.findFirstOrThrow({
        where: { tenantId, requestId: firstOperationId },
      })
      expect(turn.replayMetadata).toEqual(
        expect.objectContaining({
          citations: expect.arrayContaining([
            expect.objectContaining({ href: 'https://science.nasa.gov/saturn/' }),
          ]),
          answerEvidence: expect.objectContaining({
            sources: expect.arrayContaining([
              expect.objectContaining({ kind: 'GENERAL_WEB_REFERENCE' }),
            ]),
          }),
        }),
      )

      const reservationCount = await db.aiCostReservation.count({ where: { tenantId } })
      const usageCount = await db.aiUsageEvent.count({ where: { tenantId } })
      const replay = await send(firstOperationId)
      expect(replay).toMatchObject({ replayed: true, response: first.response })
      expect(webFixture.calls).toHaveLength(1)
      expect(generation).toHaveBeenCalledTimes(1)
      expect(await db.aiCostReservation.count({ where: { tenantId } })).toBe(reservationCount)
      expect(await db.aiUsageEvent.count({ where: { tenantId } })).toBe(usageCount)

      await db.tenantFeatureFlag.update({ where: { id: flag.id }, data: { enabled: false } })
      await send(randomUUID())
      expect(webFixture.calls).toHaveLength(1)
      expect(generation).toHaveBeenCalledTimes(2)

      await db.tenantFeatureFlag.update({ where: { id: flag.id }, data: { enabled: true } })
      webFixture.responses.push(
        webResponse('resp-unsafe', 'https://science.nasa.gov/saturn/?access_token=secret', {
          input: 60,
          cached: 10,
          output: 8,
        }),
      )
      const failureAnswer = await send(randomUUID())
      expect(failureAnswer.response).toContain('Saturn')
      expect(failureAnswer.citations).toEqual([])
      expect(generation).toHaveBeenCalledTimes(3)
      expect(webFixture.calls).toHaveLength(2)

      const failedUsage = await db.aiUsageEvent.findFirstOrThrow({
        where: { tenantId, capability: 'GENERAL_WEB_SEARCH', success: false },
      })
      expect(failedUsage).toMatchObject({
        usageObservationStatus: 'OBSERVED',
        inputTokens: 50,
        cacheReadInputTokens: 10,
        outputTokens: 8,
        totalTokens: 68,
        errorCode: 'invalid-provider-response',
      })
      expect(failedUsage.estimatedCostUsd.toFixed(8)).toBe('0.01002875')
      const failedReservation = await db.aiCostReservation.findFirstOrThrow({
        where: {
          tenantId,
          provider: 'openai',
          pricingVersion: 'openai-web-search-2026-09-08',
          id: { not: successfulReservation.id },
        },
      })
      expect(failedReservation).toMatchObject({
        status: 'SETTLED',
        settlementKind: 'EXACT',
        settledUnits: 1_002_875n,
      })
    })
  }, 90_000)
})
