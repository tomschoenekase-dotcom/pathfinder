import { describe, expect, it, vi } from 'vitest'

import {
  estimateRealtimeVoiceCostUsd,
  openAiRealtimeVoiceAdapter,
  resolveRealtimeVoiceRoute,
} from './realtime-voice'

describe('realtime voice routing and authorization', () => {
  it('requires entitlement for premium and permits the economy route', () => {
    expect(resolveRealtimeVoiceRoute({ tier: 'ECONOMY' })).toMatchObject({
      capability: 'REALTIME_VOICE_ECONOMY',
      model: 'gpt-realtime-2.1-mini',
    })
    expect(() => resolveRealtimeVoiceRoute({ tier: 'PREMIUM' })).toThrow(
      'Premium realtime voice is not entitled',
    )
  })

  it('creates an ephemeral client secret server-side without sending the standard key in the body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          value: 'ek_ephemeral_only',
          expires_at: 1_787_000_000,
          session: { id: 'sess_provider' },
        }),
      ),
    )
    const result = await openAiRealtimeVoiceAdapter.authorizeSession({
      route: resolveRealtimeVoiceRoute({ tier: 'ECONOMY' }),
      apiKey: 'server-test-key',
      safetyIdentifier: 'a'.repeat(64),
      instructions: 'Use only trusted venue context.',
      voice: 'marin',
      language: 'en',
      fetchImpl,
    })

    expect(result).toMatchObject({
      clientSecret: 'ek_ephemeral_only',
      providerSessionId: 'sess_provider',
    })
    const [, request] = fetchImpl.mock.calls[0]!
    expect(request.headers.Authorization).toBe('Bearer server-test-key')
    expect(request.headers['OpenAI-Safety-Identifier']).toBe('a'.repeat(64))
    expect(request.body).not.toContain('server-test-key')
    expect(request.body).toContain('gpt-live-transcribe')
  })

  it('cancels a rejected authorization response without reading provider content', async () => {
    let canceled = false
    const body = new ReadableStream({
      cancel() {
        canceled = true
      },
    })

    await expect(
      openAiRealtimeVoiceAdapter.authorizeSession({
        route: resolveRealtimeVoiceRoute({ tier: 'ECONOMY' }),
        apiKey: 'server-test-key',
        safetyIdentifier: 'a'.repeat(64),
        instructions: 'Use only trusted venue context.',
        voice: 'marin',
        fetchImpl: vi.fn().mockResolvedValue(new Response(body, { status: 503 })),
      }),
    ).rejects.toThrow('Realtime voice authorization failed (503)')
    expect(canceled).toBe(true)
  })

  it('bounds and cancels a stalled authorization response body', async () => {
    let canceled = false
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'))
      },
      cancel() {
        canceled = true
      },
    })

    await expect(
      openAiRealtimeVoiceAdapter.authorizeSession({
        route: resolveRealtimeVoiceRoute({ tier: 'ECONOMY' }),
        apiKey: 'server-test-key',
        safetyIdentifier: 'a'.repeat(64),
        instructions: 'Use only trusted venue context.',
        voice: 'marin',
        fetchImpl: vi.fn().mockResolvedValue(new Response(body)),
        requestTimeoutMs: 10,
      }),
    ).rejects.toThrow('Realtime voice authorization timed out')
    expect(canceled).toBe(true)
  })

  it('estimates versioned text and audio token cost only for known models', () => {
    expect(
      estimateRealtimeVoiceCostUsd('gpt-realtime-2.1-mini', {
        inputTokens: 1_100,
        outputTokens: 2_100,
        cachedInputTokens: 100,
        cachedAudioInputTokens: 0,
        audioInputTokens: 1_000,
        audioOutputTokens: 2_000,
      }),
    ).toBeCloseTo(0.050246, 8)
    expect(
      estimateRealtimeVoiceCostUsd('future-model', {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cachedAudioInputTokens: 0,
        audioInputTokens: 0,
        audioOutputTokens: 0,
      }),
    ).toBeNull()
  })
})
