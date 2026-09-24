/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  historyReplace: vi.fn(),
  listProspectSavedViews: vi.fn(),
  listProspects: vi.fn(),
  saveProspectView: vi.fn(),
  createProspectCampaign: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/prospects',
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))
vi.mock('../../lib/trpc', () => {
  const client = {
    admin: {
      listProspectSavedViews: { query: mocks.listProspectSavedViews },
      listProspects: { query: mocks.listProspects },
      saveProspectView: { mutate: mocks.saveProspectView },
      createProspectCampaign: { mutate: mocks.createProspectCampaign },
    },
  }
  return { useTRPCClient: () => client }
})

import { ProspectDirectory } from './ProspectDirectory'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const prospect = {
  id: 'prospect-1',
  canonicalName: 'Harbor Museum',
  _count: { sources: 1 },
  venues: [{ name: 'Harbor Museum' }],
  territory: { name: 'Chicago' },
  opportunity: {
    stage: 'RESEARCHED',
    priority: 'HIGH',
    nextAction: 'Review contact',
    nextActionAt: new Date('2026-09-01T12:00:00Z'),
  },
  relationshipTier: 'HIGH_VALUE',
  priority: 'HIGH',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('ProspectDirectory request lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(window.history, 'replaceState').mockImplementation(mocks.historyReplace)
    window.localStorage.clear()
    mocks.listProspectSavedViews.mockResolvedValue([])
    mocks.listProspects.mockResolvedValue({ items: [prospect], nextCursor: null })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('passes cancellable transport signals to initial directory reads', async () => {
    render(<ProspectDirectory />)

    expect(await screen.findByText('Harbor Museum')).toBeTruthy()
    expect(mocks.listProspectSavedViews).toHaveBeenCalledWith(undefined, {
      signal: expect.any(AbortSignal),
    })
    expect(mocks.listProspects).toHaveBeenCalledWith(
      { limit: 100, sort: 'UPDATED' },
      { signal: expect.any(AbortSignal) },
    )
  })

  it('aborts an obsolete filtered read before starting the replacement', async () => {
    const pending = deferred<{ items: (typeof prospect)[]; nextCursor: null }>()
    let firstSignal: AbortSignal | undefined
    mocks.listProspects.mockImplementationOnce(
      (_input: unknown, options: { signal: AbortSignal }) => {
        firstSignal = options.signal
        return pending.promise
      },
    )
    render(<ProspectDirectory />)
    await waitFor(() => expect(firstSignal).toBeInstanceOf(AbortSignal))

    fireEvent.change(screen.getByRole('textbox', { name: 'Search prospects' }), {
      target: { value: 'harbor' },
    })

    expect(firstSignal?.aborted).toBe(true)
    pending.resolve({ items: [prospect], nextCursor: null })
  })

  it('fences pagination and aborts its transport on unmount', async () => {
    const cursor = { canonicalName: 'Museum', id: 'prospect-1' }
    const pending = deferred<{ items: (typeof prospect)[]; nextCursor: null }>()
    let pageSignal: AbortSignal | undefined
    mocks.listProspects
      .mockResolvedValueOnce({ items: [prospect], nextCursor: cursor })
      .mockImplementationOnce((_input: unknown, options: { signal: AbortSignal }) => {
        pageSignal = options.signal
        return pending.promise
      })
    const rendered = render(<ProspectDirectory />)
    const loadMore = await screen.findByRole('button', { name: 'Load 100 more' })

    fireEvent.click(loadMore)
    fireEvent.click(loadMore)
    await waitFor(() => expect(pageSignal).toBeInstanceOf(AbortSignal))
    expect(mocks.listProspects).toHaveBeenCalledTimes(2)

    rendered.unmount()
    expect(pageSignal?.aborted).toBe(true)
  })

  it('does not let a late filter change replace navigation into a record', async () => {
    render(<ProspectDirectory />)
    const link = await screen.findByRole('link', { name: /^Harbor Museum/ })
    // Prevent jsdom navigation while allowing the real link handler to run.
    link.addEventListener('click', (event) => event.preventDefault())
    fireEvent.click(link)
    mocks.historyReplace.mockClear()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search prospects' }), {
      target: { value: 'late result filter' },
    })
    expect(mocks.historyReplace).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it('keeps filters usable after opening a record in another tab', async () => {
    render(<ProspectDirectory />)
    const link = await screen.findByRole('link', { name: /^Harbor Museum/ })
    link.addEventListener('click', (event) => event.preventDefault())
    fireEvent.click(link, { ctrlKey: true })
    mocks.historyReplace.mockClear()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search prospects' }), {
      target: { value: 'another museum' },
    })
    expect(mocks.historyReplace).toHaveBeenCalledWith(
      null,
      '',
      expect.stringContaining('search=another+museum'),
    )
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it('leaves remembered filters unchanged when this browser cannot serialize cross-tab writes', async () => {
    render(<ProspectDirectory />)
    await screen.findByText('Harbor Museum')

    fireEvent.click(screen.getByRole('button', { name: 'Remember filters' }))

    expect(
      await screen.findByText(
        'This browser cannot safely remember filters across tabs. The filter link still works.',
      ),
    ).toBeTruthy()
    expect(window.localStorage.length).toBe(0)
  })
})
