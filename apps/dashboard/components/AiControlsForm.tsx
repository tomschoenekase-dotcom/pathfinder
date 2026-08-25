'use client'

import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Check, LockKeyhole } from 'lucide-react'
import Image from 'next/image'

import {
  TONE_PRESET_IDS,
  TONE_PRESET_REGISTRY,
  type TonePresetId,
} from '@pathfinder/contracts/tone-presets'
import type {
  VenueBotConfigurationSnapshot,
  VenueBotPersonalityMode,
  VenueBotPresentationMode,
  VenueBotResponseDepth,
  PersonalityProfileSnapshot,
} from '@pathfinder/contracts/venue-bot-configuration'
import { VENUE_BOT_RESPONSE_DEPTH_OPTIONS } from '@pathfinder/contracts/venue-bot-configuration'

import { useTRPCClient } from '../lib/trpc'
import { CustomPersonalityEditor } from './CustomPersonalityEditor'

type VenueBotEditorState = {
  presentationMode: VenueBotPresentationMode
  personalityMode: VenueBotPersonalityMode
  tonePreset: TonePresetId
  personalityProfileId: string | null
  responseDepth: VenueBotResponseDepth
}

export type AiControlsVenue = {
  id: string
  name: string
  configuration: VenueBotConfigurationSnapshot
  profiles: PersonalityProfileSnapshot[]
}

export type TochiDevelopmentPreview = {
  src: string
  width: number
  height: number
}

type AiControlsFormProps = {
  initialVenueId: string
  venues: AiControlsVenue[]
  tochiDevelopmentPreview: TochiDevelopmentPreview | null
}

function editorState(configuration: VenueBotConfigurationSnapshot): VenueBotEditorState {
  return {
    presentationMode: configuration.presentationMode,
    personalityMode: configuration.personalityMode,
    tonePreset: configuration.tonePreset,
    personalityProfileId: configuration.personalityProfileId,
    responseDepth: configuration.responseDepth,
  }
}

