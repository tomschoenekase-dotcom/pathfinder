import React from 'react'
import { render, waitFor } from '@testing-library/react'
import { useQueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

import { TRPCProvider, useTRPCClient, type WebTRPCClient } from './trpc'

function ClientProbe({ onCapture }: { onCapture: (capture: unknown) => void }) {
  onCapture({ client: useTRPCClient(), queryClient: useQueryClient() })
  return null
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
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          '{"type":"delta","delta":"Near"}\n' +
            '{"type":"complete","result":{"response":"Nearby."}}',
          { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
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
    const client = captures.at(-1)!.client as unknown as {
      chat: {
        stream: {
          subscribe: (
            value: typeof input,
            observer: {
              onData: (value: unknown) => void
              onComplete: () => void
              onError: (error: unknown) => void
            },
          ) => { unsubscribe: () => void }
        }
      }
    }

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
})
