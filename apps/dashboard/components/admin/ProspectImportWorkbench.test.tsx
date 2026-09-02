/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => {
  const listImports = vi.fn()
  return {
    listImports,
    client: { admin: { listProspectImports: { query: listImports } } },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))
vi.mock('../../lib/trpc', () => ({ useTRPCClient: () => mocks.client }))

import { ProspectImportWorkbench } from './ProspectImportWorkbench'

describe('ProspectImportWorkbench history boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listImports.mockResolvedValue([])
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('loads retained import history through a cancellable transport request', async () => {
    render(<ProspectImportWorkbench />)
    expect(screen.getByText('Loading retained imports…')).toBeTruthy()
    expect(await screen.findByText('No retained imports yet.')).toBeTruthy()
    expect(mocks.listImports).toHaveBeenCalledWith(undefined, {
      signal: expect.any(AbortSignal),
    })
  })

  it('aborts a stalled history read when the workbench unmounts', async () => {
    let signal: AbortSignal | undefined
    mocks.listImports.mockImplementation((_input, options) => {
      signal = options.signal
      return new Promise(() => {})
    })
    const view = render(<ProspectImportWorkbench />)
    await waitFor(() => expect(signal).toBeDefined())
    view.unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('shows fixed retry guidance instead of a false empty history after the deadline', async () => {
    vi.useFakeTimers()
    mocks.listImports.mockImplementation(() => new Promise(() => {}))
    render(<ProspectImportWorkbench />)
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(screen.getByRole('alert').textContent).toMatch(/could not be loaded in time/i)
    expect(screen.queryByText('No retained imports yet.')).toBeNull()

    vi.useRealTimers()
    mocks.listImports.mockResolvedValue([])
    fireEvent.click(screen.getByRole('button', { name: 'Retry history' }))
    expect(await screen.findByText('No retained imports yet.')).toBeTruthy()
  })
})
