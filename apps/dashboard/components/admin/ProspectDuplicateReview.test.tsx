/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  scan: vi.fn(),
  resolve: vi.fn(),
}))

vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      listProspectDuplicates: { query: mocks.list },
      scanProspectDuplicates: { mutate: mocks.scan },
      resolveProspectDuplicate: { mutate: mocks.resolve },
    },
  }),
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))

import { ProspectDuplicateReview } from './ProspectDuplicateReview'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('ProspectDuplicateReview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('loads the bounded review queue before showing the confirmed empty state', async () => {
    mocks.list.mockResolvedValue([])
    render(<ProspectDuplicateReview />)

    expect(await screen.findByText('No open duplicate candidates.')).toBeTruthy()
    expect(mocks.list).toHaveBeenCalledWith(
      { status: 'OPEN', limit: 200 },
      { signal: expect.any(AbortSignal) },
    )
    expect(screen.getByText('The review queue is clear')).toBeTruthy()
  })

  it('does not claim an empty queue when the initial read exceeds its deadline', async () => {
    vi.useFakeTimers()
    mocks.list.mockImplementation(() => new Promise(() => {}))
    render(<ProspectDuplicateReview />)
    await act(async () => vi.advanceTimersByTimeAsync(0))
    const signal = mocks.list.mock.calls[0]?.[1]?.signal as AbortSignal
    await act(async () => vi.advanceTimersByTimeAsync(15_000))

    expect(signal.aborted).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('could not be loaded in time')
    expect(screen.queryByText('The review queue is clear')).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Refresh queue' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('keeps definitive scan evidence when the follow-up queue read times out', async () => {
    mocks.list.mockResolvedValueOnce([]).mockImplementationOnce(() => new Promise(() => {}))
    mocks.scan.mockResolvedValue({ organizationsScanned: 42, candidatesCreated: 3 })
    render(<ProspectDuplicateReview />)
    await screen.findByText('No open duplicate candidates.')

    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Scan prospects' }))
    await act(async () => vi.advanceTimersByTimeAsync(0))
    const signal = mocks.list.mock.calls[1]?.[1]?.signal as AbortSignal
    await act(async () => vi.advanceTimersByTimeAsync(15_000))

    expect(signal.aborted).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('Scanned 42 prospects; created 3')
    expect(screen.getByRole('alert').textContent).toContain('could not be reloaded in time')
  })

  it('aborts an in-flight queue read when the surface unmounts', async () => {
    let signal: AbortSignal | undefined
    mocks.list.mockImplementation((_input, options: { signal: AbortSignal }) => {
      signal = options.signal
      return new Promise(() => {})
    })
    const view = render(<ProspectDuplicateReview />)
    await waitFor(() => expect(signal).toBeDefined())
    view.unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('contains provider failures behind product-owned retry guidance', async () => {
    mocks.list.mockRejectedValue(new Error('secret provider detail'))
    render(<ProspectDuplicateReview />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText(/secret provider detail/i)).toBeNull()
  })
})
