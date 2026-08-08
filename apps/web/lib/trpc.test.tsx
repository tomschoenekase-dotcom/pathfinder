import React from 'react'
import { render } from '@testing-library/react'
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
})
