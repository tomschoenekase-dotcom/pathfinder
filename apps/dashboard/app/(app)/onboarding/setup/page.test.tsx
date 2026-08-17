/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  submitBootstrap: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  client: {
    intake: { submitOnboardingBootstrap: { mutate: vi.fn() } },
  },
}))

mocks.client.intake.submitOnboardingBootstrap.mutate = mocks.submitBootstrap

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
  expect(await screen.findByRole('group', { name: 'Choose starting information' })).toBeTruthy()
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
    mocks.submitBootstrap.mockResolvedValue({
      venue: { id: 'venue-created' },
      status: 'AWAITING_REVIEW',
    })
  })

  afterEach(cleanup)

  it('frames onboarding as a managed Torchiko build instead of DIY configuration', () => {
    render(<OnboardingSetupPage />)

    expect(screen.getByRole('heading', { name: /Give us the raw details/i })).toBeTruthy()
    expect(screen.getByText(/Torchiko does the assembly/i)).toBeTruthy()
    expect(screen.getByText(/Review the preview before anything is published/i)).toBeTruthy()
    expect(screen.queryByText(/configure your chatbot/i)).toBeNull()

    const slugInput = screen.getByLabelText('Slug')
    expect(slugInput.closest('[hidden]')).toBeTruthy()
  })

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
    const group = screen.getByRole('group', { name: 'Choose starting information' })
    expect(alert.textContent).toBe('Choose a content type to continue.')
    expect(group.getAttribute('aria-invalid')).toBe('true')
    expect(group.getAttribute('aria-required')).toBe('true')
    expect(group.getAttribute('aria-describedby')).toBe(alert.id)
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: /Place or guide item/ }))
    expect(mocks.submitBootstrap).not.toHaveBeenCalled()
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

    await waitFor(() => expect(mocks.submitBootstrap).toHaveBeenCalledOnce())
    expect(mocks.submitBootstrap).toHaveBeenCalledWith({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      venue: {
        name: 'Harbor Museum',
        slug: 'harbor-museum',
        category: 'museum',
        guideMode,
        ...(guideMode === 'location_aware'
          ? { defaultCenterLat: 40.7, defaultCenterLng: -74 }
          : {}),
      },
      rawContent:
        contentKind === 'place'
          ? {
              kind: 'place',
              value: {
                name: 'Main entrance',
                type: 'OTHER',
                shortDescription: 'The central visitor entrance.',
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
    expect(await screen.findByText('Your starting information is awaiting review.')).toBeTruthy()
    expect(mocks.submitBootstrap.mock.calls[0]?.[0]).not.toHaveProperty('initialContent')
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
    await screen.findByRole('group', { name: 'Choose starting information' })

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
    await screen.findByRole('group', { name: 'Choose starting information' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect((screen.getByLabelText('Guide item name') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Category') as HTMLSelectElement).value).toBe('OTHER')
    fillPlace('Visitor desk', 'Ask here for visitor assistance.')
    fireEvent.click(screen.getByRole('button', { name: 'Create venue' }))

    await waitFor(() => expect(mocks.submitBootstrap).toHaveBeenCalledOnce())
    const payload = mocks.submitBootstrap.mock.calls[0]?.[0]?.venue
    expect(payload).not.toHaveProperty('defaultCenterLat')
    expect(payload).not.toHaveProperty('defaultCenterLng')
  })

  it('retains the selected knowledge draft and submits the exact same payload on retry', async () => {
    mocks.submitBootstrap.mockRejectedValueOnce(new Error('Setup could not be saved'))
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
    await waitFor(() => expect(mocks.submitBootstrap).toHaveBeenCalledTimes(2))
    expect(mocks.submitBootstrap.mock.calls[1]).toEqual(mocks.submitBootstrap.mock.calls[0])
    expect(await screen.findByText('Your starting information is awaiting review.')).toBeTruthy()
  })

  it('rotates the submission key when raw information changes after a failed attempt', async () => {
    mocks.submitBootstrap.mockRejectedValueOnce(new Error('Connection lost'))
    render(<OnboardingSetupPage />)
    await advanceToContentChoice('non_location')
    chooseContent('knowledge')
    fillKnowledge()
    fireEvent.click(screen.getByRole('button', { name: 'Create venue' }))
    await screen.findByRole('alert')
    const firstRequestId = mocks.submitBootstrap.mock.calls[0]?.[0]?.requestId

    fireEvent.change(screen.getByLabelText('Knowledge content'), {
      target: { value: 'Updated raw candidate information.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create venue' }))
    await waitFor(() => expect(mocks.submitBootstrap).toHaveBeenCalledTimes(2))
    expect(mocks.submitBootstrap.mock.calls[1]?.[0]?.requestId).not.toBe(firstRequestId)
  })

  it('blocks duplicate writes while the first atomic mutation is unresolved', async () => {
    let resolveCreate: ((value: { venue: { id: string }; status: string }) => void) | undefined
    mocks.submitBootstrap.mockImplementationOnce(
      () =>
        new Promise<{ venue: { id: string }; status: string }>((resolve) => {
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

    await waitFor(() => expect(mocks.submitBootstrap).toHaveBeenCalledOnce())
    expect(createButton.textContent).toMatch(/Receiving your information/i)
    expect(screen.getByText(/Nothing goes live from this step/i)).toBeTruthy()
    resolveCreate?.({ venue: { id: 'venue-created' }, status: 'AWAITING_REVIEW' })
    expect(await screen.findByText('Your starting information is awaiting review.')).toBeTruthy()
    expect(screen.getByText('Information received')).toBeTruthy()
    expect(screen.getByText('Torchiko review pending')).toBeTruthy()
    expect(screen.getByText('First preview')).toBeTruthy()
  })
})
