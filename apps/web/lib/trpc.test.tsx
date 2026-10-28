import React from 'react'
import { render, waitFor } from '@testing-library/react'
import { useQueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TRPCProvider, useTRPCClient, type WebTRPCClient } from './trpc'

function ClientProbe({ onCapture }: { onCapture: (capture: unknown) => void }) {
  onCapture({ client: useTRPCClient(), queryClient: useQueryClient() })
  return null
}

type ChatStreamInput = {
  venueId: string
  anonymousToken: string
  message: string
}

type ChatStreamClient = {
  chat: {
    stream: {
      subscribe: (
        value: ChatStreamInput,
        observer: {
          onData: (value: unknown) => void
          onComplete: () => void
          onError: (error: unknown) => void
        },
      ) => { unsubscribe: () => void }
    }
  }
}

function chatStreamClient(client: WebTRPCClient): ChatStreamClient {
  return client as unknown as ChatStreamClient
}

describe('TRPCProvider', () => {
  it('requires browser consumers to be inside the route-scoped provider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(() => render(<ClientProbe onCapture={() => undefined} />)).toThrow(
      'useTRPCClient must be used within a TRPCProvider',
    )

    consoleError.mockRestore()
  })

  it('keeps one client within a scope and creates a fresh client when the scope changes', () => {
    const captures: Array<{ client: WebTRPCClient; queryClient: unknown }> = []
    const onCapture = (capture: unknown) => {
      captures.push(capture as { client: WebTRPCClient; queryClient: unknown })
    }
    const view = render(
      <TRPCProvider scopeKey="venue:first">
        <ClientProbe onCapture={onCapture} />
      </TRPCProvider>,
    )

    const first = captures.at(-1)!
    view.rerender(
      <TRPCProvider scopeKey="venue:first">
        <ClientProbe onCapture={onCapture} />
      </TRPCProvider>,
    )
    const sameScope = captures.at(-1)!
    expect(sameScope.client).toBe(first.client)
    expect(sameScope.queryClient).toBe(first.queryClient)

    view.rerender(
      <TRPCProvider scopeKey="venue:second">
        <ClientProbe onCapture={onCapture} />
      </TRPCProvider>,
    )
    const changedScope = captures.at(-1)!
    expect(changedScope.client).not.toBe(first.client)
    expect(changedScope.queryClient).not.toBe(first.queryClient)
  })

  it('sends subscription input only in a POST body and decodes NDJSON events', async () => {
    const captures: Array<{ client: WebTRPCClient }> = []
    render(
      <TRPCProvider scopeKey="venue:stream">
        <ClientProbe onCapture={(capture) => captures.push(capture as { client: WebTRPCClient })} />
      </TRPCProvider>,
    )
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        '{"type":"delta","delta":"Near"}\n' + '{"type":"complete","result":{"response":"Nearby."}}',
        {
          status: 200,
          headers: {
            'cache-control': 'no-store',
            'content-type': 'application/x-ndjson',
          },
        },
      ),
    )
    const onData = vi.fn()
    const onComplete = vi.fn()
    const onError = vi.fn()
    const input = {
      venueId: 'venue-1',
      anonymousToken: '123e4567-e89b-42d3-a456-426614174000',
      message: 'Where is the café?',
    }
    const client = chatStreamClient(captures.at(-1)!.client)

    const subscription = client.chat.stream.subscribe(input, { onData, onComplete, onError })
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce())

    expect(onError).not.toHaveBeenCalled()
    expect(onData).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat-stream',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }),
    )
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain(input.message)
    subscription.unsubscribe()
    fetchMock.mockRestore()
  })

  it('rejects and cancels an oversized chat stream before decoding it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const captures: Array<{ client: WebTRPCClient }> = []
    render(
      <TRPCProvider scopeKey="venue:oversized-stream">
        <ClientProbe onCapture={(capture) => captures.push(capture as { client: WebTRPCClient })} />
      </TRPCProvider>,
    )
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1))
      },
      cancel,
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, {
        headers: {
          'cache-control': 'no-store',
          'content-type': 'application/x-ndjson',
        },
      }),
    )
    const onError = vi.fn()
    const subscription = chatStreamClient(captures.at(-1)!.client).chat.stream.subscribe(
      {
        venueId: 'venue-1',
        anonymousToken: '123e4567-e89b-42d3-a456-426614174000',
        message: 'Where is the café?',
      },
      { onData: vi.fn(), onComplete: vi.fn(), onError },
    )

    await waitFor(() => expect(onError).toHaveBeenCalledOnce())
    expect(cancel).toHaveBeenCalledOnce()
    expect(consoleError).not.toHaveBeenCalled()
    subscription.unsubscribe()
    fetchMock.mockRestore()
    consoleError.mockRestore()
  })

  it('rejects and cancels a chat stream without the private NDJSON response policy', async () => {
    const captures: Array<{ client: WebTRPCClient }> = []
    render(
      <TRPCProvider scopeKey="venue:invalid-stream-policy">
        <ClientProbe onCapture={(capture) => captures.push(capture as { client: WebTRPCClient })} />
      </TRPCProvider>,
    )
    const cancel = vi.fn()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new ReadableStream<Uint8Array>({ cancel }), {
        headers: {
          'cache-control': 'public, max-age=300',
          'content-type': 'application/json',
        },
      }),
    )
    const onError = vi.fn()
    const subscription = chatStreamClient(captures.at(-1)!.client).chat.stream.subscribe(
      {
        venueId: 'venue-1',
        anonymousToken: '123e4567-e89b-42d3-a456-426614174000',
        message: 'Where is the café?',
      },
      { onData: vi.fn(), onComplete: vi.fn(), onError },
    )

    await waitFor(() => expect(onError).toHaveBeenCalledOnce())
    expect(cancel).toHaveBeenCalledOnce()
    subscription.unsubscribe()
    fetchMock.mockRestore()
  })

  it('rejects a stalled chat stream after the idle-read deadline', async () => {
    vi.useFakeTimers()
    const captures: Array<{ client: WebTRPCClient }> = []
    render(
      <TRPCProvider scopeKey="venue:stalled-stream">
        <ClientProbe onCapture={(capture) => captures.push(capture as { client: WebTRPCClient })} />
      </TRPCProvider>,
    )
    const cancel = vi.fn()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new ReadableStream<Uint8Array>({ cancel }), {
        headers: {
          'cache-control': 'no-store',
          'content-type': 'application/x-ndjson',
        },
      }),
    )
    const onError = vi.fn()
    const subscription = chatStreamClient(captures.at(-1)!.client).chat.stream.subscribe(
      {
        venueId: 'venue-1',
        anonymousToken: '123e4567-e89b-42d3-a456-426614174000',
        message: 'Where is the café?',
      },
      { onData: vi.fn(), onComplete: vi.fn(), onError },
    )

    await vi.advanceTimersByTimeAsync(30_000)
    expect(onError).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
    subscription.unsubscribe()
    fetchMock.mockRestore()
    vi.useRealTimers()
  })
})

