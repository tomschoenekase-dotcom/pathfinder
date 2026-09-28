/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  listProspectSavedViews: vi.fn(),
  listProspectTerritories: vi.fn(),
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
      listProspectTerritories: { query: mocks.listProspectTerritories },
      listProspects: { query: mocks.listProspects },
      saveProspectView: { mutate: mocks.saveProspectView },
      createProspectCampaign: { mutate: mocks.createProspectCampaign },
    },
  }
  return { useTRPCClient: () => client }
})

import { ProspectDirectory } from './ProspectDirectory'
import { defaultProspectGoodFitRules } from '@pathfinder/contracts/prospect-size'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const prospect = {
  id: 'prospect-1',
  canonicalName: 'Harbor Museum',
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
    mocks.listProspectSavedViews.mockResolvedValue([])
    mocks.listProspectTerritories.mockResolvedValue([])
    mocks.listProspects.mockResolvedValue({ items: [prospect], nextCursor: null })
  })

  afterEach(cleanup)

  it('passes cancellable transport signals to initial directory reads', async () => {
    render(<ProspectDirectory />)

    expect(await screen.findByText('Harbor Museum')).toBeTruthy()
    expect(mocks.listProspectSavedViews).toHaveBeenCalledWith(undefined, {
      signal: expect.any(AbortSignal),
    })
    expect(mocks.listProspects).toHaveBeenCalledWith(
      { limit: 100 },
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

  it('edits and saves a scoped Good fit view variation', async () => {
    mocks.saveProspectView.mockResolvedValue({})
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('Tiny museums')
    try {
      render(<ProspectDirectory />)
      await screen.findByText('Harbor Museum')
      fireEvent.click(screen.getByRole('button', { name: /Good fit ·/u }))
      fireEvent.click(screen.getByText('Edit Good fit rules'))
      fireEvent.click(screen.getByRole('checkbox', { name: 'L' }))
      fireEvent.click(screen.getByRole('checkbox', { name: 'Exclude outreach drafts' }))
      fireEvent.change(
        screen.getByRole('textbox', { name: 'Supported categories, one per line' }),
        { target: { value: 'museum' } },
      )
      fireEvent.click(screen.getByRole('button', { name: 'Apply text rules' }))
      await waitFor(() =>
        expect(mocks.listProspects).toHaveBeenLastCalledWith(
          expect.objectContaining({
            goodFit: true,
            goodFitRules: expect.objectContaining({
              supportedCategories: ['museum'],
              sizeClasses: ['S', 'M'],
              excludeDrafts: false,
            }),
            limit: 100,
          }),
          { signal: expect.any(AbortSignal) },
        ),
      )
      fireEvent.click(screen.getByRole('button', { name: 'Save current view' }))
      await waitFor(() =>
        expect(mocks.saveProspectView).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'Tiny museums',
            filters: expect.objectContaining({
              goodFit: true,
              goodFitRules: expect.objectContaining({
                supportedCategories: ['museum'],
                excludeDrafts: false,
              }),
            }),
          }),
        ),
      )
    } finally {
      prompt.mockRestore()
    }
  })

  it('reapplies the stored rule settings when a named view is selected', async () => {
    mocks.listProspectSavedViews.mockResolvedValue([
      {
        id: 'view-tiny',
        name: 'Tiny museums',
        filters: {
          goodFit: true,
          goodFitRules: {
            ...defaultProspectGoodFitRules,
            supportedCategories: ['museum'],
            sizeClasses: ['XS'],
            preferredSizeClass: 'XS',
          },
        },
      },
    ])
    render(<ProspectDirectory />)
    fireEvent.click(await screen.findByRole('button', { name: 'Tiny museums' }))
    await waitFor(() =>
      expect(mocks.listProspects).toHaveBeenLastCalledWith(
        expect.objectContaining({
          goodFit: true,
          goodFitRules: expect.objectContaining({
            supportedCategories: ['museum'],
            sizeClasses: ['XS'],
            preferredSizeClass: 'XS',
          }),
        }),
        { signal: expect.any(AbortSignal) },
      ),
    )
  })
})
