/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  createTRPCClient: () => ({
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
      new Error('Content changed after this history view was loaded; refresh and try again'),
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
    expect(
      await screen.findByText(
        'Content changed after this history view was loaded; refresh and try again',
      ),
    ).toBeTruthy()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('restores a deleted place from the venue recovery surface', async () => {
    const deleted = {
      ...current,
      id: '33333333-3333-4333-8333-333333333333',
      sequence: 3n,
      operation: 'DELETE',
      beforeState: { name: 'Deleted place' },
      afterState: null,
      createdAt: new Date('2026-08-08T13:00:00Z'),
    }
    mocks.listForVenue.mockResolvedValue([deleted])
    mocks.revert.mockResolvedValue(undefined)
    render(<DeletedContentHistoryPanel venueId="venue-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Review deleted content' }))
    expect(await screen.findByText('Deleted place')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(() =>
      expect(mocks.revert).toHaveBeenCalledWith({
        versionId: deleted.id,
        expectedCurrentVersionId: deleted.id,
        snapshotSide: 'BEFORE',
      }),
    )
    expect(mocks.refresh).toHaveBeenCalled()
  })

  it('restores a deleted venue and navigates to the recovered route', async () => {
    const deleted = {
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
    mocks.listDeletedVenues.mockResolvedValue([deleted])
    mocks.revert.mockResolvedValue(undefined)
    render(<DeletedVenueHistoryPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Review deleted chatbots' }))
    expect(await screen.findByText('Deleted venue')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/venues/venue-deleted'))
    expect(mocks.revert).toHaveBeenCalledWith({
      versionId: deleted.id,
      expectedCurrentVersionId: deleted.id,
      snapshotSide: 'BEFORE',
    })
  })
})
