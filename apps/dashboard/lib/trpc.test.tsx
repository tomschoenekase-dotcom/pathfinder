/* @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { useQueryClient } from '@tanstack/react-query'
import React from 'react'

import { TRPCProvider, useTRPCClient, type DashboardTRPCClient } from './trpc'

function Capture({ onCapture }: { onCapture: (value: unknown) => void }) {
  onCapture({ client: useTRPCClient(), queryClient: useQueryClient() })
  return null
}

describe('TRPCProvider', () => {
  it('fails clearly when an imperative client is used outside the provider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(() => render(<Capture onCapture={() => undefined} />)).toThrow(
      'useTRPCClient must be used within a TRPCProvider',
    )

    consoleError.mockRestore()
  })

  it('keeps one client and query cache for a stable scope, then replaces both for a new scope', () => {
    const captures: Array<{ client: DashboardTRPCClient; queryClient: unknown }> = []
    const onCapture = (value: unknown) => {
      captures.push(value as { client: DashboardTRPCClient; queryClient: unknown })
    }

    const { rerender } = render(
      <TRPCProvider scopeKey="tenant:one">
        <Capture onCapture={onCapture} />
      </TRPCProvider>,
    )
    const first = captures.at(-1)!

    rerender(
      <TRPCProvider scopeKey="tenant:one">
        <Capture onCapture={onCapture} />
      </TRPCProvider>,
    )
    const sameScope = captures.at(-1)!

    expect(sameScope.client).toBe(first.client)
    expect(sameScope.queryClient).toBe(first.queryClient)

    rerender(
      <TRPCProvider scopeKey="tenant:two">
        <Capture onCapture={onCapture} />
      </TRPCProvider>,
    )
    const changedScope = captures.at(-1)!

    expect(changedScope.client).not.toBe(first.client)
    expect(changedScope.queryClient).not.toBe(first.queryClient)
  })
})
