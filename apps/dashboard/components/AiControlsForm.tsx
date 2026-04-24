'use client'

import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Bot, Sparkles } from 'lucide-react'

import { createTRPCClient } from '../lib/trpc'

type VenueOption = {
  id: string
  name: string
}

type PlaceOption = {
  id: string
  name: string
}

type AiConfig = {
  aiGuideNotes: string | null
  aiFeaturedPlaceId: string | null
  aiTone: string | null
}

type AiControlsFormProps = {
  venues: VenueOption[]
  initialVenueId: string
  initialConfig: AiConfig
  initialPlaces: PlaceOption[]
}

type ToneValue = 'FRIENDLY' | 'PROFESSIONAL' | 'PLAYFUL'

const TONE_OPTIONS: Array<{
  value: ToneValue
  label: string
  description: string
}> = [
  {
    value: 'FRIENDLY',
    label: 'Friendly',
    description: 'Warm, helpful, conversational. Good for most venues.',
  },
  {
    value: 'PROFESSIONAL',
    label: 'Professional',
    description: 'Clear and informative. Good for museums and educational venues.',
  },
  {
    value: 'PLAYFUL',
    label: 'Playful',
    description: 'Enthusiastic and fun. Great for zoos, aquariums, and family attractions.',
  },
]

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return 'Something went wrong. Please try again.'
}

