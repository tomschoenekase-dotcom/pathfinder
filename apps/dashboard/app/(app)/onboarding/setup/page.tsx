'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Controller, useForm } from 'react-hook-form'
import { CheckCircle2 } from 'lucide-react'

import { CreatePlaceInput, CreateVenueInput } from '@pathfinder/api/schemas'

import { createTRPCClient } from '../../../../lib/trpc'

const VENUE_CATEGORIES = [
  'ZOO',
  'AQUARIUM',
  'MUSEUM',
  'MALL',
  'SPORTS_VENUE',
  'PARK',
  'OTHER',
] as const

const PLACE_CATEGORIES = [
  'EXHIBIT',
  'DINING',
  'RESTROOM',
  'GIFT_SHOP',
  'FIRST_AID',
  'ENTRANCE',
  'OTHER',
] as const

const VenueBasicsSchema = CreateVenueInput.pick({
  name: true,
  slug: true,
  category: true,
}).required({
  name: true,
  slug: true,
  category: true,
})

const VenueLocationSchema = CreateVenueInput.pick({
  defaultCenterLat: true,
  defaultCenterLng: true,
}).required({
  defaultCenterLat: true,
  defaultCenterLng: true,
})

const FirstPlaceSchema = CreatePlaceInput.omit({
  venueId: true,
  lat: true,
  lng: true,
  tags: true,
  importanceScore: true,
  longDescription: true,
  areaName: true,
  hours: true,
  photoUrl: true,
}).required({
  name: true,
  type: true,
  shortDescription: true,
})

type VenueBasicsValues = {
  name: string
  slug: string
  category: string
}

type VenueLocationValues = {
  defaultCenterLat: number
  defaultCenterLng: number
}

type FirstPlaceValues = {
  name: string
  type: string
  shortDescription: string
}

type SetupState = {
  venue: VenueBasicsValues & VenueLocationValues
  place: FirstPlaceValues
}

const STEP_LABELS = ['Venue info', 'Venue location', 'First place'] as const

const STEP_TITLES = [
  'Tell us about your venue',
  'Set your venue center',
  'Add your first place',
] as const

