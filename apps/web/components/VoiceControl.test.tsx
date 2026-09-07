/* @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  availability: vi.fn(),
  start: vi.fn(),
  connected: vi.fn(),
  transcript: vi.fn(),
  usage: vi.fn(),
  end: vi.fn(),
  getUserMedia: vi.fn(),
}))

vi.mock('../lib/trpc', () => {
  const client = {
    voice: {
      availability: { query: mocks.availability },
      start: { mutate: mocks.start },
      connected: { mutate: mocks.connected },
      transcript: { mutate: mocks.transcript },
      usage: { mutate: mocks.usage },
      end: { mutate: mocks.end },
    },
  }
  return { useTRPCClient: () => client }
})

import {
  MICROPHONE_REQUEST_TIMEOUT_MS,
  REALTIME_SDP_RESPONSE_MAX_BYTES,
  VoiceControl,
  requestRealtimeSdpAnswer,
} from './VoiceControl'

const props = {
  venueId: 'venue-1',
  anonymousToken: '123e4567-e89b-42d3-a456-426614174000',
  language: 'English' as const,
  disabled: false,
}

describe('VoiceControl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: mocks.getUserMedia },
    })
    vi.stubGlobal('RTCPeerConnection', class {})
    vi.stubGlobal('React', React)
  })
  afterEach(() => {
    vi.useRealTimers()
    cleanup()
    vi.unstubAllGlobals()
  })

  it('does not expose a half-working control when voice is unavailable', async () => {
    mocks.availability.mockResolvedValue({ enabled: false, premiumAvailable: false })
    render(<VoiceControl {...props} />)
    await waitFor(() => expect(mocks.availability).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Start voice conversation' })).toBeNull()
  })

  it('handles denied microphone permission without requesting provider authorization', async () => {
    mocks.availability.mockResolvedValue({ enabled: true, premiumAvailable: false })
    mocks.getUserMedia.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'))
    render(<VoiceControl {...props} />)
    const start = await screen.findByRole('button', { name: 'Start voice conversation' })
    fireEvent.click(start)
    expect((await screen.findByRole('alert')).textContent).toContain('Microphone access was denied')
    expect(mocks.start).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: 'Try voice conversation again' }).textContent,
    ).toContain('Try voice again')
  })

  it('retries browser permission after a denied microphone request', async () => {
    mocks.availability.mockResolvedValue({ enabled: true, premiumAvailable: false })
    mocks.getUserMedia.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'))
    render(<VoiceControl {...props} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Start voice conversation' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Try voice conversation again' }))

    await waitFor(() => expect(mocks.getUserMedia).toHaveBeenCalledTimes(2))
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('recovers when the browser microphone request never settles', async () => {
    mocks.availability.mockResolvedValue({ enabled: true, premiumAvailable: false })
    mocks.getUserMedia.mockReturnValue(new Promise(() => undefined))
    render(<VoiceControl {...props} />)

    const start = await screen.findByRole('button', { name: 'Start voice conversation' })
    vi.useFakeTimers()
    fireEvent.click(start)
    expect(screen.getByRole('status').textContent).toContain('Requesting')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MICROPHONE_REQUEST_TIMEOUT_MS)
    })

    expect(screen.getByRole('alert').textContent).toContain('microphone request took too long')
    expect(screen.getByRole('button', { name: 'Try voice conversation again' })).toBeTruthy()
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('stops a microphone stream that arrives after the request timed out', async () => {
    mocks.availability.mockResolvedValue({ enabled: true, premiumAvailable: false })
    let resolveMicrophone!: (stream: MediaStream) => void
    mocks.getUserMedia.mockReturnValue(
      new Promise<MediaStream>((resolve) => {
        resolveMicrophone = resolve
      }),
    )
    const stop = vi.fn()
    const lateStream = { getTracks: () => [{ stop }] } as unknown as MediaStream
    render(<VoiceControl {...props} />)

    const start = await screen.findByRole('button', { name: 'Start voice conversation' })
    vi.useFakeTimers()
    fireEvent.click(start)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MICROPHONE_REQUEST_TIMEOUT_MS)
    })
    await act(async () => {
      resolveMicrophone(lateStream)
      await Promise.resolve()
    })

    expect(stop).toHaveBeenCalledOnce()
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('cancels the active response on barge-in, marks unplayed speech interrupted, and tears down media', async () => {
    mocks.availability.mockResolvedValue({ enabled: true, premiumAvailable: false })
    mocks.start.mockResolvedValue({
      voiceSessionId: '11111111-1111-4111-8111-111111111111',
      clientSecret: 'ephemeral',
      maxDurationSeconds: 600,
    })
    mocks.connected.mockResolvedValue({ connected: true })
    mocks.transcript.mockResolvedValue({ accepted: true })
    mocks.end.mockResolvedValue({ ended: true })
    let onTrackEnded: (() => void) | undefined
    const stop = vi.fn(() => onTrackEnded?.())
    const track = {
      stop,
      addEventListener: vi.fn((type: string, listener: () => void) => {
        if (type === 'ended') onTrackEnded = listener
      }),
    }
    mocks.getUserMedia.mockResolvedValue({ getTracks: () => [track] } as unknown as MediaStream)
    const listeners = new Map<string, (event: MessageEvent<string>) => void>()
    const send = vi.fn()
    const closeChannel = vi.fn()
    const channel = {
      readyState: 'open',
      send,
      close: closeChannel,
      addEventListener: (type: string, listener: (event: MessageEvent<string>) => void) =>
        listeners.set(type, listener),
    }
    const closePeer = vi.fn()
    const peer = {
      addTrack: vi.fn(),
      createDataChannel: () => channel,
      createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'offer-sdp' }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      close: closePeer,
      ontrack: null,
    }
    vi.stubGlobal(
      'RTCPeerConnection',
      vi.fn(() => peer),
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('answer-sdp')))
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)

    render(<VoiceControl {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice conversation' }))
    await waitFor(() => expect(mocks.connected).toHaveBeenCalledOnce())

    const providerEvent = (event: Record<string, unknown>) =>
      listeners.get('message')?.({ data: JSON.stringify(event) } as MessageEvent<string>)
    act(() => {
      providerEvent({
        type: 'response.created',
        event_id: 'created-1',
        response: { id: 'response-1' },
      })
      providerEvent({ type: 'response.output_audio.delta', event_id: 'audio-1' })
      providerEvent({ type: 'input_audio_buffer.speech_started', event_id: 'speech-1' })
      providerEvent({
        type: 'output_audio_buffer.cleared',
        event_id: 'clear-1',
        response_id: 'response-1',
      })
      providerEvent({
        type: 'response.output_audio_transcript.done',
        event_id: 'transcript-1',
        response_id: 'response-1',
        transcript: 'The gallery is on the second floor.',
      })
    })

    expect(send.mock.calls.map(([value]) => JSON.parse(value as string))).toEqual([
      { type: 'response.cancel', response_id: 'response-1' },
      { type: 'output_audio_buffer.clear' },
    ])
    expect(await screen.findByText('(interrupted)')).toBeTruthy()
    expect(mocks.transcript).toHaveBeenCalledWith(
      expect.objectContaining({
        providerEventId: 'transcript-1',
        text: '[Interrupted] The gallery is on the second floor.',
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'End voice conversation' }))
    await waitFor(() => expect(mocks.end).toHaveBeenCalledOnce())
    expect(stop).toHaveBeenCalledOnce()
    expect(closeChannel).toHaveBeenCalledOnce()
    expect(closePeer).toHaveBeenCalledOnce()
  })

  it('finalizes once when microphone end and duplicate peer failures race with cleanup', async () => {
    mocks.availability.mockResolvedValue({ enabled: true, premiumAvailable: false })
    mocks.start.mockResolvedValue({
      voiceSessionId: '11111111-1111-4111-8111-111111111111',
      clientSecret: 'ephemeral',
      maxDurationSeconds: 600,
    })
    mocks.connected.mockResolvedValue({ connected: true })
    mocks.end.mockResolvedValue({ ended: true })
    let onTrackEnded: (() => void) | undefined
    const stop = vi.fn(() => onTrackEnded?.())
    const track = {
      stop,
      addEventListener: vi.fn((type: string, listener: () => void) => {
        if (type === 'ended') onTrackEnded = listener
      }),
    }
    mocks.getUserMedia.mockResolvedValue({ getTracks: () => [track] } as unknown as MediaStream)
    const closeChannel = vi.fn()
    const peer = {
      connectionState: 'new',
      iceConnectionState: 'new',
      onconnectionstatechange: null as (() => void) | null,
      oniceconnectionstatechange: null as (() => void) | null,
      ontrack: null,
      addTrack: vi.fn(),
      createDataChannel: () => ({
        close: closeChannel,
        addEventListener: vi.fn(),
      }),
      createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'offer' }),
      setLocalDescription: vi.fn(),
      setRemoteDescription: vi.fn(),
      close: vi.fn(),
    }
    vi.stubGlobal(
      'RTCPeerConnection',
      vi.fn(() => peer),
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('answer')))

    render(<VoiceControl {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice conversation' }))
    await waitFor(() => expect(mocks.connected).toHaveBeenCalledOnce())

    peer.connectionState = 'failed'
    peer.iceConnectionState = 'failed'
    act(() => {
      onTrackEnded?.()
      peer.onconnectionstatechange?.()
      peer.oniceconnectionstatechange?.()
    })

    await waitFor(() =>
      expect(mocks.end).toHaveBeenCalledWith({
        venueId: props.venueId,
        anonymousToken: props.anonymousToken,
        voiceSessionId: '11111111-1111-4111-8111-111111111111',
        fallbackToText: true,
        errorCode: 'MICROPHONE_ENDED',
      }),
    )
    expect(stop).toHaveBeenCalledOnce()
    expect(closeChannel).toHaveBeenCalledOnce()
    expect(mocks.end).toHaveBeenCalledOnce()
    expect(screen.getByRole('alert').textContent).toContain('microphone stopped')
  })

  it('clears completed generation without cancelling it and never reclassifies an interrupted caption', async () => {
    mocks.availability.mockResolvedValue({ enabled: true, premiumAvailable: false })
    mocks.start.mockResolvedValue({
      voiceSessionId: '11111111-1111-4111-8111-111111111111',
      clientSecret: 'ephemeral',
      maxDurationSeconds: 600,
    })
    mocks.connected.mockResolvedValue({ connected: true })
    mocks.transcript.mockResolvedValue({ accepted: true })
    const listeners = new Map<string, (event: MessageEvent<string>) => void>()
    const send = vi.fn()
    const channel = {
      send,
      close: vi.fn(),
      addEventListener: (type: string, listener: (event: MessageEvent<string>) => void) =>
        listeners.set(type, listener),
    }
    const peer = {
      addTrack: vi.fn(),
      createDataChannel: () => channel,
      createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'offer' }),
      setLocalDescription: vi.fn(),
      setRemoteDescription: vi.fn(),
      close: vi.fn(),
      ontrack: null,
    }
    mocks.getUserMedia.mockResolvedValue({
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream)
    vi.stubGlobal(
      'RTCPeerConnection',
      vi.fn(() => peer),
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('answer')))

    render(<VoiceControl {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice conversation' }))
    await waitFor(() => expect(mocks.connected).toHaveBeenCalledOnce())
    const event = (payload: Record<string, unknown>) =>
      listeners.get('message')?.({ data: JSON.stringify(payload) } as MessageEvent<string>)
    act(() => {
      event({ type: 'response.created', response: { id: 'response-2' } })
      event({ type: 'output_audio_buffer.started', response_id: 'response-2' })
    })
    expect(screen.getByRole('status').textContent).toContain('Speaking')
    act(() => {
      event({ type: 'response.done', response: { id: 'response-2' } })
      event({ type: 'input_audio_buffer.speech_started' })
      event({ type: 'output_audio_buffer.cleared', response_id: 'response-2' })
      event({
        type: 'response.output_audio_transcript.done',
        event_id: 'transcript-2',
        response_id: 'response-2',
        transcript: 'Partly heard.',
      })
      event({ type: 'output_audio_buffer.stopped', response_id: 'response-2' })
      event({
        type: 'response.output_audio_transcript.done',
        event_id: 'transcript-2-duplicate',
        response_id: 'response-2',
        transcript: 'Partly heard.',
      })
    })

    expect(send.mock.calls.map(([value]) => JSON.parse(value as string))).toEqual([
      { type: 'output_audio_buffer.clear' },
    ])
    expect(screen.getAllByText('(interrupted)')).toHaveLength(1)
    expect(mocks.transcript).toHaveBeenCalledTimes(1)
  })
})

describe('requestRealtimeSdpAnswer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns a bounded streamed SDP answer', async () => {
    const answer = await requestRealtimeSdpAnswer({
      offerSdp: 'offer',
      clientSecret: 'secret',
      controller: new AbortController(),
      fetchImpl: vi.fn().mockResolvedValue(new Response('answer-sdp')),
    })

    expect(answer).toBe('answer-sdp')
  })

  it('cancels rejected response bodies without reading provider content', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const response = {
      ok: false,
      status: 503,
      body: { cancel },
    } as unknown as Response

    await expect(
      requestRealtimeSdpAnswer({
        offerSdp: 'offer',
        clientSecret: 'secret',
        controller: new AbortController(),
        fetchImpl: vi.fn().mockResolvedValue(response),
      }),
    ).rejects.toThrow('REALTIME_CONNECT_503')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('cancels streamed SDP answers that exceed the byte ceiling', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const read = vi.fn().mockResolvedValueOnce({
      done: false,
      value: new Uint8Array(REALTIME_SDP_RESPONSE_MAX_BYTES + 1),
    })
    const response = {
      ok: true,
      headers: new Headers(),
      body: { getReader: () => ({ read, cancel }) },
    } as unknown as Response

    await expect(
      requestRealtimeSdpAnswer({
        offerSdp: 'offer',
        clientSecret: 'secret',
        controller: new AbortController(),
        fetchImpl: vi.fn().mockResolvedValue(response),
      }),
    ).rejects.toThrow('REALTIME_SDP_RESPONSE_TOO_LARGE')
    expect(cancel).toHaveBeenCalled()
  })

  it('aborts a realtime request that does not return before its deadline', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        )
      })
    }) as typeof fetch
    const expectation = expect(
      requestRealtimeSdpAnswer({
        offerSdp: 'offer',
        clientSecret: 'secret',
        controller,
        timeoutMs: 25,
        fetchImpl,
      }),
    ).rejects.toThrow('REALTIME_SDP_REQUEST_TIMEOUT')

    await vi.advanceTimersByTimeAsync(25)
    await expectation
    expect(controller.signal.aborted).toBe(true)
  })

  it('cancels a realtime response body that stalls after headers', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let finishRead!: (result: ReadableStreamReadResult<Uint8Array>) => void
    const read = vi.fn(
      () =>
        new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
          finishRead = resolve
        }),
    )
    const cancel = vi.fn().mockImplementation(() => {
      finishRead({ done: true, value: undefined })
      return Promise.resolve()
    })
    const response = {
      ok: true,
      headers: new Headers(),
      body: { getReader: () => ({ read, cancel }) },
    } as unknown as Response
    const expectation = expect(
      requestRealtimeSdpAnswer({
        offerSdp: 'offer',
        clientSecret: 'secret',
        controller,
        timeoutMs: 25,
        fetchImpl: vi.fn().mockResolvedValue(response),
      }),
    ).rejects.toThrow('REALTIME_SDP_REQUEST_TIMEOUT')

    await vi.advanceTimersByTimeAsync(25)
    await expectation
    expect(cancel).toHaveBeenCalled()
  })
})
