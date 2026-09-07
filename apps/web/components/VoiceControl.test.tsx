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
  groundingContext: vi.fn(),
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
      groundingContext: { mutate: mocks.groundingContext },
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
    mocks.groundingContext.mockResolvedValue({
      context: '[Bathrooms]\nBeside the east lift.',
      sourceIds: ['bathroom'],
    })
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    cleanup()
    vi.restoreAllMocks()
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

  it('serializes rapid starts and stops media acquired after the component leaves its scope', async () => {
    mocks.availability.mockResolvedValue({ enabled: true, premiumAvailable: false })
    let resolveMicrophone!: (stream: MediaStream) => void
    mocks.getUserMedia.mockReturnValue(
      new Promise<MediaStream>((resolve) => {
        resolveMicrophone = resolve
      }),
    )
    const stop = vi.fn()
    const view = render(<VoiceControl {...props} />)
    const start = await screen.findByRole('button', { name: 'Start voice conversation' })

    act(() => {
      start.click()
      start.click()
    })
    expect(mocks.getUserMedia).toHaveBeenCalledOnce()

    view.unmount()
    await act(async () => {
      resolveMicrophone({ getTracks: () => [{ stop }] } as unknown as MediaStream)
      await Promise.resolve()
    })
    expect(stop).toHaveBeenCalledOnce()
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('keeps an A to B to A restart active when the first authorization resolves late', async () => {
    mocks.availability.mockResolvedValue({ enabled: true, premiumAvailable: false })
    mocks.connected.mockResolvedValue({ connected: true })
    mocks.end.mockResolvedValue({ ended: true })
    let resolveOldAuthorization!: (value: {
      voiceSessionId: string
      clientSecret: string
      maxDurationSeconds: number
    }) => void
    let resolveCurrentAuthorization!: (value: {
      voiceSessionId: string
      clientSecret: string
      maxDurationSeconds: number
    }) => void
    mocks.start
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOldAuthorization = resolve
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveCurrentAuthorization = resolve
        }),
      )
    const oldStop = vi.fn()
    const currentStop = vi.fn()
    mocks.getUserMedia
      .mockResolvedValueOnce({ getTracks: () => [{ stop: oldStop }] } as unknown as MediaStream)
      .mockResolvedValueOnce({ getTracks: () => [{ stop: currentStop }] } as unknown as MediaStream)
    const channel = { close: vi.fn(), addEventListener: vi.fn() }
    const peer = {
      addTrack: vi.fn(),
      createDataChannel: () => channel,
      createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'offer' }),
      setLocalDescription: vi.fn(),
      setRemoteDescription: vi.fn(),
      close: vi.fn(),
      ontrack: null,
    }
    vi.stubGlobal(
      'RTCPeerConnection',
      vi.fn(() => peer),
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('answer')))
    const view = render(<VoiceControl {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice conversation' }))
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1))

    view.rerender(
      <VoiceControl
        {...props}
        venueId="venue-2"
        anonymousToken="223e4567-e89b-42d3-a456-426614174001"
      />,
    )
    await waitFor(() => expect(mocks.availability).toHaveBeenCalledTimes(2))
    view.rerender(<VoiceControl {...props} />)
    await waitFor(() => expect(mocks.availability).toHaveBeenCalledTimes(3))
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice conversation' }))
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2))

    await act(async () => {
      resolveOldAuthorization({
        voiceSessionId: '11111111-1111-4111-8111-111111111111',
        clientSecret: 'retired-ephemeral',
        maxDurationSeconds: 600,
      })
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(mocks.end).toHaveBeenCalledWith({
        venueId: props.venueId,
        anonymousToken: props.anonymousToken,
        voiceSessionId: '11111111-1111-4111-8111-111111111111',
        fallbackToText: true,
        errorCode: 'CLIENT_UNMOUNTED',
      }),
    )
    expect(mocks.end).toHaveBeenCalledOnce()
    expect(oldStop).toHaveBeenCalled()
    expect(currentStop).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toContain('Connecting')

    await act(async () => {
      resolveCurrentAuthorization({
        voiceSessionId: '22222222-2222-4222-8222-222222222222',
        clientSecret: 'current-ephemeral',
        maxDurationSeconds: 600,
      })
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(mocks.connected).toHaveBeenCalledWith({
        venueId: props.venueId,
        anonymousToken: props.anonymousToken,
        voiceSessionId: '22222222-2222-4222-8222-222222222222',
      }),
    )
    expect(screen.getByRole('button', { name: 'End voice conversation' })).toBeTruthy()
  })

  it('does not reset an active session when the parent replaces its character callback', async () => {
    mocks.availability.mockResolvedValue({ enabled: true, premiumAvailable: false })
    mocks.start.mockResolvedValue({
      voiceSessionId: '11111111-1111-4111-8111-111111111111',
      clientSecret: 'ephemeral',
      maxDurationSeconds: 600,
    })
    mocks.connected.mockResolvedValue({ connected: true })
    mocks.getUserMedia.mockResolvedValue({
      getTracks: () => [{ stop: vi.fn(), addEventListener: vi.fn() }],
    } as unknown as MediaStream)
    const listeners = new Map<string, () => void>()
    const channel = {
      close: vi.fn(),
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    }
    vi.stubGlobal(
      'RTCPeerConnection',
      vi.fn(() => ({
        addTrack: vi.fn(),
        createDataChannel: () => channel,
        createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'offer' }),
        setLocalDescription: vi.fn(),
        setRemoteDescription: vi.fn(),
        close: vi.fn(),
        ontrack: null,
      })),
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('answer')))
    const firstCharacterCallback = vi.fn()
    const secondCharacterCallback = vi.fn()
    const view = render(<VoiceControl {...props} onCharacterState={firstCharacterCallback} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Start voice conversation' }))
    await waitFor(() => expect(mocks.connected).toHaveBeenCalledOnce())
    act(() => listeners.get('open')?.())
    expect(screen.getByRole('status').textContent).toContain('Listening')

    view.rerender(<VoiceControl {...props} onCharacterState={secondCharacterCallback} />)

    expect(mocks.availability).toHaveBeenCalledOnce()
    expect(screen.getByRole('status').textContent).toContain('Listening')
    expect(screen.getByRole('button', { name: 'End voice conversation' })).toBeTruthy()
  })

  it('allows a restart while the previous remote end acknowledgement is delayed', async () => {
    mocks.availability.mockResolvedValue({ enabled: true, premiumAvailable: false })
    mocks.start
      .mockResolvedValueOnce({
        voiceSessionId: '11111111-1111-4111-8111-111111111111',
        clientSecret: 'first-ephemeral',
        maxDurationSeconds: 600,
      })
      .mockResolvedValueOnce({
        voiceSessionId: '22222222-2222-4222-8222-222222222222',
        clientSecret: 'second-ephemeral',
        maxDurationSeconds: 600,
      })
    mocks.connected.mockResolvedValue({ connected: true })
    let resolveOldEnd!: (value: { ended: boolean }) => void
    mocks.end.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOldEnd = resolve
      }),
    )
    const oldStop = vi.fn()
    const currentStop = vi.fn()
    mocks.getUserMedia
      .mockResolvedValueOnce({
        getTracks: () => [{ stop: oldStop, addEventListener: vi.fn() }],
      } as unknown as MediaStream)
      .mockResolvedValueOnce({
        getTracks: () => [{ stop: currentStop, addEventListener: vi.fn() }],
      } as unknown as MediaStream)
    const channelListeners: Array<Map<string, () => void>> = []
    const channels = Array.from({ length: 2 }, () => {
      const listeners = new Map<string, () => void>()
      channelListeners.push(listeners)
      return {
        close: vi.fn(),
        addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      }
    })
    let peerIndex = 0
    vi.stubGlobal(
      'RTCPeerConnection',
      vi.fn(() => ({
        addTrack: vi.fn(),
        createDataChannel: () => channels[peerIndex++]!,
        createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'offer' }),
        setLocalDescription: vi.fn(),
        setRemoteDescription: vi.fn(),
        close: vi.fn(),
        ontrack: null,
      })),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(new Response('answer'))),
    )

    render(<VoiceControl {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice conversation' }))
    await waitFor(() => expect(mocks.connected).toHaveBeenCalledTimes(1))
    act(() => channelListeners[0]!.get('open')?.())

    fireEvent.click(screen.getByRole('button', { name: 'End voice conversation' }))
    const restart = await screen.findByRole('button', { name: 'Start voice conversation' })
    expect(oldStop).toHaveBeenCalledOnce()
    expect(mocks.end).toHaveBeenCalledWith({
      venueId: props.venueId,
      anonymousToken: props.anonymousToken,
      voiceSessionId: '11111111-1111-4111-8111-111111111111',
      fallbackToText: false,
    })

    fireEvent.click(restart)
    await waitFor(() => expect(mocks.connected).toHaveBeenCalledTimes(2))
    act(() => channelListeners[1]!.get('open')?.())
    await act(async () => {
      resolveOldEnd({ ended: true })
      await Promise.resolve()
    })

    expect(currentStop).not.toHaveBeenCalled()
    expect(mocks.end).toHaveBeenCalledOnce()
    expect(screen.getByRole('status').textContent).toContain('Listening')
    expect(screen.getByRole('button', { name: 'End voice conversation' })).toBeTruthy()
  })

  it('ignores delayed events from a retired data channel after voice restarts', async () => {
    mocks.availability.mockResolvedValue({ enabled: true, premiumAvailable: false })
    mocks.start
      .mockResolvedValueOnce({
        voiceSessionId: '11111111-1111-4111-8111-111111111111',
        clientSecret: 'first-ephemeral',
        maxDurationSeconds: 600,
      })
      .mockResolvedValueOnce({
        voiceSessionId: '22222222-2222-4222-8222-222222222222',
        clientSecret: 'second-ephemeral',
        maxDurationSeconds: 600,
      })
    mocks.connected.mockResolvedValue({ connected: true })
    mocks.end.mockResolvedValue({ ended: true })
    mocks.transcript.mockResolvedValue({ accepted: true })
    mocks.getUserMedia.mockResolvedValue({
      getTracks: () => [{ stop: vi.fn(), addEventListener: vi.fn() }],
    } as unknown as MediaStream)
    const channelListeners: Array<Map<string, (event?: MessageEvent<string>) => void>> = []
    const channels = Array.from({ length: 2 }, () => {
      const listeners = new Map<string, (event?: MessageEvent<string>) => void>()
      channelListeners.push(listeners)
      return {
        close: vi.fn(),
        addEventListener: (type: string, listener: (event?: MessageEvent<string>) => void) =>
          listeners.set(type, listener),
      }
    })
    let peerIndex = 0
    vi.stubGlobal(
      'RTCPeerConnection',
      vi.fn(() => ({
        addTrack: vi.fn(),
        createDataChannel: () => channels[peerIndex++]!,
        createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'offer' }),
        setLocalDescription: vi.fn(),
        setRemoteDescription: vi.fn(),
        close: vi.fn(),
        ontrack: null,
      })),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(new Response('answer'))),
    )

    render(<VoiceControl {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice conversation' }))
    await waitFor(() => expect(mocks.connected).toHaveBeenCalledTimes(1))
    act(() => channelListeners[0]!.get('open')?.())
    fireEvent.click(screen.getByRole('button', { name: 'End voice conversation' }))
    await waitFor(() => expect(mocks.end).toHaveBeenCalledOnce())
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice conversation' }))
    await waitFor(() => expect(mocks.connected).toHaveBeenCalledTimes(2))
    act(() => channelListeners[1]!.get('open')?.())

    act(() => {
      channelListeners[0]!.get('open')?.()
      channelListeners[0]!.get('message')?.({
        data: JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          event_id: 'retired-event',
          transcript: 'A retired turn.',
        }),
      } as MessageEvent<string>)
      channelListeners[0]!.get('message')?.({
        data: JSON.stringify({
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            name: 'lookup_venue_knowledge',
            call_id: 'retired-call',
            arguments: JSON.stringify({ query: 'private?' }),
          },
        }),
      } as MessageEvent<string>)
      channelListeners[0]!.get('close')?.()
    })

    expect(mocks.end).toHaveBeenCalledOnce()
    expect(mocks.transcript).not.toHaveBeenCalled()
    expect(mocks.groundingContext).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toContain('Listening')
  })

  it('renders ordered rolling captions and replaces them with one played transcript line', async () => {
    const onTranscriptLine = vi.fn()
    mocks.availability.mockResolvedValue({ enabled: true, premiumAvailable: false })
    mocks.start.mockResolvedValue({
      voiceSessionId: '11111111-1111-4111-8111-111111111111',
      clientSecret: 'ephemeral',
      maxDurationSeconds: 600,
    })
    mocks.connected.mockResolvedValue({ connected: true })
    mocks.transcript.mockResolvedValue({ accepted: true })
    mocks.getUserMedia.mockResolvedValue({
      getTracks: () => [{ stop: vi.fn(), addEventListener: vi.fn() }],
    } as unknown as MediaStream)
    const listeners = new Map<string, (event: MessageEvent<string>) => void>()
    const channel = {
      close: vi.fn(),
      addEventListener: (type: string, listener: (event: MessageEvent<string>) => void) =>
        listeners.set(type, listener),
    }
    vi.stubGlobal(
      'RTCPeerConnection',
      vi.fn(() => ({
        addTrack: vi.fn(),
        createDataChannel: () => channel,
        createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'offer' }),
        setLocalDescription: vi.fn(),
        setRemoteDescription: vi.fn(),
        close: vi.fn(),
        ontrack: null,
      })),
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('answer')))

    render(<VoiceControl {...props} onTranscriptLine={onTranscriptLine} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice conversation' }))
    await waitFor(() => expect(mocks.connected).toHaveBeenCalledOnce())
    const providerEvent = (payload: Record<string, unknown>) =>
      listeners.get('message')?.({ data: JSON.stringify(payload) } as MessageEvent<string>)

    act(() => {
      providerEvent({ type: 'response.created', response: { id: 'response-caption' } })
      providerEvent({
        type: 'response.output_audio_transcript.delta',
        event_id: 'caption-delta-1',
        response_id: 'response-caption',
        delta: 'The gallery ',
      })
    })
    const transcriptViewport = screen.getByLabelText('Voice transcript')
    Object.defineProperties(transcriptViewport, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 300 },
    })
    act(() => {
      providerEvent({
        type: 'response.output_audio_transcript.delta',
        event_id: 'caption-delta-2',
        response_id: 'response-caption',
        delta: 'is open.',
      })
      providerEvent({
        type: 'response.output_audio_transcript.delta',
        event_id: 'caption-delta-2',
        response_id: 'response-caption',
        delta: 'is open.',
      })
    })

    expect(screen.getByLabelText('Voice transcript').textContent?.replace(/\s+/gu, ' ')).toContain(
      'Guide: The gallery is open.(caption in progress)',
    )
    expect(transcriptViewport.scrollTop).toBe(300)
    expect(screen.getByRole('status').textContent).toContain('Thinking')
    expect(mocks.transcript).not.toHaveBeenCalled()

    act(() => {
      providerEvent({
        type: 'output_audio_buffer.stopped',
        response_id: 'response-caption',
      })
      providerEvent({ type: 'response.created', response: { id: 'response-newer' } })
      providerEvent({ type: 'output_audio_buffer.started', response_id: 'response-newer' })
      providerEvent({
        type: 'response.output_audio_transcript.delta',
        event_id: 'newer-caption-delta',
        response_id: 'response-newer',
        delta: 'The cafe is downstairs.',
      })
      providerEvent({
        type: 'response.output_audio_transcript.delta',
        event_id: 'late-old-caption-delta',
        response_id: 'response-caption',
        delta: ' This must not replace the new caption.',
      })
      providerEvent({
        type: 'response.output_audio_transcript.done',
        event_id: 'caption-done',
        response_id: 'response-caption',
        transcript: 'The gallery is open.',
      })
    })

    expect(screen.getByLabelText('Voice transcript').textContent?.replace(/\s+/gu, ' ')).toContain(
      'Guide: The gallery is open.Guide: The cafe is downstairs.(caption in progress)',
    )
    expect(screen.getByLabelText('Voice transcript').textContent).not.toContain('must not replace')
    expect(screen.getByRole('status').textContent).toContain('Speaking')
    expect(mocks.transcript).toHaveBeenCalledOnce()
    expect(mocks.transcript).toHaveBeenCalledWith(
      expect.objectContaining({ providerEventId: 'caption-done', text: 'The gallery is open.' }),
    )
    await waitFor(() =>
      expect(onTranscriptLine).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'The gallery is open.',
          voiceDelivery: 'CAPTURED',
          persistence: 'SAVED',
        }),
      ),
    )

    act(() => {
      providerEvent({
        type: 'response.output_audio_transcript.done',
        event_id: 'newer-caption-done',
        response_id: 'response-newer',
        transcript: 'The cafe is downstairs.',
      })
      providerEvent({ type: 'output_audio_buffer.stopped', response_id: 'response-newer' })
      providerEvent({
        type: 'response.output_audio_transcript.done',
        event_id: 'newer-caption-done-duplicate',
        response_id: 'response-newer',
        transcript: 'The cafe is downstairs.',
      })
    })
    expect(screen.getByLabelText('Voice transcript').textContent).not.toContain(
      'caption in progress',
    )
    expect(mocks.transcript).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(onTranscriptLine).toHaveBeenCalledTimes(4))
  })

  it.each(['scope change', 'unmount'] as const)(
    'does not publish a delayed transcript save state after %s',
    async (retirement) => {
      mocks.availability.mockResolvedValue({ enabled: true, premiumAvailable: false })
      mocks.start.mockResolvedValue({
        voiceSessionId: '11111111-1111-4111-8111-111111111111',
        clientSecret: 'ephemeral',
        maxDurationSeconds: 600,
      })
      mocks.connected.mockResolvedValue({ connected: true })
      let resolveTranscript!: (value: { accepted: boolean }) => void
      mocks.transcript.mockReturnValue(
        new Promise((resolve) => {
          resolveTranscript = resolve
        }),
      )
      mocks.getUserMedia.mockResolvedValue({
        getTracks: () => [{ stop: vi.fn(), addEventListener: vi.fn() }],
      } as unknown as MediaStream)
      const listeners = new Map<string, (event: MessageEvent<string>) => void>()
      vi.stubGlobal(
        'RTCPeerConnection',
        vi.fn(() => ({
          addTrack: vi.fn(),
          createDataChannel: () => ({
            close: vi.fn(),
            addEventListener: (type: string, listener: (event: MessageEvent<string>) => void) =>
              listeners.set(type, listener),
          }),
          createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'offer' }),
          setLocalDescription: vi.fn(),
          setRemoteDescription: vi.fn(),
          close: vi.fn(),
          ontrack: null,
        })),
      )
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('answer')))
      const onTranscriptLine = vi.fn()
      const view = render(<VoiceControl {...props} onTranscriptLine={onTranscriptLine} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Start voice conversation' }))
      await waitFor(() => expect(mocks.connected).toHaveBeenCalledOnce())
      const visitorTranscript =
        retirement === 'scope change' ? ` ${'x'.repeat(9_000)} ` : 'Where is the lift?'
      act(() =>
        listeners.get('message')?.({
          data: JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            event_id: 'visitor-line-delayed-save',
            transcript: visitorTranscript,
          }),
        } as MessageEvent<string>),
      )
      expect(onTranscriptLine).toHaveBeenCalledOnce()
      expect(onTranscriptLine).toHaveBeenLastCalledWith(
        expect.objectContaining({ persistence: 'PENDING' }),
      )
      if (retirement === 'scope change') {
        expect(mocks.transcript).toHaveBeenCalledWith(
          expect.objectContaining({ text: 'x'.repeat(8_000) }),
        )
        expect(onTranscriptLine.mock.calls[0]?.[0].content).toHaveLength(8_000)
      }

      if (retirement === 'scope change') {
        view.rerender(
          <VoiceControl {...props} venueId="venue-2" onTranscriptLine={onTranscriptLine} />,
        )
      } else {
        view.unmount()
      }
      await act(async () => {
        resolveTranscript({ accepted: true })
        await Promise.resolve()
      })

      expect(onTranscriptLine).toHaveBeenCalledOnce()
    },
  )

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
    const send = vi.fn((value: string) => {
      if ((JSON.parse(value) as { type?: string }).type === 'response.create') {
        throw new Error('simulated closed-channel send')
      }
    })
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
      providerEvent({
        type: 'response.output_audio_transcript.delta',
        event_id: 'caption-partial-1',
        response_id: 'response-1',
        delta: 'The gallery is on ',
      })
      providerEvent({
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          name: 'lookup_venue_knowledge',
          call_id: 'call-1',
          arguments: JSON.stringify({ query: 'Where is the bathroom?' }),
        },
      })
      providerEvent({
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          name: 'lookup_venue_knowledge',
          call_id: 'call-1',
          arguments: JSON.stringify({ query: 'Where is the bathroom?' }),
        },
      })
      providerEvent({
        type: 'response.output_item.done',
        response_id: 'response-1',
        item: {
          type: 'function_call',
          name: 'lookup_venue_knowledge',
          call_id: 'call-2',
          arguments: JSON.stringify({ query: 'Is there step-free access?' }),
        },
      })
    })
    expect(
      send.mock.calls.some(([value]) => JSON.parse(value as string).type === 'response.create'),
    ).toBe(false)
    act(() =>
      providerEvent({
        type: 'response.done',
        response: {
          id: 'response-1',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              name: 'lookup_venue_knowledge',
              call_id: 'call-1',
              arguments: JSON.stringify({ query: 'Where is the bathroom?' }),
            },
            {
              type: 'function_call',
              name: 'lookup_venue_knowledge',
              call_id: 'call-2',
              arguments: JSON.stringify({ query: 'Is there step-free access?' }),
            },
            {
              type: 'function_call',
              name: 'lookup_venue_knowledge',
              call_id: 'call-3',
              arguments: JSON.stringify({ query: 'What are today’s hours?' }),
            },
            {
              type: 'function_call',
              name: 'lookup_venue_knowledge',
              call_id: 'call-4',
              arguments: JSON.stringify({ query: 'Where is the cafe?' }),
            },
            {
              type: 'function_call',
              name: 'lookup_venue_knowledge',
              call_id: 'call-1',
              arguments: JSON.stringify({ query: 'duplicate' }),
            },
          ],
        },
      }),
    )
    await waitFor(() => expect(mocks.groundingContext).toHaveBeenCalledTimes(3))
    await waitFor(() =>
      expect(
        send.mock.calls.filter(([value]) => JSON.parse(value as string).type === 'response.create'),
      ).toHaveLength(1),
    )
    expect(send.mock.calls.map(([value]) => JSON.parse(value as string))).toContainEqual({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: JSON.stringify({
          grounded: true,
          context: '[Bathrooms]\nBeside the east lift.',
          sourceIds: ['bathroom'],
        }),
      },
    })
    expect(send.mock.calls.map(([value]) => JSON.parse(value as string))).toContainEqual({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: 'call-4',
        output: JSON.stringify({
          grounded: false,
          context: '',
          error: 'GROUNDING_CALL_LIMIT_EXCEEDED',
        }),
      },
    })

    let resolveLate!: (value: { context: string; sourceIds: string[] }) => void
    mocks.groundingContext.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLate = resolve
      }),
    )
    act(() => {
      providerEvent({ type: 'response.created', response: { id: 'response-2' } })
      providerEvent({
        type: 'response.done',
        response: {
          id: 'response-2',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              name: 'lookup_venue_knowledge',
              call_id: 'call-late',
              arguments: JSON.stringify({ query: 'What time does it close?' }),
            },
          ],
        },
      })
      providerEvent({ type: 'response.created', response: { id: 'response-3' } })
      providerEvent({ type: 'input_audio_buffer.speech_started', event_id: 'speech-1' })
      providerEvent({
        type: 'response.output_item.done',
        response_id: 'response-2',
        item: {
          type: 'function_call',
          name: 'lookup_venue_knowledge',
          call_id: 'call-after-interrupt',
          arguments: JSON.stringify({ query: 'This call is stale.' }),
        },
      })
      providerEvent({
        type: 'output_audio_buffer.cleared',
        event_id: 'clear-1',
        response_id: 'response-1',
      })
    })
    expect(screen.getByLabelText('Voice transcript').textContent?.replace(/\s+/gu, ' ')).toContain(
      'Guide: The gallery is on (interrupted; finalizing)',
    )
    expect(mocks.transcript).not.toHaveBeenCalled()
    act(() => {
      providerEvent({
        type: 'response.output_audio_transcript.done',
        event_id: 'transcript-1',
        response_id: 'response-1',
        transcript: 'The gallery is on the second floor.',
      })
    })

    await act(async () => {
      resolveLate({ context: '[Hours]\nFive.', sourceIds: ['hours'] })
      await Promise.resolve()
    })
    act(() =>
      providerEvent({ type: 'response.done', response: { id: 'response-3', status: 'cancelled' } }),
    )
    act(() =>
      providerEvent({
        type: 'response.done',
        response: {
          id: 'response-2',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              name: 'lookup_venue_knowledge',
              call_id: 'call-late',
              arguments: JSON.stringify({ query: 'duplicate old response' }),
            },
          ],
        },
      }),
    )
    expect(send.mock.calls.some(([value]) => String(value).includes('call-late'))).toBe(false)
    expect(mocks.groundingContext).toHaveBeenCalledTimes(4)
    expect(
      send.mock.calls.filter(([value]) => JSON.parse(value as string).type === 'response.create'),
    ).toHaveLength(1)

    expect(send.mock.calls.map(([value]) => JSON.parse(value as string))).toContainEqual({
      type: 'response.cancel',
      response_id: 'response-3',
    })
    expect(send.mock.calls.map(([value]) => JSON.parse(value as string))).toContainEqual({
      type: 'output_audio_buffer.clear',
    })
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
    const onTranscriptLine = vi.fn()
    mocks.availability.mockResolvedValue({ enabled: true, premiumAvailable: false })
    mocks.start.mockResolvedValue({
      voiceSessionId: '11111111-1111-4111-8111-111111111111',
      clientSecret: 'ephemeral',
      maxDurationSeconds: 600,
    })
    mocks.connected.mockResolvedValue({ connected: true })
    mocks.transcript.mockRejectedValue(new Error('transcript save unavailable'))
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

    render(<VoiceControl {...props} onTranscriptLine={onTranscriptLine} />)
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
    await waitFor(() =>
      expect(onTranscriptLine).toHaveBeenLastCalledWith(
        expect.objectContaining({
          content: 'Partly heard.',
          voiceDelivery: 'INTERRUPTED',
          persistence: 'UNCONFIRMED',
        }),
      ),
    )
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