const INITIAL_STATE: SetupState = {
  venue: {
    name: '',
    slug: '',
    category: 'AQUARIUM',
    defaultCenterLat: 0,
    defaultCenterLng: 0,
  },
  place: {
    name: '',
    type: 'EXHIBIT',
    shortDescription: '',
  },
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

function parseNumber(value: string): number | undefined {
  const trimmed = value.trim()

  if (!trimmed) {
    return undefined
  }

  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return 'Something went wrong. Please try again.'
}

function StepIndicator({ currentStep }: { currentStep: number }) {
  const currentTitle = STEP_TITLES[currentStep] ?? STEP_TITLES[0]

  return (
    <div className="mt-8">
      <p className="text-sm font-medium text-slate-200">
        Step {currentStep + 1} of 3 - {currentTitle}
      </p>
      <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center">
        {STEP_LABELS.map((label, index) => {
          const isActive = index === currentStep
          const isComplete = index < currentStep

          return (
            <div key={label} className="flex items-center gap-3 text-sm">
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full border text-xs ${
                  isActive || isComplete
                    ? 'border-cyan-300 bg-cyan-300 text-slate-950'
                    : 'border-white/25 text-slate-400'
                }`}
              >
                {isActive || isComplete ? '' : index + 1}
              </span>
              <span
                className={
                  isActive
                    ? 'font-semibold text-white'
                    : isComplete
                      ? 'text-cyan-100'
                      : 'text-slate-400'
                }
              >
                {label}
              </span>
              {index < STEP_LABELS.length - 1 ? (
                <span className="hidden h-px w-12 bg-white/20 md:block" aria-hidden="true" />
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function VenueBasicsStep({
  defaultValues,
  onBack,
  onNext,
}: {
  defaultValues: VenueBasicsValues
  onBack: () => void
  onNext: (values: VenueBasicsValues) => void
}) {
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(defaultValues.slug.length > 0)
  const {
    formState: { errors },
    handleSubmit,
    register,
    setValue,
    watch,
  } = useForm<VenueBasicsValues>({
    resolver: zodResolver(VenueBasicsSchema),
    defaultValues,
  })

  const venueName = watch('name')

  useEffect(() => {
    if (slugManuallyEdited) {
      return
    }

    setValue('slug', slugify(venueName), {
      shouldDirty: venueName.length > 0,
      shouldValidate: false,
    })
  }, [setValue, slugManuallyEdited, venueName])

  return (
    <form className="space-y-8" onSubmit={handleSubmit(onNext)}>
      <div className="space-y-5">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Name your venue</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Start with the venue name, public slug, and category.
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor="venue-name">
              Venue name
            </label>
            <input
              id="venue-name"
              className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              {...register('name')}
            />
            <p className="mt-1 text-xs text-slate-500">
              This is what guests will see in the chat header.
            </p>
            {errors.name ? (
              <p className="mt-2 text-sm text-rose-600">{errors.name.message}</p>
            ) : null}
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor="venue-slug">
              Slug
            </label>
            <input
              id="venue-slug"
              className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              {...register('slug', {
                onChange: () => {
                  setSlugManuallyEdited(true)
                },
              })}
            />
            {errors.slug ? (
              <p className="mt-2 text-sm text-rose-600">{errors.slug.message}</p>
            ) : null}
          </div>

          <div>
            <label
              className="mb-2 block text-sm font-medium text-slate-700"
              htmlFor="venue-category"
            >
              Category
            </label>
            <select
              id="venue-category"
              className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              {...register('category')}
            >
              {VENUE_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500">
              Helps PathFinder tailor responses for your venue type.
            </p>
            {errors.category ? (
              <p className="mt-2 text-sm text-rose-600">{errors.category.message}</p>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-slate-300 px-5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          disabled
          type="button"
          onClick={onBack}
        >
          Back
        </button>
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-full bg-slate-900 px-5 text-sm font-medium text-white transition hover:bg-slate-800"
          type="submit"
        >
          Continue
        </button>
      </div>
    </form>
  )
}

function VenueLocationStep({
  defaultValues,
  onBack,
  onNext,
}: {
  defaultValues: VenueLocationValues
  onBack: () => void
  onNext: (values: VenueLocationValues) => void
}) {
  const {
    control,
    formState: { errors },
    handleSubmit,
  } = useForm<VenueLocationValues>({
    resolver: zodResolver(VenueLocationSchema),
    defaultValues,
  })

  return (
    <form className="space-y-8" onSubmit={handleSubmit(onNext)}>
      <div className="space-y-5">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">
            Set your location
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Use Google Maps to find your venue&apos;s center coordinates.
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor="venue-lat">
              Center latitude
            </label>
            <Controller
              control={control}
              name="defaultCenterLat"
              render={({ field }) => (
                <input
                  id="venue-lat"
                  inputMode="decimal"
                  className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                  value={field.value || field.value === 0 ? field.value : ''}
                  onChange={(event) => {
                    field.onChange(parseNumber(event.target.value))
                  }}
                />
              )}
            />
            <p className="mt-1 text-xs text-slate-500">
              The center point of your venue - guests&apos; distances are measured from here. Use
              Google Maps to find coordinates: right-click any point on the map and copy the
              coordinates shown.
            </p>
            {errors.defaultCenterLat ? (
              <p className="mt-2 text-sm text-rose-600">{errors.defaultCenterLat.message}</p>
            ) : null}
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor="venue-lng">
              Center longitude
            </label>
            <Controller
              control={control}
              name="defaultCenterLng"
              render={({ field }) => (
                <input
                  id="venue-lng"
                  inputMode="decimal"
                  className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                  value={field.value || field.value === 0 ? field.value : ''}
                  onChange={(event) => {
                    field.onChange(parseNumber(event.target.value))
                  }}
                />
              )}
            />
            <p className="mt-1 text-xs text-slate-500">
              The center point of your venue - guests&apos; distances are measured from here. Use
              Google Maps to find coordinates: right-click any point on the map and copy the
              coordinates shown.
            </p>
            {errors.defaultCenterLng ? (
              <p className="mt-2 text-sm text-rose-600">{errors.defaultCenterLng.message}</p>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-slate-300 px-5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          type="button"
          onClick={onBack}
        >
          Back
        </button>
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-full bg-slate-900 px-5 text-sm font-medium text-white transition hover:bg-slate-800"
          type="submit"
        >
          Continue
        </button>
      </div>
    </form>
  )
}

function FirstPlaceStep({
  defaultValues,
  isSubmitting,
  formError,
  onBack,
  onSubmit,
}: {
  defaultValues: FirstPlaceValues
  isSubmitting: boolean
  formError: string | null
  onBack: () => void
  onSubmit: (values: FirstPlaceValues) => void
}) {
  const {
    formState: { errors },
    handleSubmit,
    register,
  } = useForm<FirstPlaceValues>({
    resolver: zodResolver(FirstPlaceSchema),
    defaultValues,
  })

  return (
    <form className="space-y-8" onSubmit={handleSubmit(onSubmit)}>
      <div className="space-y-5">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">
            Add your first place
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Add at least one place so your AI guide has something to talk about.
          </p>
        </div>

        {formError ? (
          <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {formError}
          </p>
        ) : null}

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor="place-name">
              Place name
            </label>
            <input
              id="place-name"
              className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              {...register('name')}
            />
            <p className="mt-1 text-xs text-slate-500">
              Add your most popular or iconic location first - you can add more after setup.
            </p>
            {errors.name ? (
              <p className="mt-2 text-sm text-rose-600">{errors.name.message}</p>
            ) : null}
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor="place-type">
              Category
            </label>
            <select
              id="place-type"
              className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              {...register('type')}
            >
              {PLACE_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
            {errors.type ? (
              <p className="mt-2 text-sm text-rose-600">{errors.type.message}</p>
            ) : null}
          </div>

          <div className="sm:col-span-2">
            <label
              className="mb-2 block text-sm font-medium text-slate-700"
              htmlFor="place-description"
            >
              Brief description
            </label>
            <textarea
              id="place-description"
              className="min-h-28 w-full rounded-2xl border border-slate-300 px-4 py-3 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              {...register('shortDescription')}
            />
            {errors.shortDescription ? (
              <p className="mt-2 text-sm text-rose-600">{errors.shortDescription.message}</p>
            ) : null}
          </div>
        </div>
        <p className="rounded-2xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500">
          Place coordinates start at your venue center for setup. Right-click in Google Maps to copy
          coordinates for this specific location, then fine-tune this place after setup.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-slate-300 px-5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          type="button"
          onClick={onBack}
        >
          Back
        </button>
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-full bg-slate-900 px-5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
          disabled={isSubmitting}
          type="submit"
        >
          {isSubmitting ? 'Creating venue...' : 'Create venue'}
        </button>
      </div>
    </form>
  )
}

export default function OnboardingSetupPage() {
  const router = useRouter()
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)

  if (clientRef.current === null) {
    clientRef.current = createTRPCClient()
  }

  const client = clientRef.current
  const [currentStep, setCurrentStep] = useState(0)
  const [setupState, setSetupState] = useState<SetupState>(INITIAL_STATE)
  const [formError, setFormError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isComplete, setIsComplete] = useState(false)

  async function handleCreateVenue(placeValues: FirstPlaceValues) {
    setFormError(null)
    setIsSubmitting(true)

    try {
      const venue = await client.venue.create.mutate({
        name: setupState.venue.name,
        slug: setupState.venue.slug,
        category: setupState.venue.category,
        defaultCenterLat: setupState.venue.defaultCenterLat,
        defaultCenterLng: setupState.venue.defaultCenterLng,
      })

      await client.place.create.mutate({
        venueId: venue.id,
        name: placeValues.name,
        type: placeValues.type,
        shortDescription: placeValues.shortDescription,
        lat: setupState.venue.defaultCenterLat,
        lng: setupState.venue.defaultCenterLng,
        tags: [],
        importanceScore: 0,
      })

      setCurrentStep(2)
      setIsComplete(true)
      window.setTimeout(() => {
        router.push(`/venues/${venue.id}?onboarded=1`)
        router.refresh()
      }, 2000)
    } catch (error) {
      setFormError(getErrorMessage(error))
      setIsSubmitting(false)
    }
  }

  if (isComplete) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6 py-10">
        <section className="w-full max-w-xl rounded-[2rem] border border-emerald-200 bg-white p-8 text-center shadow-sm">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
            <CheckCircle2 className="h-8 w-8" aria-hidden="true" />
          </div>
          <h1 className="mt-6 text-3xl font-semibold tracking-tight text-slate-950">
            Your venue is live.
          </h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            PathFinder is ready to guide your guests.
          </p>
          <p className="mt-6 text-sm font-medium text-emerald-700">
            Taking you to your dashboard...
          </p>
        </section>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10">
      <div className="mx-auto max-w-4xl space-y-8">
        <section className="rounded-[2rem] bg-slate-950 px-8 py-10 text-white shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-300">
            Onboarding
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight">Set up your first venue</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
            Create the basics PathFinder needs to launch your dashboard and AI guide.
          </p>
          <StepIndicator currentStep={currentStep} />
        </section>

        <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
          {currentStep === 0 ? (
            <VenueBasicsStep
              defaultValues={{
                name: setupState.venue.name,
                slug: setupState.venue.slug,
                category: setupState.venue.category,
              }}
              onBack={() => {}}
              onNext={(values) => {
                setSetupState((current) => ({
                  ...current,
                  venue: {
                    ...current.venue,
                    ...values,
                  },
                }))
                setCurrentStep(1)
              }}
            />
          ) : null}

          {currentStep === 1 ? (
            <VenueLocationStep
              defaultValues={{
                defaultCenterLat: setupState.venue.defaultCenterLat,
                defaultCenterLng: setupState.venue.defaultCenterLng,
              }}
              onBack={() => {
                setCurrentStep(0)
              }}
              onNext={(values) => {
                setSetupState((current) => ({
                  ...current,
                  venue: {
                    ...current.venue,
                    ...values,
                  },
                }))
                setCurrentStep(2)
              }}
            />
          ) : null}

          {currentStep === 2 ? (
            <FirstPlaceStep
              defaultValues={setupState.place}
              formError={formError}
              isSubmitting={isSubmitting}
              onBack={() => {
                setCurrentStep(1)
              }}
              onSubmit={(values) => {
                setSetupState((current) => ({
                  ...current,
                  place: values,
                }))
                void handleCreateVenue(values)
              }}
            />
          ) : null}
        </section>
      </div>
    </main>
  )
}
