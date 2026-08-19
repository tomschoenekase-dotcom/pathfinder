import { notFound } from 'next/navigation'

import type {
  PersonalityProfileSnapshot,
  VenueBotConfigurationSnapshot,
} from '@pathfinder/contracts/venue-bot-configuration'

import { AiControlsForm } from '../../../components/AiControlsForm'
import { TRPCProvider } from '../../../lib/trpc'

const states = ['classic', 'custom', 'character'] as const
type FixtureState = (typeof states)[number]

const customProfile: PersonalityProfileSnapshot = {
  id: 'profile-harbor-host',
  venueId: 'fixture-venue',
  name: 'Harbor host',
  bounds: {
    warmth: 0.82,
    brevity: 0.68,
    energy: 0.42,
    formality: 0.35,
    customInstruction: 'Use plain language and make families feel at ease.',
  },
  revision: 2,
  updatedAt: '2026-08-19T12:00:00.000Z',
}

function configuration(state: FixtureState): VenueBotConfigurationSnapshot {
  return {
    id: 'venue-bot-fixture',
    venueId: 'fixture-venue',
    revision: 4,
    updatedAt: '2026-08-19T12:00:00.000Z',
    presentationMode: state === 'character' ? 'CHARACTER' : 'CLASSIC',
    personalityMode: state === 'custom' ? 'CUSTOM' : 'PRESET',
    tonePreset: state === 'classic' ? 'friendly' : 'informative',
    tonePresetVersion: 1,
    personalityProfileId: state === 'custom' ? customProfile.id : null,
    characterKey: state === 'character' ? 'tochi' : null,
    customCharacterId: null,
    publicDisplayName: 'Torchiko guide',
    greeting: 'What can I help you find today?',
    voiceProfileId: null,
  }
}

export default async function VenueBotSettingsFixture({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>
}) {
  if (process.env.NODE_ENV !== 'development') notFound()
  const requestedState = (await searchParams).state
  const state: FixtureState = states.includes(requestedState as FixtureState)
    ? (requestedState as FixtureState)
    : 'classic'

  return (
    <main className="min-h-screen bg-pf-surface px-4 py-8 text-pf-deep sm:px-8 sm:py-12">
      <div className="mx-auto max-w-6xl">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pf-primary">
          Development fixture · {state}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
          Venue Bot settings
        </h1>
        <p className="mb-8 mt-3 max-w-2xl text-sm leading-6 text-pf-deep/70">
          Deterministic configuration state. Saving is intentionally unavailable without fixture API
          data.
        </p>
        <TRPCProvider scopeKey={`fixture:venue-bot:${state}`}>
          <AiControlsForm
            initialVenueId="fixture-venue"
            venues={[
              {
                id: 'fixture-venue',
                name: 'Harbor House',
                configuration: configuration(state),
                profiles: [customProfile],
              },
            ]}
            tochiDevelopmentPreview={{
              src: '/characters/tochi/v0-development/preview.svg',
              width: 320,
              height: 360,
            }}
          />
        </TRPCProvider>
      </div>
    </main>
  )
}
