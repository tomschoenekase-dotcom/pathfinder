/* @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const update = vi.fn()
  const listAssets = vi.fn()
  return {
    update,
    listAssets,
    client: {
      admin: {
        updateGuestDesign: { mutate: update },
        listGuestBrandingAssets: { query: listAssets },
      },
    },
  }
})
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => mocks.client,
}))

import { GuestDesignWorkspace } from './GuestDesignWorkspace'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const initial = {
  id: 'venue-1',
  name: 'Science Museum',
  description: 'Explore science together.',
  guideMode: 'location_aware',
  aiGuideName: 'Nova',
  chatTheme: 'forest',
  chatAccentColor: '#245A4A',
  chatFont: 'inter',
  chatLogoUrl: 'https://cdn.example.test/reviewed-logo.png',
  chatBannerUrl: 'https://cdn.example.test/reviewed-banner.png',
  chatShowPhotos: false,
  chatShowLinks: false,
  updatedAt: new Date('2026-08-12T12:00:00.000Z'),
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('GuestDesignWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.update.mockImplementation(
      async (input: { fields: { chatLogoUrl: string | null; chatBannerUrl: string | null } }) => ({
        ...initial,
        ...input.fields,
        updatedAt: new Date('2026-08-12T12:01:00.000Z'),
        replayed: false,
      }),
    )
  })
  afterEach(cleanup)

  it('submits exact scope and CAS while allowing only retained or cleared reviewed assets', async () => {
    render(<GuestDesignWorkspace tenantId="tenant-1" venueId="venue-1" initial={initial} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }))
    fireEvent.change(screen.getByLabelText('Accent colour'), { target: { value: '#ABCDEF' } })
    fireEvent.change(screen.getByLabelText('Font'), { target: { value: 'poppins' } })
    fireEvent.click(screen.getByLabelText('Keep current reviewed banner'))
    fireEvent.click(screen.getByLabelText('Show reviewed photos for places mentioned in an answer'))
    fireEvent.click(screen.getByLabelText('Link photo credits to their approved source'))
    fireEvent.click(screen.getByRole('button', { name: 'Save guest design' }))
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        expectedUpdatedAt: initial.updatedAt,
        fields: {
          chatTheme: 'dark',
          chatAccentColor: '#ABCDEF',
          chatFont: 'poppins',
          chatShowPhotos: true,
          chatShowLinks: true,
          chatLogoUrl: initial.chatLogoUrl,
          chatBannerUrl: null,
        },
      }),
    )
    expect(await screen.findByText('Guest design saved.')).toBeTruthy()
    expect(screen.getByText('No reviewed banner is attached.')).toBeTruthy()
    expect(screen.queryByLabelText(/upload|asset URL/iu)).toBeNull()
  })

  it('fences same-tick duplicate saves and retains exact input for an ambiguous retry', async () => {
    const pending = deferred<typeof initial & { replayed: boolean }>()
    mocks.update
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ ...initial, replayed: true })
    render(<GuestDesignWorkspace tenantId="tenant-1" venueId="venue-1" initial={initial} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rose' }))
    const save = screen.getByRole('button', { name: 'Save guest design' })
    fireEvent.click(save)
    fireEvent.click(save)
    expect(mocks.update).toHaveBeenCalledTimes(1)
    await act(async () => pending.reject(new Error('Response unavailable')))
    expect(await screen.findByText('Response unavailable')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save guest design' }))
    expect(await screen.findByText('This exact design was already saved.')).toBeTruthy()
    expect(mocks.update.mock.calls.at(-1)![0].expectedUpdatedAt).toEqual(initial.updatedAt)
  })

  it('ignores a late save after exact venue scope changes and resets the lock', async () => {
    const pending = deferred<typeof initial & { replayed: boolean }>()
    mocks.update.mockReturnValueOnce(pending.promise)
    const view = render(
      <GuestDesignWorkspace tenantId="tenant-1" venueId="venue-1" initial={initial} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save guest design' }))
    const next = {
      ...initial,
      id: 'venue-2',
      name: 'History Center',
      aiGuideName: 'Archive Guide',
      updatedAt: new Date('2026-08-12T13:00:00.000Z'),
    }
    view.rerender(<GuestDesignWorkspace tenantId="tenant-1" venueId="venue-2" initial={next} />)
    await act(async () => pending.resolve({ ...initial, replayed: false }))
    expect(screen.getByText('Assistant name:', { exact: false }).textContent).toContain(
      'Archive Guide',
    )
    expect(screen.queryByText('Guest design saved.')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save guest design' })).toBeTruthy()
  })

  it('has no detectable accessibility violations in the responsive editor and preview', async () => {
    const { container } = render(
      <main>
        <GuestDesignWorkspace tenantId="tenant-1" venueId="venue-1" initial={initial} />
      </main>,
    )
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations).toEqual([])
  })

  it('labels the preview as non-literal and does not invent Guest prompts or welcome copy', () => {
    render(<GuestDesignWorkspace tenantId="tenant-1" venueId="venue-1" initial={initial} />)
    expect(screen.getByRole('heading', { name: 'Branding style preview' })).toBeTruthy()
    expect(
      screen.getByText(/Guest prompts and conversation content are intentionally not simulated/iu),
    ).toBeTruthy()
    expect(screen.queryByText('Welcome to Science Museum')).toBeNull()
    expect(screen.queryByText('What should I see?')).toBeNull()
    expect(screen.queryByText('Plan my visit')).toBeNull()
    expect(screen.queryByText('Ask anything about this place…')).toBeNull()
  })

  it('aborts an old branding page read when the venue scope changes', async () => {
    const pending = deferred<{ items: never[]; nextCursor: null }>()
    mocks.listAssets.mockReturnValueOnce(pending.promise)
    const view = render(
      <GuestDesignWorkspace
        tenantId="tenant-1"
        venueId="venue-1"
        initial={initial}
        initialBrandingAssets={{ items: [], nextCursor: '11111111-1111-4111-8111-111111111111' }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Load more reviewed assets' }))
    await waitFor(() => expect(mocks.listAssets).toHaveBeenCalled())
    const signal = mocks.listAssets.mock.calls[0]?.[1]?.signal as AbortSignal
    view.rerender(
      <GuestDesignWorkspace
        tenantId="tenant-1"
        venueId="venue-2"
        initial={{ ...initial, id: 'venue-2' }}
      />,
    )
    expect(signal.aborted).toBe(true)
    await act(async () => pending.reject(new Error('late old-scope failure')))
    expect(screen.queryByText(/late old-scope failure/i)).toBeNull()
  })
})