function statesMatch(left: VenueBotEditorState, right: VenueBotEditorState) {
  return (
    left.presentationMode === right.presentationMode &&
    left.personalityMode === right.personalityMode &&
    left.tonePreset === right.tonePreset &&
    left.personalityProfileId === right.personalityProfileId &&
    left.responseDepth === right.responseDepth
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Your Venue Bot settings could not be saved. Please try again.'
}

export function AiControlsForm({
  initialVenueId,
  venues,
  tochiDevelopmentPreview,
}: AiControlsFormProps) {
  const client = useTRPCClient()
  const configurations = useRef(
    new Map(venues.map((venue) => [venue.id, venue.configuration] as const)),
  )
  const initialConfiguration =
    configurations.current.get(initialVenueId) ?? venues[0]?.configuration
  const [selectedVenueId, setSelectedVenueId] = useState(initialVenueId)
  const [savedState, setSavedState] = useState<VenueBotEditorState>(() =>
    editorState(initialConfiguration!),
  )
  const [draft, setDraft] = useState<VenueBotEditorState>(() => editorState(initialConfiguration!))
  const [isSaving, setIsSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [profilesByVenue, setProfilesByVenue] = useState<
    Record<string, PersonalityProfileSnapshot[]>
  >(() => Object.fromEntries(venues.map((venue) => [venue.id, venue.profiles])))
  const mutationInFlight = useRef(false)

  const selectedVenue = venues.find((venue) => venue.id === selectedVenueId)
  const selectedConfiguration = configurations.current.get(selectedVenueId)
  const dirty = !statesMatch(savedState, draft)
  const savedCharacterConfiguration = selectedConfiguration?.presentationMode === 'CHARACTER'

  useEffect(() => {
    if (!successMessage) return
    const timeoutId = window.setTimeout(() => setSuccessMessage(null), 3_000)
    return () => window.clearTimeout(timeoutId)
  }, [successMessage])

  function clearMessages() {
    setFormError(null)
    setSuccessMessage(null)
  }

  function selectVenue(venueId: string) {
    if (mutationInFlight.current || venueId === selectedVenueId) return
    if (dirty && !window.confirm('Switch venues? Unsaved Venue Bot changes will be discarded.')) {
      return
    }
    const configuration = configurations.current.get(venueId)
    if (!configuration) return
    const next = editorState(configuration)
    setSelectedVenueId(venueId)
    setSavedState(next)
    setDraft(next)
    clearMessages()
  }

  function selectTone(nextPreset: TonePresetId) {
    setDraft((current) => ({
      ...current,
      personalityMode: 'PRESET',
      personalityProfileId: null,
      tonePreset: nextPreset,
    }))
    clearMessages()
  }

  function selectCustomProfile(profileId: string) {
    setDraft((current) => ({
      ...current,
      personalityMode: 'CUSTOM',
      personalityProfileId: profileId,
    }))
    clearMessages()
  }

  function selectClassic() {
    setDraft((current) => ({ ...current, presentationMode: 'CLASSIC' }))
    clearMessages()
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (mutationInFlight.current || !selectedConfiguration || !dirty) return

    const changes: {
      presentationMode?: VenueBotPresentationMode
      personalityMode?: VenueBotPersonalityMode
      tonePreset?: TonePresetId
      personalityProfileId?: string | null
      responseDepth?: VenueBotResponseDepth
    } = {}
    if (draft.presentationMode !== savedState.presentationMode) {
      changes.presentationMode = draft.presentationMode
    }
    if (draft.personalityMode !== savedState.personalityMode) {
      changes.personalityMode = draft.personalityMode
    }
    if (draft.tonePreset !== savedState.tonePreset) {
      changes.tonePreset = draft.tonePreset
    }
    if (draft.personalityProfileId !== savedState.personalityProfileId) {
      changes.personalityProfileId = draft.personalityProfileId
    }
    if (draft.responseDepth !== savedState.responseDepth) {
      changes.responseDepth = draft.responseDepth
    }

    mutationInFlight.current = true
    setFormError(null)
    setSuccessMessage(null)
    setIsSaving(true)

    try {
      const saved = await client.venue.updateBotConfiguration.mutate({
        venueId: selectedVenueId,
        expectedRevision: selectedConfiguration.revision,
        ...changes,
      })
      configurations.current.set(selectedVenueId, saved)
      const next = editorState(saved)
      setSavedState(next)
      setDraft(next)
      setSuccessMessage('Venue Bot settings saved for new visitor conversations.')
    } catch (error) {
      setFormError(errorMessage(error))
    } finally {
      mutationInFlight.current = false
      setIsSaving(false)
    }
  }

  if (!initialConfiguration || !selectedVenue) return null

  return (
    <form className="space-y-6" onSubmit={handleSubmit} aria-busy={isSaving}>
      {venues.length > 1 ? (
        <section className="rounded-[2rem] border border-pf-light bg-white p-6 shadow-sm sm:p-8">
          <label htmlFor="venue-bot-venue" className="text-sm font-semibold text-pf-deep">
            Venue
          </label>
          <select
            id="venue-bot-venue"
            value={selectedVenueId}
            disabled={isSaving}
            onChange={(event) => selectVenue(event.target.value)}
            className="mt-3 min-h-11 w-full rounded-2xl border border-pf-light bg-pf-white px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {venues.map((venue) => (
              <option key={venue.id} value={venue.id}>
                {venue.name}
              </option>
            ))}
          </select>
        </section>
      ) : null}

      <section className="rounded-[2rem] border border-pf-light bg-white p-6 shadow-sm sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-pf-primary">
          Presentation
        </p>
        <h2 id="presentation-heading" className="mt-2 text-2xl font-semibold text-pf-deep">
          Choose the public visitor experience
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
          Presentation changes how Venue Bot appears. It does not change what the guide knows, its
          safety rules, or your private client assistant.
        </p>

        <div
          role="group"
          aria-labelledby="presentation-heading"
          className="mt-6 grid gap-4 lg:grid-cols-2"
        >
          <button
            type="button"
            aria-pressed={draft.presentationMode === 'CLASSIC'}
            disabled={isSaving}
            onClick={selectClassic}
            className={`relative min-h-44 rounded-3xl border p-6 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none ${
              draft.presentationMode === 'CLASSIC'
                ? 'border-pf-primary bg-pf-primary/[0.06] shadow-sm'
                : 'border-pf-light bg-pf-surface hover:border-pf-accent/50'
            }`}
          >
            {draft.presentationMode === 'CLASSIC' ? (
              <span className="absolute right-5 top-5 flex h-7 w-7 items-center justify-center rounded-full bg-pf-primary text-white">
                <Check className="h-4 w-4" aria-hidden="true" />
              </span>
            ) : null}
            <span className="block pr-10 text-xl font-semibold text-pf-deep">Classic</span>
            <span className="mt-3 block text-sm leading-6 text-pf-deep/75">
              The dependable text-chat experience. This remains the default and is fully supported.
            </span>
            <span className="mt-4 inline-flex rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">
              Available now
            </span>
          </button>

          <div
            className={`relative min-h-44 overflow-hidden rounded-3xl border p-6 ${
              savedCharacterConfiguration
                ? 'border-amber-400 bg-amber-50'
                : 'border-pf-light bg-pf-surface'
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-xl font-semibold text-pf-deep">
                  <LockKeyhole className="h-5 w-5 text-amber-700" aria-hidden="true" />
                  Character
                </div>
                <p className="mt-3 max-w-md text-sm leading-6 text-pf-deep/75">
                  {savedCharacterConfiguration
                    ? 'A Character setup is saved, but it cannot be newly selected or published until approved character assets are available.'
                    : 'A future visual layer around the same visitor guide. No approved publishable character pack is available yet.'}
                </p>
              </div>
              {tochiDevelopmentPreview ? (
                <Image
                  src={tochiDevelopmentPreview.src}
                  width={tochiDevelopmentPreview.width}
                  height={tochiDevelopmentPreview.height}
                  alt=""
                  aria-hidden="true"
                  className="h-24 w-20 shrink-0 object-contain opacity-80"
                />
              ) : null}
            </div>
            {tochiDevelopmentPreview ? (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-amber-300 bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900">
                  Tochi development preview
                </span>
                <span className="text-xs text-pf-deep/65">Not available to publish</span>
              </div>
            ) : (
              <div className="mt-4 text-xs font-semibold text-pf-deep/70">
                Character early access is not enabled for this environment.
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-[2rem] border border-pf-light bg-white p-6 shadow-sm sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-pf-primary">
          Personality
        </p>
        <h2 id="tone-heading" className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
          How should Venue Bot sound?
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
          Choose a style for visitor conversations. Personality is independent from presentation,
          and safety and factual guidance stay the same.
        </p>

        <div
          role="group"
          aria-labelledby="tone-heading"
          className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
        >
          {TONE_PRESET_IDS.map((presetId) => {
            const preset = TONE_PRESET_REGISTRY[presetId]
            const selected = draft.personalityMode === 'PRESET' && draft.tonePreset === presetId

            return (
              <button
                key={presetId}
                type="button"
                aria-pressed={selected}
                disabled={isSaving}
                onClick={() => selectTone(presetId)}
                className={`relative min-h-36 rounded-3xl border p-5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none ${
                  selected
                    ? 'border-pf-primary bg-pf-primary/[0.06] shadow-sm'
                    : 'border-pf-light bg-pf-surface hover:border-pf-accent/50 hover:bg-white'
                }`}
              >
                {selected ? (
                  <span className="absolute right-4 top-4 flex h-6 w-6 items-center justify-center rounded-full bg-pf-primary text-white">
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                ) : null}
                <span className="block pr-8 text-lg font-semibold text-pf-deep">
                  {preset.label}
                </span>
                <span className="mt-2 block text-sm leading-6 text-pf-deep/75">
                  {preset.description}
                </span>
              </button>
            )
          })}
        </div>

        <CustomPersonalityEditor
          key={selectedVenueId}
          venueId={selectedVenueId}
          profiles={profilesByVenue[selectedVenueId] ?? []}
          selectedProfileId={draft.personalityMode === 'CUSTOM' ? draft.personalityProfileId : null}
          disabled={isSaving}
          onSelect={selectCustomProfile}
          onSaved={(profile) =>
            setProfilesByVenue((current) => ({
              ...current,
              [selectedVenueId]: [
                ...(current[selectedVenueId] ?? []).filter((item) => item.id !== profile.id),
                profile,
              ].sort((left, right) => left.name.localeCompare(right.name)),
            }))
          }
        />
      </section>

      <section className="rounded-[2rem] border border-pf-light bg-white p-6 shadow-sm sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-pf-primary">
          Answer depth
        </p>
        <h2 id="response-depth-heading" className="mt-2 text-2xl font-semibold text-pf-deep">
          How much context should visitors get?
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
          Every setting stays concise and venue-grounded. Visitors can still choose Tell me more
          when an answer deserves extra context.
        </p>
        <div
          role="group"
          aria-labelledby="response-depth-heading"
          className="mt-6 divide-y divide-pf-light border-y border-pf-light md:grid md:grid-cols-3 md:divide-x md:divide-y-0"
        >
          {VENUE_BOT_RESPONSE_DEPTH_OPTIONS.map((option) => {
            const selected = draft.responseDepth === option.id
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={selected}
                disabled={isSaving}
                onClick={() => {
                  setDraft((current) => ({ ...current, responseDepth: option.id }))
                  clearMessages()
                }}
                className={`relative min-h-28 px-4 py-5 text-left transition focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none ${
                  selected
                    ? 'bg-pf-primary/[0.06] shadow-[inset_3px_0_0_var(--color-pf-primary)] md:shadow-[inset_0_3px_0_var(--color-pf-primary)]'
                    : 'hover:bg-pf-surface'
                }`}
              >
                <span className="flex items-center justify-between gap-3 text-lg font-semibold text-pf-deep">
                  {option.label}
                  {selected ? (
                    <Check className="h-4 w-4 text-pf-primary" aria-hidden="true" />
                  ) : null}
                </span>
                <span className="mt-2 block text-sm leading-6 text-pf-deep/70">
                  {option.description}
                </span>
              </button>
            )
          })}
        </div>
      </section>

      {formError ? (
        <p
          role="alert"
          className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
        >
          {formError}
        </p>
      ) : null}
      {successMessage ? (
        <p
          role="status"
          className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700"
        >
          {successMessage}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={isSaving || !dirty}
          className="inline-flex min-h-12 items-center rounded-full bg-pf-primary px-6 text-sm font-semibold text-white transition hover:bg-pf-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving ? 'Saving settings…' : 'Save Venue Bot settings'}
        </button>
        {!dirty && !successMessage ? (
          <span className="text-sm text-pf-deep/70">No unsaved changes.</span>
        ) : null}
      </div>
    </form>
  )
}
