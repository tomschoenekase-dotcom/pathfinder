import { describe, expect, it, vi } from 'vitest'

import {
  estimateRealtimeVoiceCostUsd,
  exchangeRealtimeVoiceSdp,
  hangupOpenAiRealtimeCall,
  openAiRealtimeVoiceAdapter,
  resolveRealtimeVoiceRoute,
} from './realtime-voice'

describe('realtime voice routing and authorization', () => {
  it('exchanges SDP on the server and retains the provider call ID for a hard deadline', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('v=0\r\nanswer', {
        headers: { Location: '/v1/realtime/calls/rtc_local_test' },
      }),
    )
    await expect(
      exchangeRealtimeVoiceSdp({
        clientSecret: 'ephemeral-test-only',
        sdpOffer: 'v=0\r\noffer',
        fetchImpl,
      }),
    ).resolves.toEqual({ sdpAnswer: 'v=0\r\nanswer', callId: 'rtc_local_test' })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.openai.com/v1/realtime/calls',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer ephemeral-test-only',
          'Content-Type': 'application/sdp',
        },
      }),
    )
  })

  it('rejects an oversized streaming SDP answer before retaining it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(65 * 1024))
            controller.close()
          },
        }),
        { headers: { Location: '/v1/realtime/calls/rtc_local_test' } },
      ),
    )
    await expect(
      exchangeRealtimeVoiceSdp({
        clientSecret: 'ephemeral-test-only',
        sdpOffer: 'v=0\r\noffer',
        fetchImpl,
      }),
    ).rejects.toThrow('too large')
  })

  it('hangs up only validated WebRTC call IDs with a server credential', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    await hangupOpenAiRealtimeCall({
      apiKey: 'server-test-only',
      callId: 'rtc_local_test',
      fetchImpl,
    })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.openai.com/v1/realtime/calls/rtc_local_test/hangup',
    )
    await expect(
      hangupOpenAiRealtimeCall({
        apiKey: 'server-test-only',
        callId: '../other',
        fetchImpl,
      }),
    ).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('requires voice entitlement and defaults entitled venues to economy', () => {
    expect(resolveRealtimeVoiceRoute({ voiceEntitled: true })).toMatchObject({
      capability: 'REALTIME_VOICE_ECONOMY',
      model: 'gpt-realtime-2.1-mini',
    })
    expect(() => resolveRealtimeVoiceRoute({ voiceEntitled: false, tier: 'ECONOMY' })).toThrow(
      'Realtime voice is not entitled',
    )
  })

  it('allows premium only through trusted server tier configuration', () => {
    expect(
      resolveRealtimeVoiceRoute({
        voiceEntitled: true,
        environment: { OPENAI_REALTIME_VOICE_TIER: 'PREMIUM' },
      }),
    ).toMatchObject({ capability: 'REALTIME_VOICE', tier: 'PREMIUM', model: 'gpt-realtime-2.1' })
    expect(resolveRealtimeVoiceRoute({ voiceEntitled: true, tier: 'PREMIUM' })).toMatchObject({
      capability: 'REALTIME_VOICE',
      tier: 'PREMIUM',
      model: 'gpt-realtime-2.1',
    })
    expect(
      resolveRealtimeVoiceRoute({
        voiceEntitled: true,
        tier: 'PREMIUM',
        environment: { OPENAI_REALTIME_PREMIUM_MODEL: 'gpt-realtime-2.1-custom' },
      }),
    ).toMatchObject({ tier: 'PREMIUM', model: 'gpt-realtime-2.1-custom' })
    expect(() =>
      resolveRealtimeVoiceRoute({
        voiceEntitled: true,
        environment: { OPENAI_REALTIME_VOICE_TIER: 'UNTRUSTED' },
      }),
    ).toThrow()
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
      route: resolveRealtimeVoiceRoute({ voiceEntitled: true }),
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
        route: resolveRealtimeVoiceRoute({ voiceEntitled: true }),
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
        route: resolveRealtimeVoiceRoute({ voiceEntitled: true }),
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