describe('chat stream terminal delivery', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })
  function subscribe(body: ReadableStream<Uint8Array>, validPolicy = true) {
    const captures: Array<{ client: WebTRPCClient }> = []
    render(
      <TRPCProvider scopeKey="venue:terminal">
        <ClientProbe onCapture={(capture) => captures.push(capture as { client: WebTRPCClient })} />
      </TRPCProvider>,
    )
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, {
        headers: {
          'cache-control': validPolicy ? 'no-store' : 'public',
          'content-type': 'application/x-ndjson',
        },
      }),
    )
    const observer = { onData: vi.fn(), onComplete: vi.fn(), onError: vi.fn() }
    const subscription = chatStreamClient(captures.at(-1)!.client).chat.stream.subscribe(
      {
        venueId: 'fictional-museum',
        anonymousToken: '123e4567-e89b-42d3-a456-426614174000',
        message: 'Where is the gallery?',
      },
      observer,
    )
    return { ...observer, subscription }
  }
  it.each(['', '{"type":"error"}\n', '{broken JSON}\n'])(
    'settles at complete without EOF and ignores trailing data %s',
    async (tail) => {
      const cancel = vi.fn(() => new Promise<void>(() => undefined))
      const observer = subscribe(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                '{"type":"complete","result":{"response":"Beside the gallery."}}\n' + tail,
              ),
            )
          },
          cancel,
        }),
      )
      try {
        await waitFor(() => expect(observer.onComplete).toHaveBeenCalledOnce())
        expect(observer.onData).toHaveBeenCalledOnce()
        expect(observer.onError).not.toHaveBeenCalled()
        expect(cancel).toHaveBeenCalledOnce()
      } finally {
        observer.subscription.unsubscribe()
      }
    },
  )
  it.each(['timeout', 'error', 'invalid-policy'])(
    'delivers %s even if cancellation never settles',
    async (failure) => {
      vi.useFakeTimers()
      const cancel = vi.fn(() => new Promise<void>(() => undefined))
      const observer = subscribe(
        new ReadableStream({
          start(controller) {
            if (failure === 'error')
              controller.enqueue(new TextEncoder().encode('{"type":"error"}\n'))
          },
          cancel,
        }),
        failure !== 'invalid-policy',
      )
      try {
        await vi.advanceTimersByTimeAsync(30_000)
        expect(observer.onError).toHaveBeenCalledOnce()
        expect(observer.onComplete).not.toHaveBeenCalled()
        expect(cancel).toHaveBeenCalledOnce()
      } finally {
        observer.subscription.unsubscribe()
      }
    },
  )
  it('reports incomplete EOF as failure', async () => {
    const observer = subscribe(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('{"type":"delta","delta":"Visible answer"}\n'),
          )
          controller.close()
        },
      }),
    )
    await waitFor(() => expect(observer.onError).toHaveBeenCalledOnce())
    expect(observer.onComplete).not.toHaveBeenCalled()
    expect(observer.onData).toHaveBeenCalledOnce()
  })
  it('preserves split UTF-8 characters and a final event without a newline', async () => {
    const answer = 'Caf\u00e9 \u2014 \u65e5\u672c \ud83e\udd8a'
    const bytes = new TextEncoder().encode(
      JSON.stringify({ type: 'complete', result: { response: answer } }),
    )
    const observer = subscribe(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
          controller.close()
        },
      }),
    )
    await waitFor(() => expect(observer.onComplete).toHaveBeenCalledOnce())
    expect(observer.onData).toHaveBeenCalledWith({ type: 'complete', result: { response: answer } })
    expect(observer.onError).not.toHaveBeenCalled()
  })
})
