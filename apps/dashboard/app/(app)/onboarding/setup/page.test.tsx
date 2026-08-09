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

type GuideMode = 'location_aware' | 'non_location'
type ContentKind = 'place' | 'knowledge'

function fillVenueBasics(guideMode: GuideMode) {
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

function fillLocation() {
  fireEvent.change(screen.getByLabelText('Center latitude'), { target: { value: '40.7' } })
  fireEvent.change(screen.getByLabelText('Center longitude'), { target: { value: '-74' } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
}

async function advanceToContentChoice(guideMode: GuideMode) {
  fillVenueBasics(guideMode)
  if (guideMode === 'location_aware') {
    expect(await screen.findByRole('heading', { name: 'Set your location' })).toBeTruthy()
    fillLocation()
  }
  expect(
    await screen.findByRole('group', { name: 'Choose your first public content' }),
  ).toBeTruthy()
}

function chooseContent(kind: ContentKind) {
  fireEvent.click(
    screen.getByRole('radio', {
      name: kind === 'place' ? /Place or guide item/ : /Venue knowledge/,
    }),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
}

function fillPlace(name = 'Main entrance', description = 'The central visitor entrance.') {
  fireEvent.change(screen.getByLabelText('Guide item name'), { target: { value: name } })
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'OTHER' } })
  fireEvent.change(screen.getByLabelText('Brief description'), {
    target: { value: description },
  })
}

function fillKnowledge(
  title = 'Visitor policy',
  category = 'POLICY',
  content = 'Bags are checked at the entrance.',
) {
  fireEvent.change(screen.getByLabelText('Knowledge title'), { target: { value: title } })
  fireEvent.change(screen.getByLabelText('Knowledge category'), { target: { value: category } })
  fireEvent.change(screen.getByLabelText('Knowledge content'), { target: { value: content } })
}

describe('mode- and content-aware onboarding setup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createVenue.mockResolvedValue({ id: 'venue-created' })
  })

  afterEach(cleanup)

  it('requires an explicit content choice and makes no write when it is omitted', async () => {
    render(<OnboardingSetupPage />)
    await advanceToContentChoice('non_location')

    expect(
      screen.getByText(/Audience-restricted or employee-only content is not supported/),
    ).toBeTruthy()
    expect(
      (screen.getByRole('radio', { name: /Place or guide item/ }) as HTMLInputElement).checked,
    ).toBe(false)
    expect(
      (screen.getByRole('radio', { name: /Venue knowledge/ }) as HTMLInputElement).checked,
    ).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    const alert = await screen.findByRole('alert')
    const group = screen.getByRole('group', { name: 'Choose your first public content' })
    expect(alert.textContent).toBe('Choose a content type to continue.')
    expect(group.getAttribute('aria-invalid')).toBe('true')
    expect(group.getAttribute('aria-required')).toBe('true')
    expect(group.getAttribute('aria-describedby')).toBe(alert.id)
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: /Place or guide item/ }))
    expect(mocks.createVenue).not.toHaveBeenCalled()
  })

  it.each([
    ['non_location', 'place'],
    ['non_location', 'knowledge'],
    ['location_aware', 'place'],
    ['location_aware', 'knowledge'],
  ] as const)('submits one atomic %s + %s payload', async (guideMode, contentKind) => {
    render(<OnboardingSetupPage />)
    await advanceToContentChoice(guideMode)
    chooseContent(contentKind)

    if (contentKind === 'place') {
      expect(
        await screen.findByRole('heading', {
          name: /Add your (first place|central starting point)/,
        }),
      ).toBeTruthy()
      expect(screen.queryByLabelText('Knowledge content')).toBeNull()
      fillPlace()
    } else {
      expect(await screen.findByRole('heading', { name: 'Add venue knowledge' })).toBeTruthy()
      expect(screen.queryByLabelText('Guide item name')).toBeNull()
      fillKnowledge()
    }

    fireEvent.click(screen.getByRole('button', { name: 'Create venue' }))

    await waitFor(() => expect(mocks.createVenue).toHaveBeenCalledOnce())
    expect(mocks.createVenue).toHaveBeenCalledWith({
      name: 'Harbor Museum',
      slug: 'harbor-museum',
      category: 'museum',
      guideMode,
      ...(guideMode === 'location_aware' ? { defaultCenterLat: 40.7, defaultCenterLng: -74 } : {}),
      initialContent:
        contentKind === 'place'
          ? {
              kind: 'place',
              value: {
                name: 'Main entrance',
                type: 'OTHER',
                shortDescription: 'The central visitor entrance.',
                tags: [],
                importanceScore: 0,
              },
            }
          : {
              kind: 'knowledge',
              value: {
                title: 'Visitor policy',
                category: 'POLICY',
                content: 'Bags are checked at the entrance.',
              },
            },
    })
    expect(await screen.findByText('Your venue setup is ready for review.')).toBeTruthy()
    expect(screen.queryByText(/Your venue is live/i)).toBeNull()
  })

  it('keeps independent drafts while switching content kind', async () => {
    render(<OnboardingSetupPage />)
    await advanceToContentChoice('non_location')

    chooseContent('place')
    fillPlace('Lobby desk', 'Ask here for accessibility support.')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    chooseContent('knowledge')
    fillKnowledge('Hours policy', 'HOURS', 'The final entry is one hour before closing.')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    chooseContent('place')
    expect((screen.getByLabelText('Guide item name') as HTMLInputElement).value).toBe('Lobby desk')
    expect((screen.getByLabelText('Brief description') as HTMLTextAreaElement).value).toBe(
      'Ask here for accessibility support.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    chooseContent('knowledge')
    expect((screen.getByLabelText('Knowledge title') as HTMLInputElement).value).toBe(
      'Hours policy',
    )
    expect((screen.getByLabelText('Knowledge category') as HTMLInputElement).value).toBe('HOURS')
    expect((screen.getByLabelText('Knowledge content') as HTMLTextAreaElement).value).toBe(
      'The final entry is one hour before closing.',
    )
  })

  it('clears the Place draft but preserves Knowledge when guide mode changes', async () => {
    render(<OnboardingSetupPage />)
    await advanceToContentChoice('non_location')

    chooseContent('place')
    fillPlace('Lobby desk', 'Ask here for accessibility support.')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    chooseContent('knowledge')
    fillKnowledge('Hours policy', 'HOURS', 'The final entry is one hour before closing.')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    fireEvent.click(await screen.findByRole('radio', { name: /On-site guide/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Set your location' })
    fillLocation()
    await screen.findByRole('group', { name: 'Choose your first public content' })

    expect(
      (screen.getByRole('radio', { name: /Venue knowledge/ }) as HTMLInputElement).checked,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect((screen.getByLabelText('Knowledge title') as HTMLInputElement).value).toBe(
      'Hours policy',
    )
    expect((screen.getByLabelText('Knowledge content') as HTMLTextAreaElement).value).toBe(
      'The final entry is one hour before closing.',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    chooseContent('place')
    expect((screen.getByLabelText('Guide item name') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Category') as HTMLSelectElement).value).toBe('ENTRANCE')
    expect((screen.getByLabelText('Brief description') as HTMLTextAreaElement).value).toBe('')
  })

  it('clears the center and resets Place defaults when switching to no-location mode', async () => {
    render(<OnboardingSetupPage />)
    await advanceToContentChoice('location_aware')
    chooseContent('place')
    fillPlace('Main entrance', 'The central visitor entrance.')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    fireEvent.click(await screen.findByRole('radio', { name: /Guide without visitor location/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('group', { name: 'Choose your first public content' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect((screen.getByLabelText('Guide item name') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Category') as HTMLSelectElement).value).toBe('OTHER')
    fillPlace('Visitor desk', 'Ask here for visitor assistance.')
    fireEvent.click(screen.getByRole('button', { name: 'Create venue' }))

    await waitFor(() => expect(mocks.createVenue).toHaveBeenCalledOnce())
    const payload = mocks.createVenue.mock.calls[0]?.[0]
    expect(payload).not.toHaveProperty('defaultCenterLat')
    expect(payload).not.toHaveProperty('defaultCenterLng')
  })

  it('retains the selected knowledge draft and submits the exact same payload on retry', async () => {
    mocks.createVenue.mockRejectedValueOnce(new Error('Setup could not be saved'))
    render(<OnboardingSetupPage />)
    await advanceToContentChoice('non_location')
    chooseContent('knowledge')
    fillKnowledge()

    fireEvent.click(screen.getByRole('button', { name: 'Create venue' }))

    expect((await screen.findByRole('alert')).textContent).toBe('Setup could not be saved')
    expect((screen.getByLabelText('Knowledge title') as HTMLInputElement).value).toBe(
      'Visitor policy',
    )
    expect(mocks.push).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Create venue' }))
    await waitFor(() => expect(mocks.createVenue).toHaveBeenCalledTimes(2))
    expect(mocks.createVenue.mock.calls[1]).toEqual(mocks.createVenue.mock.calls[0])
    expect(await screen.findByText('Your venue setup is ready for review.')).toBeTruthy()
  })

  it('blocks duplicate writes while the first atomic mutation is unresolved', async () => {
    let resolveCreate: ((value: { id: string }) => void) | undefined
    mocks.createVenue.mockImplementationOnce(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveCreate = resolve
        }),
    )
    render(<OnboardingSetupPage />)
    await advanceToContentChoice('non_location')
    chooseContent('place')
    fillPlace()

    const createButton = screen.getByRole('button', { name: 'Create venue' })
    fireEvent.click(createButton)
    fireEvent.click(createButton)

    await waitFor(() => expect(mocks.createVenue).toHaveBeenCalledOnce())
    resolveCreate?.({ id: 'venue-created' })
    expect(await screen.findByText('Your venue setup is ready for review.')).toBeTruthy()
  })
})
