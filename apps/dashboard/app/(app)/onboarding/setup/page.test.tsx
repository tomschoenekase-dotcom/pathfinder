/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  createVenue: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  client: {
    venue: { create: { mutate: vi.fn() } },
  },
}))

mocks.client.venue.create.mutate = mocks.createVenue

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}))

vi.mock('../../../../lib/trpc', () => ({
  useTRPCClient: () => mocks.client,
}))

import OnboardingSetupPage from './page'

function fillVenueBasics(guideMode: 'location_aware' | 'non_location') {
  fireEvent.change(screen.getByLabelText('Venue name'), { target: { value: 'Harbor Museum' } })
  fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'harbor-museum' } })
  fireEvent.change(screen.getByLabelText('Venue category (optional)'), {
    target: { value: ' museum ' },
  })
  fireEvent.click(
    screen.getByRole('radio', {
      name: guideMode === 'location_aware' ? /On-site guide/ : /Guide without visitor location/,
    }),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
}

function fillFirstItem(name: string, description: string) {
  fireEvent.change(screen.getByLabelText('Guide item name'), { target: { value: name } })
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'OTHER' } })
  fireEvent.change(screen.getByLabelText('Brief description'), {
    target: { value: description },
  })
}

describe('mode-aware onboarding setup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createVenue.mockResolvedValue({ id: 'venue-created' })
  })

  afterEach(cleanup)

  it('skips location and atomically submits one no-location venue mutation', async () => {
    render(<OnboardingSetupPage />)

    fillVenueBasics('non_location')
    expect(await screen.findByText('Add your first guide item')).toBeTruthy()
    expect(screen.queryByText('Set your location')).toBeNull()
    expect(screen.getByText(/Step 2 of 3/)).toBeTruthy()

    fillFirstItem('Visitor policy', 'General visitor information.')
    fireEvent.click(screen.getByRole('button', { name: 'Create venue' }))

    await waitFor(() => expect(mocks.createVenue).toHaveBeenCalledOnce())
    expect(mocks.createVenue).toHaveBeenCalledWith({
      name: 'Harbor Museum',
      slug: 'harbor-museum',
      category: 'museum',
      guideMode: 'non_location',
      initialGuideItem: {
        name: 'Visitor policy',
        type: 'OTHER',
        shortDescription: 'General visitor information.',
        tags: [],
        importanceScore: 0,
      },
    })
    expect(await screen.findByText('Your venue setup is ready for review.')).toBeTruthy()
    expect(screen.queryByText(/Your venue is live/i)).toBeNull()
  })

  it('requires deliberate coordinates for an on-site guide and submits them once', async () => {
    render(<OnboardingSetupPage />)

    fillVenueBasics('location_aware')
    expect(await screen.findByText('Set your location')).toBeTruthy()
    expect((screen.getByLabelText('Center latitude') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Center longitude') as HTMLInputElement).value).toBe('')

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findAllByText(/Required|expected number/i)).toHaveLength(2)
    expect(mocks.createVenue).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Center latitude'), { target: { value: '40.7' } })
    fireEvent.change(screen.getByLabelText('Center longitude'), { target: { value: '-74' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Add your central starting point')).toBeTruthy()

    fillFirstItem('Main entrance', 'The central visitor entrance.')
    fireEvent.click(screen.getByRole('button', { name: 'Create venue' }))

    await waitFor(() => expect(mocks.createVenue).toHaveBeenCalledOnce())
    expect(mocks.createVenue).toHaveBeenCalledWith(
      expect.objectContaining({
        guideMode: 'location_aware',
        defaultCenterLat: 40.7,
        defaultCenterLng: -74,
        initialGuideItem: expect.objectContaining({ name: 'Main entrance' }),
      }),
    )
  })

  it('preserves unsaved navigation state and resets the item when location mode changes', async () => {
    const view = render(<OnboardingSetupPage />)

    fillVenueBasics('non_location')
    expect(await screen.findByText('Add your first guide item')).toBeTruthy()
    fillFirstItem('Visitor policy', 'General visitor information.')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(
      (
        (await screen.findByRole('radio', {
          name: /Guide without visitor location/,
        })) as HTMLInputElement
      ).checked,
    ).toBe(true)
    expect((screen.getByLabelText('Venue name') as HTMLInputElement).value).toBe('Harbor Museum')

    fireEvent.click(screen.getByRole('radio', { name: /On-site guide/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Set your location')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Center latitude'), { target: { value: '40.7' } })
    fireEvent.change(screen.getByLabelText('Center longitude'), { target: { value: '-74' } })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    expect(((await screen.findByLabelText('Center latitude')) as HTMLInputElement).value).toBe(
      '40.7',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Add your central starting point')).toBeTruthy()
    expect((screen.getByLabelText('Guide item name') as HTMLInputElement).value).toBe('')
    fillFirstItem('Main entrance', 'The central visitor entrance.')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(((await screen.findByLabelText('Center latitude')) as HTMLInputElement).value).toBe(
      '40.7',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(((await screen.findByLabelText('Guide item name')) as HTMLInputElement).value).toBe(
      'Main entrance',
    )

    view.unmount()
  })

  it('retains the first item and shows the error when the atomic mutation fails', async () => {
    mocks.createVenue.mockRejectedValueOnce(new Error('Setup could not be saved'))
    render(<OnboardingSetupPage />)

    fillVenueBasics('non_location')
    await screen.findByText('Add your first guide item')
    fillFirstItem('Visitor policy', 'General visitor information.')
    fireEvent.click(screen.getByRole('button', { name: 'Create venue' }))

    expect(await screen.findByText('Setup could not be saved')).toBeTruthy()
    expect((screen.getByLabelText('Guide item name') as HTMLInputElement).value).toBe(
      'Visitor policy',
    )
    expect(screen.queryByText('Your venue setup is ready for review.')).toBeNull()
    expect(mocks.push).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Create venue' }))
    await waitFor(() => expect(mocks.createVenue).toHaveBeenCalledTimes(2))
    expect(mocks.createVenue.mock.calls[1]).toEqual(mocks.createVenue.mock.calls[0])
    expect(await screen.findByText('Your venue setup is ready for review.')).toBeTruthy()
  })
})