export function AiControlsForm({
  venues,
  initialVenueId,
  initialConfig,
  initialPlaces,
}: AiControlsFormProps) {
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) {
    clientRef.current = createTRPCClient()
  }
  const client = clientRef.current

  const [selectedVenueId, setSelectedVenueId] = useState(initialVenueId)
  const [aiTone, setAiTone] = useState<ToneValue>(
    (initialConfig.aiTone as ToneValue | null) ?? 'FRIENDLY',
  )
  const [aiGuideNotes, setAiGuideNotes] = useState(initialConfig.aiGuideNotes ?? '')
  const [aiFeaturedPlaceId, setAiFeaturedPlaceId] = useState(initialConfig.aiFeaturedPlaceId ?? '')
  const [places, setPlaces] = useState<PlaceOption[]>(initialPlaces)
  const [isLoadingVenue, setIsLoadingVenue] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!successMessage) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setSuccessMessage(null)
    }, 3000)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [successMessage])

  useEffect(() => {
    let disposed = false

    async function loadVenueData() {
      if (selectedVenueId === initialVenueId) {
        setAiTone((initialConfig.aiTone as ToneValue | null) ?? 'FRIENDLY')
        setAiGuideNotes(initialConfig.aiGuideNotes ?? '')
        setAiFeaturedPlaceId(initialConfig.aiFeaturedPlaceId ?? '')
        setPlaces(initialPlaces)
        return
      }

      setIsLoadingVenue(true)
      setFormError(null)
      setSuccessMessage(null)

      try {
        const [config, venuePlaces] = await Promise.all([
          client.venue.getAiConfig.query({ venueId: selectedVenueId }),
          client.place.list.query({ venueId: selectedVenueId }),
        ])

        if (disposed) {
          return
        }

        setAiTone((config.aiTone as ToneValue | null) ?? 'FRIENDLY')
        setAiGuideNotes(config.aiGuideNotes ?? '')
        setAiFeaturedPlaceId(config.aiFeaturedPlaceId ?? '')
        setPlaces(venuePlaces.map((place) => ({ id: place.id, name: place.name })))
      } catch (error) {
        if (!disposed) {
          setFormError(getErrorMessage(error))
        }
      } finally {
        if (!disposed) {
          setIsLoadingVenue(false)
        }
      }
    }

    void loadVenueData()

    return () => {
      disposed = true
    }
  }, [client, initialConfig, initialPlaces, initialVenueId, selectedVenueId])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)
    setSuccessMessage(null)
    setIsSaving(true)

    try {
      await client.venue.updateAiConfig.mutate({
        venueId: selectedVenueId,
        aiTone,
        aiGuideNotes: aiGuideNotes.trim() ? aiGuideNotes.trim() : null,
        aiFeaturedPlaceId: aiFeaturedPlaceId || null,
      })

      setSuccessMessage('AI configuration saved.')
    } catch (error) {
      setFormError(getErrorMessage(error))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <form className="space-y-6" onSubmit={handleSubmit}>
      {venues.length > 1 ? (
        <section className="rounded-[2rem] border border-pf-light bg-pf-white p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
            Venue selector
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
            Choose a venue
          </h2>
          <select
            value={selectedVenueId}
            onChange={(event) => {
              setSelectedVenueId(event.target.value)
            }}
            className="mt-5 min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
          >
            {venues.map((venue) => (
              <option key={venue.id} value={venue.id}>
                {venue.name}
              </option>
            ))}
          </select>
        </section>
      ) : null}

      <section className="rounded-[2rem] border border-pf-light bg-pf-white p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-pf-deep text-pf-light">
            <Bot className="h-6 w-6" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">Tone</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
              Response tone
            </h2>
            <p className="mt-2 text-sm leading-6 text-pf-deep/60">
              Controls how the AI writes its responses to guests.
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          {TONE_OPTIONS.map((tone) => {
            const isSelected = aiTone === tone.value

            return (
              <button
                key={tone.value}
                type="button"
                onClick={() => {
                  setAiTone(tone.value)
                }}
                className={`rounded-[1.5rem] border p-5 text-left transition ${
                  isSelected
                    ? 'border-pf-accent bg-pf-accent/5'
                    : 'border-pf-light bg-pf-surface hover:border-pf-accent/40 hover:bg-pf-white'
                }`}
              >
                <p className="text-lg font-semibold text-pf-deep">{tone.label}</p>
                <p className="mt-2 text-sm leading-6 text-pf-deep/60">{tone.description}</p>
              </button>
            )
          })}
        </div>
      </section>

      <section className="rounded-[2rem] border border-pf-light bg-pf-white p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-pf-accent/10 text-pf-primary">
            <Sparkles className="h-6 w-6" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
              Featured place
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
              Highlight one place
            </h2>
            <p className="mt-2 text-sm leading-6 text-pf-deep/60">
              Pin a place that the assistant should mention when it is relevant.
            </p>
          </div>
        </div>

        <label className="mt-6 block text-sm font-medium text-pf-deep/70" htmlFor="featured-place">
          Featured place
        </label>
        <select
          id="featured-place"
          value={aiFeaturedPlaceId}
          disabled={isLoadingVenue || places.length === 0}
          onChange={(event) => {
            setAiFeaturedPlaceId(event.target.value)
          }}
          className="mt-3 min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20 disabled:bg-pf-surface"
        >
          <option value="">No featured place</option>
          {places.map((place) => (
            <option key={place.id} value={place.id}>
              {place.name}
            </option>
          ))}
        </select>
        <p className="mt-3 text-sm leading-6 text-pf-deep/60">
          {places.length === 0
            ? 'Add places to this venue before choosing a featured highlight.'
            : 'The AI will mention this place when it fits the guest question.'}
        </p>
      </section>

      <section className="rounded-[2rem] border border-pf-light bg-pf-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
          Guide notes
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
          Operator guide notes
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/60">
          These instructions are injected directly into the AI&apos;s context. Use them to highlight
          special events, set restrictions, or provide seasonal information.
        </p>

        <textarea
          value={aiGuideNotes}
          maxLength={2000}
          disabled={isLoadingVenue}
          onChange={(event) => {
            setAiGuideNotes(event.target.value)
          }}
          placeholder="e.g. The new butterfly exhibit opens this weekend. Always mention it when guests ask about new things to see. The food court closes at 4pm on weekdays."
          className="mt-6 min-h-40 w-full rounded-2xl border border-pf-light px-4 py-3 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20 disabled:bg-pf-surface"
        />
        <div className="mt-2 flex justify-between gap-4 text-xs text-pf-deep/40">
          <span>Keep instructions direct and operational.</span>
          <span>{aiGuideNotes.length}/2000</span>
        </div>
      </section>

      {formError ? (
        <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {formError}
        </p>
      ) : null}

      {successMessage ? (
        <p className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {successMessage}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={isSaving || isLoadingVenue}
        className="inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-medium text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:bg-pf-light"
      >
        {isSaving ? 'Saving...' : 'Save AI configuration'}
      </button>
    </form>
  )
}
