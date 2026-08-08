/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  publish: vi.fn(),
  deactivate: vi.fn(),
  list: vi.fn(),
  placeList: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}))

vi.mock('../lib/trpc', () => ({
  createTRPCClient: () => ({
    place: { list: { query: mocks.placeList } },
    operationalUpdate: {
      create: { mutate: mocks.create },
      update: { mutate: mocks.update },
      publish: { mutate: mocks.publish },
      deactivate: { mutate: mocks.deactivate },
      list: { query: mocks.list },
    },
  }),
}))

vi.mock('./ContentHistoryPanel', () => ({
  ContentHistoryPanel: ({ entityId }: { entityId: string }) => <div>History {entityId}</div>,
}))

import { OperationalUpdateForm } from './OperationalUpdateForm'
import { OperationalUpdatesList } from './OperationalUpdatesList'

const base = {
  id: 'update-current',
  venueId: 'venue-1',
  placeId: null,
  updateType: 'MAINTENANCE',
  priority: 'NORMAL' as const,
  status: 'PUBLISHED' as const,
  title: 'Maintenance window',
  body: 'The east entrance is temporarily unavailable.',
  redirectTo: null,
  startsAt: '2026-08-08T11:00:00.000Z',
  expiresAt: '2026-08-08T13:00:00.000Z',
  isActive: true,
  createdBy: 'manager-1',
  publishedBy: 'manager-1',
  publishedAt: '2026-08-08T10:00:00.000Z',
  createdAt: '2026-08-08T10:00:00.000Z',
  updatedAt: '2026-08-08T10:00:00.000Z',
  venue: { id: 'venue-1', name: 'City Museum' },
  place: null,
}

describe('operational-update management', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-08-08T12:00:00.000Z'))
    mocks.placeList.mockResolvedValue([{ id: 'place-1', name: 'East Gallery' }])
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('loads venue-dependent places and publishes a newly saved draft', async () => {
    mocks.create.mockResolvedValue({ id: 'update-1', updatedAt: new Date('2026-08-08T12:01:00Z') })

    render(<OperationalUpdateForm venues={[{ id: 'venue-1', name: 'City Museum' }]} />)
    expect(await screen.findByRole('option', { name: 'East Gallery' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Affected location or exhibit'), {
      target: { value: 'place-1' },
    })
    fireEvent.change(screen.getByLabelText('Update type'), { target: { value: 'SPECIAL_EVENT' } })
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'HIGH' } })
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Evening program' } })
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'venue-1',
        placeId: 'place-1',
        updateType: 'SPECIAL_EVENT',
        severity: 'INFO',
        priority: 'HIGH',
        title: 'Evening program',
        publish: true,
        startsAt: expect.any(Date),
        expiresAt: expect.any(Date),
      }),
    )
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(mocks.push).toHaveBeenCalledWith('/operational-updates')
  })

  it('creates an unpublished draft from the same form', async () => {
    mocks.create.mockResolvedValue({
      id: 'draft-1',
      updatedAt: new Date('2026-08-08T12:01:00Z'),
    })
    render(<OperationalUpdateForm venues={[{ id: 'venue-1', name: 'City Museum' }]} />)
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Review me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ publish: false })),
    )
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('uses optimistic concurrency when updating a draft', async () => {
    mocks.update.mockRejectedValue(new Error('Draft changed in another session'))
    render(
      <OperationalUpdateForm
        venues={[{ id: 'venue-1', name: 'City Museum' }]}
        initialUpdate={{
          id: 'draft-1',
          venueId: 'venue-1',
          placeId: null,
          updateType: 'CHANGED_HOURS',
          priority: 'NORMAL',
          title: 'Hours',
          body: null,
          redirectTo: null,
          startsAt: '2026-08-08T13:00:00Z',
          expiresAt: '2026-08-08T17:00:00Z',
          updatedAt: '2026-08-08T11:45:00Z',
        }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'draft-1',
          expectedUpdatedAt: new Date('2026-08-08T11:45:00Z'),
        }),
      ),
    )
    expect((await screen.findByRole('alert')).textContent).toContain('Reload this draft')
  })

  it('updates and publishes an edited draft atomically', async () => {
    mocks.update.mockResolvedValue({})
    render(
      <OperationalUpdateForm
        venues={[{ id: 'venue-1', name: 'City Museum' }]}
        initialUpdate={{
          id: 'draft-1',
          venueId: 'venue-1',
          placeId: null,
          updateType: 'CHANGED_HOURS',
          priority: 'HIGH',
          title: 'Hours',
          body: null,
          redirectTo: null,
          startsAt: '2026-08-08T13:00:00Z',
          expiresAt: '2026-08-08T17:00:00Z',
          updatedAt: '2026-08-08T11:45:00Z',
        }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'draft-1',
          publish: true,
          expectedUpdatedAt: new Date('2026-08-08T11:45:00Z'),
        }),
      ),
    )
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('groups every lifecycle state and refreshes after a publish conflict', async () => {
    const rows = [
      { ...base, id: 'draft', status: 'DRAFT' as const, title: 'Draft item' },
      { ...base, id: 'scheduled', startsAt: '2026-08-08T13:00:00Z', title: 'Scheduled item' },
      { ...base, id: 'current', title: 'Current item' },
      { ...base, id: 'past', isActive: false, title: 'Past item' },
    ]
    mocks.publish.mockRejectedValue(new Error('Update changed since it was loaded'))
    mocks.list.mockResolvedValue(
      rows.map((row) => ({
        ...row,
        startsAt: new Date(row.startsAt),
        expiresAt: new Date(row.expiresAt),
        publishedAt: row.publishedAt ? new Date(row.publishedAt) : null,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      })),
    )
    render(<OperationalUpdatesList initialUpdates={rows} />)

    for (const [section, title] of [
      ['Draft', 'Draft item'],
      ['Scheduled', 'Scheduled item'],
      ['Current', 'Current item'],
      ['Past', 'Past item'],
    ] as const) {
      expect(within(screen.getByRole('region', { name: section })).getByText(title)).toBeTruthy()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    await waitFor(() =>
      expect(mocks.publish).toHaveBeenCalledWith({
        id: 'draft',
        expectedUpdatedAt: new Date(base.updatedAt),
      }),
    )
    expect(mocks.list).toHaveBeenCalledOnce()
    expect((await screen.findByRole('alert')).textContent).toContain('list was refreshed')
  })
})
