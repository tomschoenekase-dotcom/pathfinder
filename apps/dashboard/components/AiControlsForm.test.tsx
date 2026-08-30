/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  PersonalityProfileSnapshot,
  VenueBotConfigurationSnapshot,
} from '@pathfinder/contracts/venue-bot-configuration'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  updateBotConfiguration: vi.fn(),
  createPersonalityProfile: vi.fn(),
  updatePersonalityProfile: vi.fn(),
}))

vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => ({
    venue: {
      updateBotConfiguration: { mutate: mocks.updateBotConfiguration },
      createPersonalityProfile: { mutate: mocks.createPersonalityProfile },
      updatePersonalityProfile: { mutate: mocks.updatePersonalityProfile },
    },
  }),
}))

import { AiControlsForm, type AiControlsVenue } from './AiControlsForm'

const classicConfiguration: VenueBotConfigurationSnapshot = {
  id: 'configuration_1',
  venueId: 'venue_1',
  presentationMode: 'CLASSIC',
  personalityMode: 'PRESET',
  tonePreset: 'friendly',
  tonePresetVersion: 1,
  responseDepth: 'BALANCED',
  personalityProfileId: null,
  characterKey: null,
  customCharacterId: null,
  publicDisplayName: null,
  greeting: null,
  voiceProfileId: null,
  revision: 3,
  updatedAt: '2026-08-19T14:30:00.000Z',
}

function venue(
  configuration: VenueBotConfigurationSnapshot = classicConfiguration,
  profiles: PersonalityProfileSnapshot[] = [],
): AiControlsVenue {
  return { id: configuration.venueId, name: 'Museum', configuration, profiles }
}

function renderForm(options?: {
  configuration?: VenueBotConfigurationSnapshot
  tochiPreview?: boolean
  profiles?: PersonalityProfileSnapshot[]
}) {
  const configuration = options?.configuration ?? classicConfiguration
  return render(
    <AiControlsForm
      initialVenueId={configuration.venueId}
      venues={[venue(configuration, options?.profiles)]}
      tochiDevelopmentPreview={
        options?.tochiPreview
          ? { src: '/character-assets/tochi/v0-development/neutral.svg', width: 384, height: 512 }
          : null
      }
    />,
  )
}

describe('AiControlsForm Venue Bot configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.updateBotConfiguration.mockImplementation(
      async (input: Partial<VenueBotConfigurationSnapshot>) => ({
        ...classicConfiguration,
        ...input,
        revision: classicConfiguration.revision + 1,
        updatedAt: '2026-08-19T14:31:00.000Z',
      }),
    )
  })
  afterEach(cleanup)

  it('keeps Classic as the default and preserves all four versioned presets', () => {
    renderForm()

    expect(screen.getByRole('button', { name: /^Classic/ }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect(screen.getByRole('button', { name: /^Friendly/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Concise/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Enthusiastic/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Informative/ })).toBeTruthy()
    expect(screen.getByText(/private client assistant/u)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Save Venue Bot settings' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('saves only changed fields through the revision-safe production API', async () => {
    renderForm()

    fireEvent.click(screen.getByRole('button', { name: /^Concise/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save Venue Bot settings' }))

    await waitFor(() =>
      expect(mocks.updateBotConfiguration).toHaveBeenCalledWith({
        venueId: 'venue_1',
        expectedRevision: 3,
        tonePreset: 'concise',
      }),
    )
    expect((await screen.findByRole('status')).textContent).toContain('Venue Bot settings saved')
  })

  it('saves a bounded venue response-depth override independently', async () => {
    renderForm()

    fireEvent.click(screen.getByRole('button', { name: /^Detailed/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save Venue Bot settings' }))

    await waitFor(() =>
      expect(mocks.updateBotConfiguration).toHaveBeenCalledWith({
        venueId: 'venue_1',
        expectedRevision: 3,
        responseDepth: 'DETAILED',
      }),
    )
  })

  it('shows Tochi only as a nonpublishable development preview behind rollout input', () => {
    const { rerender } = renderForm()

    expect(screen.queryByText('Tochi development preview')).toBeNull()
    expect(screen.getByText(/early access is not enabled/u)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Character/ })).toBeNull()

    rerender(
      <AiControlsForm
        initialVenueId="venue_1"
        venues={[venue()]}
        tochiDevelopmentPreview={{
          src: '/character-assets/tochi/v0-development/neutral.svg',
          width: 384,
          height: 512,
        }}
      />,
    )

    expect(screen.getByText('Tochi development preview')).toBeTruthy()
    expect(screen.getByText('Not available to publish')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Character/ })).toBeNull()
  })

  it('shows an active custom profile editor and lets a client replace it with a preset', async () => {
    const customConfiguration: VenueBotConfigurationSnapshot = {
      ...classicConfiguration,
      personalityMode: 'CUSTOM',
      personalityProfileId: 'profile_1',
    }
    renderForm({
      configuration: customConfiguration,
      profiles: [
        {
          id: 'profile_1',
          venueId: 'venue_1',
          name: 'Warm guide',
          bounds: { warmth: 0.8, brevity: 0.7, energy: 0.5, formality: 0.5 },
          revision: 1,
          updatedAt: '2026-08-19T14:30:00.000Z',
        },
      ],
    })

    expect((screen.getByLabelText('Saved profile') as HTMLSelectElement).value).toBe('profile_1')
    expect((screen.getByLabelText('Profile name') as HTMLInputElement).value).toBe('Warm guide')
    expect(screen.getByRole('button', { name: 'Update custom profile' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^Informative/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save Venue Bot settings' }))

    await waitFor(() =>
      expect(mocks.updateBotConfiguration).toHaveBeenCalledWith({
        venueId: 'venue_1',
        expectedRevision: 3,
        personalityMode: 'PRESET',
        personalityProfileId: null,
        tonePreset: 'informative',
      }),
    )
  })

  it('lets an existing Character configuration safely return to Classic', async () => {
    const characterConfiguration: VenueBotConfigurationSnapshot = {
      ...classicConfiguration,
      presentationMode: 'CHARACTER',
      characterKey: 'tochi',
    }
    renderForm({ configuration: characterConfiguration, tochiPreview: true })

    expect(screen.getByText(/A Character setup is saved/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Classic/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save Venue Bot settings' }))

    await waitFor(() =>
      expect(mocks.updateBotConfiguration).toHaveBeenCalledWith({
        venueId: 'venue_1',
        expectedRevision: 3,
        presentationMode: 'CLASSIC',
      }),
    )
  })

  it('fences duplicate saves and reports failures honestly', async () => {
    let reject!: (reason: Error) => void
    mocks.updateBotConfiguration.mockImplementationOnce(
      () => new Promise((_, rejectPromise) => (reject = rejectPromise)),
    )
    renderForm()

    fireEvent.click(screen.getByRole('button', { name: /^Concise/ }))
    const form = screen.getByRole('button', { name: 'Save Venue Bot settings' }).closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)

    expect(mocks.updateBotConfiguration).toHaveBeenCalledOnce()
    expect(
      (screen.getByRole('button', { name: 'Saving settings…' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    await act(async () => reject(new Error('Could not save this configuration')))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not save')
  })
})
