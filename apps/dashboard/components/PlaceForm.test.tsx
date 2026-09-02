/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  getById: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  client: {
    place: {
      create: { mutate: vi.fn() },
      update: { mutate: vi.fn() },
      delete: { mutate: vi.fn() },
      getById: { query: vi.fn() },
    },
  },
}))

mocks.client.place.create.mutate = mocks.create
mocks.client.place.update.mutate = mocks.update
mocks.client.place.delete.mutate = mocks.remove
mocks.client.place.getById.query = mocks.getById

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}))
vi.mock('../lib/trpc', () => ({ useTRPCClient: () => mocks.client }))

import { PlaceForm } from './PlaceForm'

const venueId = 'cm00000000000000000000001'
const placeId = 'cm00000000000000000000002'
const expectedUpdatedAt = new Date('2026-08-11T14:30:00.000Z')

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return { promise, reject, resolve }
}

describe('PlaceForm', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('requires deliberate coordinates for a location-aware item, then sends exact values', async () => {
    mocks.create.mockResolvedValueOnce({ id: placeId })
    render(<PlaceForm mode="create" venueId={venueId} venueGuideMode="location_aware" />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Main Gallery' } })
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'exhibit' } })
    expect((screen.getByLabelText('Latitude') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Longitude') as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Add guide item' }))

    expect(
      await screen.findByText('Latitude and longitude are required for location-aware venues.'),
    ).toBeTruthy()
    expect(mocks.create).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Latitude'), { target: { value: '41.5' } })
    fireEvent.change(screen.getByLabelText('Longitude'), { target: { value: '-81.7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add guide item' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId,
        name: 'Main Gallery',
        type: 'exhibit',
        lat: 41.5,
        lng: -81.7,
      }),
    )
    expect(mocks.push).toHaveBeenCalledWith(`/venues/${venueId}`)
  })

  it('derives the non-location type and normalizes optional content', async () => {
    mocks.create.mockResolvedValueOnce({ id: placeId })
    render(<PlaceForm mode="create" venueId={venueId} venueGuideMode="non_location" />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Refund policy' } })
    fireEvent.change(screen.getByLabelText('Item type (optional)'), {
      target: { value: 'policy' },
    })
    fireEvent.change(screen.getByLabelText('Short description'), {
      target: { value: '  Ask the front desk.  ' },
    })
    fireEvent.change(screen.getByLabelText('Latitude (optional)'), {
      target: { value: '40.1' },
    })
    fireEvent.change(screen.getByLabelText('Longitude (optional)'), {
      target: { value: '-80.2' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add guide item' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId,
        name: 'Refund policy',
        type: 'policy',
        itemType: 'policy',
        shortDescription: 'Ask the front desk.',
        lat: 40.1,
        lng: -80.2,
      }),
    )
  })

  it('admits one same-tick save and locks every editable surface while pending', async () => {
    const pendingCreate = deferred<{ id: string }>()
    mocks.create.mockReturnValueOnce(pendingCreate.promise)
    render(<PlaceForm mode="create" venueId={venueId} venueGuideMode="non_location" />)

    const nameInput = screen.getByLabelText('Name') as HTMLInputElement
    const submitButton = screen.getByRole('button', { name: 'Add guide item' })
    const form = submitButton.closest('form') as HTMLFormElement
    fireEvent.change(nameInput, { target: { value: 'Visitor policy' } })

    fireEvent.submit(form)
    fireEvent.submit(form)

    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
    expect(form.getAttribute('aria-busy')).toBe('true')
    expect(nameInput.disabled).toBe(true)
    expect((screen.getByLabelText('Item type (optional)') as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByLabelText('Short description') as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByLabelText('Latitude (optional)') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('Longitude (optional)') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('Long description') as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByLabelText('Tags') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('Importance score') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('Area name') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('Hours') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('Photo URL') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('Guide item is active') as HTMLInputElement).disabled).toBe(true)
    expect(
      screen.getByText('Advanced options').closest('summary')?.getAttribute('aria-disabled'),
    ).toBe('true')
    expect((screen.getByRole('button', { name: 'Saving...' }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    await act(async () => pendingCreate.resolve({ id: placeId }))
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(`/venues/${venueId}`))
  })

  it('maps edit-only null and activity semantics while preserving state on failure', async () => {
    const pendingUpdate = deferred<{ id: string }>()
    mocks.update.mockReturnValueOnce(pendingUpdate.promise)
    render(
      <PlaceForm
        mode="edit"
        venueId={venueId}
        venueGuideMode="non_location"
        placeId={placeId}
        expectedUpdatedAt={expectedUpdatedAt}
        initialValues={{
          id: placeId,
          venueId,
          name: 'FAQ',
          type: 'faq',
          itemType: 'faq',
          shortDescription: 'Original',
          longDescription: '',
          lat: undefined,
          lng: undefined,
          tags: [],
          importanceScore: 0,
          areaName: '',
          hours: '',
          photoUrl: '',
          isActive: false,
        }}
      />,
    )

    fireEvent.change(screen.getByLabelText('Short description'), {
      target: { value: 'Revised answer' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce())
    expect((screen.getByRole('button', { name: 'Saving...' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByLabelText('Short description') as HTMLTextAreaElement).disabled).toBe(true)
    await act(async () => pendingUpdate.reject(new Error('Guide item changed in another session')))
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: placeId,
        venueId,
        expectedUpdatedAt,
        type: 'faq',
        itemType: 'faq',
        shortDescription: 'Revised answer',
        photoUrl: null,
        isActive: false,
      }),
    )
    expect(await screen.findByText('Guide item changed in another session')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Guide item changed in another session')
    expect(
      screen
        .getByRole('button', { name: 'Save changes' })
        .closest('form')
        ?.getAttribute('aria-busy'),
    ).toBe('false')
    expect((screen.getByLabelText('Short description') as HTMLTextAreaElement).value).toBe(
      'Revised answer',
    )
    expect(mocks.push).not.toHaveBeenCalled()

    mocks.update.mockResolvedValueOnce({ id: placeId })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2))
    expect(mocks.push).toHaveBeenCalledWith(`/venues/${venueId}`)
  })

  it('prevents save/delete overlap and duplicate deletion while a delete is pending', async () => {
    const pendingDelete = deferred<{ id: string }>()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mocks.remove.mockReturnValueOnce(pendingDelete.promise)
    render(
      <PlaceForm
        mode="edit"
        venueId={venueId}
        venueGuideMode="non_location"
        placeId={placeId}
        expectedUpdatedAt={expectedUpdatedAt}
        initialValues={{
          id: placeId,
          venueId,
          name: 'FAQ',
          type: 'faq',
          itemType: 'faq',
          shortDescription: '',
          longDescription: '',
          lat: undefined,
          lng: undefined,
          tags: [],
          importanceScore: 0,
          areaName: '',
          hours: '',
          photoUrl: '',
          isActive: true,
        }}
      />,
    )

    const deleteButton = screen.getByRole('button', { name: 'Delete guide item' })
    fireEvent.click(deleteButton)
    fireEvent.click(deleteButton)
    fireEvent.submit(deleteButton.closest('form') as HTMLFormElement)

    await waitFor(() => expect(mocks.remove).toHaveBeenCalledOnce())
    expect(mocks.remove).toHaveBeenCalledWith({ id: placeId, venueId, expectedUpdatedAt })
    expect(mocks.update).not.toHaveBeenCalled()
    expect(
      (screen.getByRole('button', { name: 'Deleting...' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled,
    ).toBe(true)

    await act(async () => pendingDelete.resolve({ id: placeId }))
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(`/venues/${venueId}`))
  })

  it('does not navigate or update UI when a save completes after unmount', async () => {
    const pendingCreate = deferred<{ id: string }>()
    mocks.create.mockReturnValueOnce(pendingCreate.promise)
    const view = render(<PlaceForm mode="create" venueId={venueId} venueGuideMode="non_location" />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Visitor policy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add guide item' }))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
    view.unmount()

    await act(async () => pendingCreate.resolve({ id: placeId }))

    expect(mocks.push).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('does not navigate or update UI when deletion completes after unmount', async () => {
    const pendingDelete = deferred<{ id: string }>()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mocks.remove.mockReturnValueOnce(pendingDelete.promise)
    const view = render(
      <PlaceForm
        mode="edit"
        venueId={venueId}
        venueGuideMode="non_location"
        placeId={placeId}
        expectedUpdatedAt={expectedUpdatedAt}
        initialValues={{
          id: placeId,
          venueId,
          name: 'FAQ',
          type: 'faq',
          itemType: 'faq',
          shortDescription: '',
          longDescription: '',
          lat: undefined,
          lng: undefined,
          tags: [],
          importanceScore: 0,
          areaName: '',
          hours: '',
          photoUrl: '',
          isActive: true,
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete guide item' }))
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledOnce())
    view.unmount()

    await act(async () => pendingDelete.resolve({ id: placeId }))

    expect(mocks.push).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('does not delete when confirmation is declined', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(
      <PlaceForm
        mode="edit"
        venueId={venueId}
        venueGuideMode="non_location"
        placeId={placeId}
        expectedUpdatedAt={expectedUpdatedAt}
        initialValues={{
          id: placeId,
          venueId,
          name: 'FAQ',
          type: 'faq',
          itemType: 'faq',
          shortDescription: '',
          longDescription: '',
          lat: undefined,
          lng: undefined,
          tags: [],
          importanceScore: 0,
          areaName: '',
          hours: '',
          photoUrl: '',
          isActive: true,
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete guide item' }))

    expect(confirm).toHaveBeenCalledWith('Delete this guide item? This cannot be undone.')
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it('bounds the edit load and aborts it when the form unmounts', async () => {
    const pendingLoad = deferred<never>()
    mocks.getById.mockReturnValueOnce(pendingLoad.promise)
    const view = render(
      <PlaceForm mode="edit" venueId={venueId} venueGuideMode="location_aware" placeId={placeId} />,
    )

    await waitFor(() => expect(mocks.getById).toHaveBeenCalledOnce())
    const requestOptions = mocks.getById.mock.calls[0]?.[1] as { signal?: AbortSignal }
    expect(requestOptions.signal).toBeInstanceOf(AbortSignal)
    expect(requestOptions.signal?.aborted).toBe(false)

    view.unmount()

    expect(requestOptions.signal?.aborted).toBe(true)
  })
})
