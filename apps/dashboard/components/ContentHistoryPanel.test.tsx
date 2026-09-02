/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  listDeletedVenues: vi.fn(),
  listForVenue: vi.fn(),
  revert: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: mocks.push }),
}))

vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => ({
    contentHistory: {
      list: { query: mocks.list },
      listDeletedVenues: { query: mocks.listDeletedVenues },
      listForVenue: { query: mocks.listForVenue },
      revert: { mutate: mocks.revert },
    },
  }),
}))

import { ContentHistoryPanel } from './ContentHistoryPanel'
import { DeletedContentHistoryPanel } from './DeletedContentHistoryPanel'
import { DeletedVenueHistoryPanel } from './DeletedVenueHistoryPanel'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function codedError(code: string, message: string) {
  return Object.assign(new Error(message), { data: { code } })
}

const current = {
  id: '11111111-1111-4111-8111-111111111111',
  sequence: 2n,
  entityType: 'PLACE',
  entityId: 'place-1',
  operation: 'UPDATE',
  beforeState: { name: 'Original' },
  afterState: { name: 'Current' },
  actorId: 'manager-1',
  revertedFromId: null,
  createdAt: new Date('2026-08-08T12:00:00Z'),
}

const original = {
  ...current,
  id: '22222222-2222-4222-8222-222222222222',
  sequence: 1n,
  operation: 'CREATE',
  beforeState: null,
  afterState: { name: 'Original' },
}

const deletedPlace = {
  ...current,
  id: '33333333-3333-4333-8333-333333333333',
  sequence: 3n,
  operation: 'DELETE',
  beforeState: { name: 'Deleted place' },
  afterState: null,
  createdAt: new Date('2026-08-08T13:00:00Z'),
}

const deletedVenue = {
  ...current,
  id: '44444444-4444-4444-8444-444444444444',
  sequence: 4n,
  entityType: 'VENUE',
  entityId: 'venue-deleted',
  operation: 'DELETE',
  beforeState: { name: 'Deleted venue' },
  afterState: null,
  createdAt: new Date('2026-08-08T14:00:00Z'),
}

const restoredPlace = {
  ...deletedPlace,
  id: '77777777-7777-4777-8777-777777777777',
  sequence: 4n,
  operation: 'REVERT',
  beforeState: null,
  afterState: { name: 'Deleted place' },
  revertedFromId: deletedPlace.id,
  createdAt: new Date('2026-08-08T13:05:00Z'),
}

const restoredOriginal = {
  ...current,
  id: '55555555-5555-4555-8555-555555555555',
  sequence: 3n,
  operation: 'REVERT',
  revertedFromId: original.id,
  beforeState: { name: 'Current' },
  afterState: { name: 'Original' },
  createdAt: new Date('2026-08-08T12:05:00Z'),
}

function historyPage(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    ...current,
    id: `page-version-${index}`,
    sequence: BigInt(count - index + 10),
    beforeState: { name: `Before ${index}` },
    afterState: { name: `After ${index}` },
  }))
}

