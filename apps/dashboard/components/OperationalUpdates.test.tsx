/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  useTRPCClient: () => ({
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function serializedRows<
  T extends {
    startsAt: string
    expiresAt: string
    publishedAt: string | null
    createdAt: string
    updatedAt: string
  },
>(rows: T[]) {
  return rows.map((row) => ({
    ...row,
    startsAt: new Date(row.startsAt),
    expiresAt: new Date(row.expiresAt),
    publishedAt: row.publishedAt ? new Date(row.publishedAt) : null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  }))
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
    mocks.update.mockRejectedValue({ data: { code: 'CONFLICT' } })
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
    expect((await screen.findByRole('alert')).textContent).toContain(
      'changed in another session. Reload this draft',
    )
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

  it('synchronously fences draft/publish overlap and locks every form control', async () => {
    const pending = deferred<{ id: string; updatedAt: Date }>()
    mocks.create.mockReturnValueOnce(pending.promise)
    render(<OperationalUpdateForm venues={[{ id: 'venue-1', name: 'City Museum' }]} />)
    await screen.findByRole('option', { name: 'East Gallery' })
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'One notice' } })

    const publish = screen.getByRole('button', { name: 'Publish' })
    const form = publish.closest('form')!
    act(() => {
      publish.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(mocks.create).toHaveBeenCalledOnce()
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ publish: true }))
    expect(form.getAttribute('aria-busy')).toBe('true')
    expect(
      [...form.querySelectorAll('button, input, select, textarea')].every(
        (control) =>
          (
            control as
              | HTMLButtonElement
              | HTMLInputElement
              | HTMLSelectElement
              | HTMLTextAreaElement
          ).disabled,
      ),
    ).toBe(true)

    pending.resolve({ id: 'update-1', updatedAt: new Date('2026-08-08T12:01:00Z') })
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/operational-updates'))
  })

  it('retains a failed form draft, unlocks it, and permits transport retry', async () => {
    mocks.create
      .mockRejectedValueOnce(new Error('Transport failed'))
      .mockResolvedValueOnce({ id: 'update-1', updatedAt: new Date('2026-08-08T12:01:00Z') })
    render(<OperationalUpdateForm venues={[{ id: 'venue-1', name: 'City Museum' }]} />)
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Retry this notice' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Transport failed')
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Save status may be unknown; check the updates list',
    )
    expect(screen.getByDisplayValue('Retry this notice')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).disabled).toBe(
      false,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2))
  })

  it('suppresses late form navigation after unmount', async () => {
    const pending = deferred<{ id: string; updatedAt: Date }>()
    mocks.create.mockReturnValueOnce(pending.promise)
    const view = render(<OperationalUpdateForm venues={[{ id: 'venue-1', name: 'City Museum' }]} />)
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Leaving now' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))

    view.unmount()
    pending.resolve({ id: 'update-1', updatedAt: new Date('2026-08-08T12:01:00Z') })
    await act(async () => pending.promise)
    expect(mocks.push).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('groups every lifecycle state and refreshes after a publish conflict', async () => {
    const rows = [
      { ...base, id: 'draft', status: 'DRAFT' as const, title: 'Draft item' },
      { ...base, id: 'scheduled', startsAt: '2026-08-08T13:00:00Z', title: 'Scheduled item' },
      { ...base, id: 'current', title: 'Current item' },
      { ...base, id: 'past', isActive: false, title: 'Past item' },
    ]
    mocks.publish.mockRejectedValue({ data: { code: 'CONFLICT' } })
    mocks.list.mockResolvedValue(serializedRows(rows))
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

  it('does not invite a repeated action when mutation succeeds but refresh fails', async () => {
    const rows = [{ ...base, id: 'draft', status: 'DRAFT' as const, title: 'Draft item' }]
    mocks.publish.mockResolvedValueOnce(undefined)
    mocks.list.mockRejectedValueOnce(new Error('List unavailable'))
    render(<OperationalUpdatesList initialUpdates={rows} />)

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('action succeeded')
    expect(alert.textContent).toContain('do not repeat the action')
    expect(mocks.publish).toHaveBeenCalledOnce()
  })

  it('does not claim a refreshed list when conflict recovery also fails', async () => {
    const rows = [{ ...base, id: 'draft', status: 'DRAFT' as const, title: 'Draft item' }]
    mocks.publish.mockRejectedValueOnce({ data: { code: 'CONFLICT' } })
    mocks.list.mockRejectedValueOnce(new Error('List unavailable'))
    render(<OperationalUpdatesList initialUpdates={rows} />)

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('current list could not be refreshed')
    expect(alert.textContent).not.toContain('The list was refreshed')
  })

  it('serializes list actions globally before rerender and locks every lifecycle control', async () => {
    const rows = [
      { ...base, id: 'draft', status: 'DRAFT' as const, title: 'Draft item' },
      { ...base, id: 'current', title: 'Current item' },
    ]
    const pending = deferred<undefined>()
    mocks.publish.mockReturnValueOnce(pending.promise)
    mocks.list.mockResolvedValue(serializedRows(rows))
    render(<OperationalUpdatesList initialUpdates={rows} />)

    const publish = screen.getByRole('button', { name: 'Publish' })
    const deactivate = screen.getByRole('button', { name: 'Deactivate' })
    act(() => {
      publish.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      deactivate.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.publish).toHaveBeenCalledOnce()
    expect(mocks.deactivate).not.toHaveBeenCalled()
    expect(
      screen
        .getAllByRole('button', { name: /^(Publishing\.\.\.|Deactivate)$/ })
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true)

    pending.resolve(undefined)
    await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce())
  })

  it('suppresses list recovery and refresh after unmount', async () => {
    const rows = [{ ...base, id: 'draft', status: 'DRAFT' as const, title: 'Draft item' }]
    const pending = deferred<undefined>()
    mocks.publish.mockReturnValueOnce(pending.promise)
    const view = render(<OperationalUpdatesList initialUpdates={rows} />)

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    view.unmount()
    pending.resolve(undefined)
    await act(async () => pending.promise)

    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })
})
