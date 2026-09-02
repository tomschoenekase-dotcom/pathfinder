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

vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => ({
    voice: {
      availability: { query: mocks.availability },
      start: { mutate: mocks.start },
      connected: { mutate: mocks.connected },
      transcript: { mutate: mocks.transcript },
      usage: { mutate: mocks.usage },
      end: { mutate: mocks.end },
    },
  }),
}))

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