describe('content-history portal controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('opens history, renders a field diff, and shows a stale-revert conflict', async () => {
    mocks.list.mockResolvedValue([current, original])
    mocks.revert.mockRejectedValue(
      codedError('CONFLICT', 'A deliberately opaque production conflict.'),
    )
    render(<ContentHistoryPanel entityType="PLACE" entityId="place-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Show history' }))
    expect((await screen.findAllByText('name')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Current').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Original').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Restore this state' }))
    await waitFor(() =>
      expect(mocks.revert).toHaveBeenCalledWith({
        versionId: original.id,
        expectedCurrentVersionId: current.id,
      }),
    )
    expect((await screen.findByRole('alert')).textContent).toContain(
      'changed after this history view was loaded',
    )
    expect(screen.getByRole('button', { name: 'Reload history' })).toBeTruthy()
    expect(
      screen
        .getAllByRole('button', { name: 'Restore this state' })
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true)
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('restores a deleted place from the venue recovery surface', async () => {
    mocks.listForVenue.mockResolvedValue([deletedPlace])
    const pendingRestore = deferred<typeof restoredPlace>()
    mocks.revert.mockReturnValueOnce(pendingRestore.promise)
    render(<DeletedContentHistoryPanel venueId="venue-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Review deleted content' }))
    expect(await screen.findByText('Deleted place')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(() =>
      expect(mocks.revert).toHaveBeenCalledWith({
        versionId: deletedPlace.id,
        expectedCurrentVersionId: deletedPlace.id,
        snapshotSide: 'BEFORE',
      }),
    )
    const section = screen.getByRole('heading', { name: 'Deleted content' }).closest('section')
    expect(section?.getAttribute('aria-busy')).toBe('true')
    expect(
      (screen.getByRole('button', { name: 'Hide deleted content' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect((screen.getByRole('button', { name: 'Restoring…' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    pendingRestore.resolve(restoredPlace)
    expect(await screen.findByRole('status')).toBeTruthy()
    expect(mocks.listForVenue).toHaveBeenCalledTimes(2)
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('restores a deleted venue and navigates to the recovered route', async () => {
    mocks.listDeletedVenues.mockResolvedValue([deletedVenue])
    const pendingRestore = deferred<typeof restoredOriginal>()
    mocks.revert.mockReturnValueOnce(pendingRestore.promise)
    render(<DeletedVenueHistoryPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Review deleted chatbots' }))
    expect(await screen.findByText('Deleted venue')).toBeTruthy()
    const restore = screen.getByRole('button', { name: 'Restore' })
    act(() => {
      restore.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      restore.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(window.confirm).toHaveBeenCalledOnce()
    expect(mocks.revert).toHaveBeenCalledOnce()
    const section = screen.getByRole('heading', { name: 'Deleted chatbots' }).closest('section')
    expect(section?.getAttribute('aria-busy')).toBe('true')
    expect(
      (screen.getByRole('button', { name: 'Hide deleted chatbots' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect((screen.getByRole('button', { name: 'Restoring…' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    pendingRestore.resolve(restoredOriginal)
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/venues/venue-deleted'))
    expect(mocks.revert).toHaveBeenCalledWith({
      versionId: deletedVenue.id,
      expectedCurrentVersionId: deletedVenue.id,
      snapshotSide: 'BEFORE',
    })
    expect(await screen.findByRole('status')).toBeTruthy()
    expect(mocks.push).toHaveBeenCalledOnce()
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('admits one same-tick history load and locks its disclosure while pending', async () => {
    const pendingLoad = deferred<(typeof current)[]>()
    mocks.list.mockReturnValueOnce(pendingLoad.promise)
    render(<ContentHistoryPanel entityType="PLACE" entityId="place-1" />)
    const show = screen.getByRole('button', { name: 'Show history' })

    act(() => {
      show.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      show.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce())
    const section = screen.getByRole('heading', { name: 'Version history' }).closest('section')
    expect(section?.getAttribute('aria-busy')).toBe('true')
    expect(
      (screen.getByRole('button', { name: 'Hide history' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.getByText(/Loading history/)).toBeTruthy()

    pendingLoad.resolve([current])
    expect((await screen.findAllByText('Current')).length).toBeGreaterThan(0)
    expect(section?.getAttribute('aria-busy')).toBe('false')
  })

  it('confirms once, admits one restore, locks all actions, and refreshes successful history', async () => {
    const pendingRestore = deferred<typeof restoredOriginal>()
    mocks.list
      .mockResolvedValueOnce([current, original])
      .mockResolvedValueOnce([restoredOriginal, current])
    mocks.revert.mockReturnValueOnce(pendingRestore.promise)
    render(<ContentHistoryPanel entityType="PLACE" entityId="place-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Show history' }))
    const restore = await screen.findByRole('button', { name: 'Restore this state' })

    act(() => {
      restore.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      restore.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(window.confirm).toHaveBeenCalledOnce()
    expect(mocks.revert).toHaveBeenCalledOnce()
    const section = screen.getByRole('heading', { name: 'Version history' }).closest('section')
    expect(section?.getAttribute('aria-busy')).toBe('true')
    expect(
      (screen.getByRole('button', { name: 'Hide history' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect((screen.getByRole('button', { name: 'Restoring…' }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    pendingRestore.resolve(restoredOriginal)
    expect((await screen.findByRole('status')).textContent).toContain('Historical state restored.')
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(section?.getAttribute('aria-busy')).toBe('false')
  })

  it('prevents pagination, restore, and disclosure overlap under one load fence', async () => {
    const firstPage = historyPage(50)
    const older = deferred<(typeof current)[]>()
    mocks.list.mockResolvedValueOnce(firstPage).mockReturnValueOnce(older.promise)
    render(<ContentHistoryPanel entityType="PLACE" entityId="place-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Show history' }))
    const loadOlder = (await screen.findByRole('button', {
      name: 'Load older versions',
    })) as HTMLButtonElement
    const restore = screen.getAllByRole('button', {
      name: 'Restore this state',
    })[0] as HTMLButtonElement

    act(() => {
      loadOlder.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      loadOlder.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      restore.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
    expect(mocks.revert).not.toHaveBeenCalled()
    expect(window.confirm).not.toHaveBeenCalled()
    expect(loadOlder.disabled).toBe(true)
    expect(restore.disabled).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Hide history' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      screen
        .getByRole('heading', { name: 'Version history' })
        .closest('section')
        ?.getAttribute('aria-busy'),
    ).toBe('true')

    older.resolve([firstPage.at(-1)!])
    await act(async () => older.promise)
    expect(screen.getAllByText('After 49')).toHaveLength(1)
  })

  it('ignores an immediately resolved old entity load after rerender', async () => {
    const oldLoad = deferred<(typeof current)[]>()
    const newVersion = {
      ...current,
      id: '66666666-6666-4666-8666-666666666666',
      entityId: 'place-2',
      afterState: { name: 'Second entity' },
    }
    mocks.list.mockReturnValueOnce(oldLoad.promise).mockResolvedValueOnce([newVersion])
    const view = render(<ContentHistoryPanel entityType="PLACE" entityId="place-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Show history' }))
    await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce())
    const oldRequestOptions = mocks.list.mock.calls[0]?.[1] as { signal?: AbortSignal }
    expect(oldRequestOptions.signal).toBeInstanceOf(AbortSignal)
    expect(oldRequestOptions.signal?.aborted).toBe(false)

    view.rerender(<ContentHistoryPanel entityType="PLACE" entityId="place-2" />)
    expect(oldRequestOptions.signal?.aborted).toBe(true)
    oldLoad.resolve([current])
    await act(async () => oldLoad.promise)
    expect(screen.getByRole('button', { name: 'Show history' })).toBeTruthy()
    expect(screen.queryByText('Current')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Show history' }))
    expect(await screen.findByText('Second entity')).toBeTruthy()
    expect(mocks.list).toHaveBeenLastCalledWith(
      {
        entityType: 'PLACE',
        entityId: 'place-2',
        limit: 50,
      },
      { signal: expect.any(AbortSignal) },
    )
  })

  it('ignores an immediately resolved old deleted-content load after venue rerender', async () => {
    const oldLoad = deferred<(typeof deletedPlace)[]>()
    mocks.listForVenue.mockReturnValueOnce(oldLoad.promise).mockResolvedValueOnce([])
    const view = render(<DeletedContentHistoryPanel venueId="venue-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Review deleted content' }))
    await waitFor(() => expect(mocks.listForVenue).toHaveBeenCalledOnce())

    view.rerender(<DeletedContentHistoryPanel venueId="venue-2" />)
    oldLoad.resolve([deletedPlace])
    await act(async () => oldLoad.promise)
    expect(screen.getByRole('button', { name: 'Review deleted content' })).toBeTruthy()
    expect(screen.queryByText('Deleted place')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Review deleted content' }))
    expect(await screen.findByText('No deleted content in loaded history.')).toBeTruthy()
    expect(mocks.listForVenue).toHaveBeenLastCalledWith({ venueId: 'venue-2', limit: 100 })
  })

  it('suppresses follow-up history and router refresh when content restore completes after unmount', async () => {
    const pendingRestore = deferred<void>()
    mocks.list.mockResolvedValueOnce([current, original])
    mocks.revert.mockReturnValueOnce(pendingRestore.promise)
    const view = render(<ContentHistoryPanel entityType="PLACE" entityId="place-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Show history' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Restore this state' }))
    await waitFor(() => expect(mocks.revert).toHaveBeenCalledOnce())
    view.unmount()

    pendingRestore.resolve(undefined)
    await act(async () => pendingRestore.promise)
    expect(mocks.list).toHaveBeenCalledOnce()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('suppresses late deleted-venue navigation and refresh after unmount', async () => {
    const pendingRestore = deferred<void>()
    mocks.listDeletedVenues.mockResolvedValueOnce([deletedVenue])
    mocks.revert.mockReturnValueOnce(pendingRestore.promise)
    const view = render(<DeletedVenueHistoryPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Review deleted chatbots' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(mocks.revert).toHaveBeenCalledOnce())
    view.unmount()

    pendingRestore.resolve(undefined)
    await act(async () => pendingRestore.promise)
    expect(mocks.push).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('does not infer a conflict from message-like generic restore failure', async () => {
    mocks.listForVenue.mockResolvedValueOnce([deletedPlace])
    mocks.revert.mockRejectedValueOnce(
      new Error('Deleted content changed; this message only resembles a conflict.'),
    )
    render(<DeletedContentHistoryPanel venueId="venue-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Review deleted content' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))

    expect((await screen.findByRole('alert')).textContent).toContain(
      'restore outcome could not be confirmed',
    )
    expect(screen.getByRole('button', { name: 'Reload deleted content' })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Restore' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('reports completed content restore without inviting a duplicate after follow-up history fails', async () => {
    mocks.list
      .mockResolvedValueOnce([current, original])
      .mockRejectedValueOnce(new Error('History unavailable'))
    mocks.revert.mockResolvedValueOnce(restoredOriginal)
    render(<ContentHistoryPanel entityType="PLACE" entityId="place-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Show history' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Restore this state' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('historical state was restored')
    expect(alert.textContent).toContain('Do not repeat the restore')
    expect(screen.getByText(/REVERT · revision 3/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reload history' })).toBeTruthy()
    expect(
      screen
        .getAllByRole('button', { name: 'Restore this state' })
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true)
    expect(mocks.revert).toHaveBeenCalledOnce()
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('reports completed deleted-content restore without inviting a duplicate after refresh fails', async () => {
    mocks.listForVenue
      .mockResolvedValueOnce([deletedPlace])
      .mockRejectedValueOnce(new Error('History unavailable'))
    mocks.revert.mockResolvedValueOnce(restoredPlace)
    render(<DeletedContentHistoryPanel venueId="venue-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Review deleted content' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('content was restored')
    expect(alert.textContent).toContain('Do not repeat the restore')
    expect(screen.getByRole('button', { name: 'Reload deleted content' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull()
    expect(mocks.revert).toHaveBeenCalledOnce()
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('releases the restore fence after cancellation so a later confirmation can proceed', async () => {
    vi.mocked(window.confirm).mockReturnValueOnce(false).mockReturnValueOnce(true)
    mocks.list.mockResolvedValue([current, original])
    mocks.revert.mockResolvedValueOnce(restoredOriginal)
    render(<ContentHistoryPanel entityType="PLACE" entityId="place-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Show history' }))
    const restore = await screen.findByRole('button', { name: 'Restore this state' })

    fireEvent.click(restore)
    expect(mocks.revert).not.toHaveBeenCalled()
    expect(
      screen
        .getByRole('heading', { name: 'Version history' })
        .closest('section')
        ?.getAttribute('aria-busy'),
    ).toBe('false')
    expect(
      (screen.getByRole('button', { name: 'Restore this state' }) as HTMLButtonElement).disabled,
    ).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Restore this state' }))
    expect(await screen.findByRole('status')).toBeTruthy()
    expect(window.confirm).toHaveBeenCalledTimes(2)
    expect(mocks.revert).toHaveBeenCalledOnce()
  })
})
