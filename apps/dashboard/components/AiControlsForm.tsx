'use client'

import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'

import {
  TONE_PRESET_IDS,
  TONE_PRESET_REGISTRY,
  resolveEffectiveTone,
  type TonePresetId,
} from '@pathfinder/contracts/tone-presets'

import { useTRPCClient } from '../lib/trpc'

type AiConfig = {
  aiGuideNotes: string | null
  aiFeaturedPlaceId: string | null
  aiTone: string | null
  tonePreset?: string | null
  tonePresetVersion?: number | null
  aiGuideName: string | null
}

type AiControlsFormProps = {
  initialVenueId: string
  initialConfig: AiConfig
  /** Retained while older server components still provide this prop. */
  initialPlaces?: Array<{ id: string; name: string }>
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Your tone could not be saved. Please try again.'
}

export function AiControlsForm({ initialVenueId, initialConfig }: AiControlsFormProps) {
  const client = useTRPCClient()
  const [tonePreset, setTonePreset] = useState<TonePresetId>(
    resolveEffectiveTone(initialConfig).preset,
  )
  const [isSaving, setIsSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const mutationInFlight = useRef(false)

  useEffect(() => {
    if (!successMessage) return
    const timeoutId = window.setTimeout(() => setSuccessMessage(null), 3000)
    return () => window.clearTimeout(timeoutId)
  }, [successMessage])

  function selectTone(nextPreset: TonePresetId) {
    setTonePreset(nextPreset)
    setFormError(null)
    setSuccessMessage(null)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (mutationInFlight.current) return

    mutationInFlight.current = true
    setFormError(null)
    setSuccessMessage(null)
    setIsSaving(true)

    try {
      // Only the client-owned preference is written. Hidden operator guidance,
      // featured content, and guide identity remain untouched on the server.
      await client.venue.updateAiConfig.mutate({ venueId: initialVenueId, tonePreset })
      setSuccessMessage('Tone saved. New conversations will use this voice.')
    } catch (error) {
      setFormError(errorMessage(error))
    } finally {
      mutationInFlight.current = false
      setIsSaving(false)
    }
  }

  return (
    <form className="space-y-6" onSubmit={handleSubmit} aria-busy={isSaving}>
      <section className="rounded-[2rem] border border-pf-light bg-white p-6 shadow-sm sm:p-8">
        <h2 id="tone-heading" className="text-2xl font-semibold tracking-tight text-pf-deep">
          How should PathFinder sound?
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-pf-deep/75">
          Choose the voice that best fits your visitors. Safety and factual guidance stay the same.
        </p>

        <div
          role="group"
          aria-labelledby="tone-heading"
          className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
        >
          {TONE_PRESET_IDS.map((presetId) => {
            const preset = TONE_PRESET_REGISTRY[presetId]
            const selected = tonePreset === presetId

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

      <button
        type="submit"
        disabled={isSaving}
        className="inline-flex min-h-12 items-center rounded-full bg-pf-primary px-6 text-sm font-semibold text-white transition hover:bg-pf-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2 disabled:opacity-50"
      >
        {isSaving ? 'Saving tone…' : 'Save tone'}
      </button>
    </form>
  )
}
