'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Controller, useForm } from 'react-hook-form'
import { CheckCircle2 } from 'lucide-react'

import { CreateVenueInput, KnowledgeEntryInput, PlaceInput } from '@pathfinder/api/schemas'

import { useTRPCClient } from '../../../../lib/trpc'

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
  guideMode: true,
}).required({
  name: true,
  slug: true,
  category: true,
  guideMode: true,
})

const VenueLocationSchema = CreateVenueInput.pick({
  defaultCenterLat: true,
  defaultCenterLng: true,
}).required({
  defaultCenterLat: true,
  defaultCenterLng: true,
})

const FirstPlaceSchema = PlaceInput.omit({
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

const FirstKnowledgeSchema = KnowledgeEntryInput.omit({ isEnabled: true }).required({
  title: true,
  category: true,
  content: true,
})

type VenueBasicsValues = {
  name: string
  slug: string
  category: string
  guideMode: 'location_aware' | 'non_location'
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

type FirstKnowledgeValues = {
  title: string
  category: string
  content: string
}

type FirstContentKind = 'place' | 'knowledge'

type InitialContentSubmission =
  | {
      kind: 'place'
      value: FirstPlaceValues & { tags: string[]; importanceScore: number }
    }
  | { kind: 'knowledge'; value: FirstKnowledgeValues }

type SetupState = {
  venue: VenueBasicsValues & {
    defaultCenterLat: number | undefined
    defaultCenterLng: number | undefined
  }
  contentKind: FirstContentKind | null
  place: FirstPlaceValues
  knowledge: FirstKnowledgeValues
}

type SetupStep = 'basics' | 'location' | 'content-kind' | 'place' | 'knowledge'

const INITIAL_STATE: SetupState = {
  venue: {
    name: '',
    slug: '',
    category: '',
    guideMode: 'location_aware',
    defaultCenterLat: undefined,
    defaultCenterLng: undefined,
  },
  contentKind: null,
  place: {
    name: '',
    type: 'EXHIBIT',
    shortDescription: '',
  },
  knowledge: {
    title: '',
    category: 'GENERAL',
    content: '',
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

function getSetupSteps(
  guideMode: VenueBasicsValues['guideMode'],
  contentKind: FirstContentKind | null,
) {
  return [
    { id: 'basics', label: 'Venue info', title: 'Tell us about your venue' },
    ...(guideMode === 'location_aware'
      ? [{ id: 'location', label: 'Location', title: 'Set the venue center' }]
      : []),
    { id: 'content-kind', label: 'Content type', title: 'Choose your first public content' },
    {
      id: 'content',
      label: 'First content',
      title:
        contentKind === 'knowledge'
          ? 'Add venue knowledge'
          : contentKind === 'place'
            ? 'Add a place or guide item'
            : 'Add your first public content',
    },
    { id: 'done', label: 'Done', title: 'Review your setup' },
  ]
}

function StepIndicator({
  currentStep,
  contentKind,
  guideMode,
}: {
  currentStep: SetupStep
  contentKind: FirstContentKind | null
  guideMode: VenueBasicsValues['guideMode']
}) {
  const steps = getSetupSteps(guideMode, contentKind)
  const indicatorStep =
    currentStep === 'place' || currentStep === 'knowledge' ? 'content' : currentStep
  const currentIndex = Math.max(
    0,
    steps.findIndex((step) => step.id === indicatorStep),
  )
  const currentTitle = steps[currentIndex]?.title ?? steps[0]!.title

  return (
    <div className="mt-8">
      <p className="text-sm font-medium text-pf-light">
        Step {currentIndex + 1} of {steps.length} - {currentTitle}
      </p>
      <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center">
        {steps.map((step, index) => {
          const isActive = index === currentIndex
          const isComplete = index < currentIndex

          return (
            <div key={step.id} className="flex items-center gap-3 text-sm">
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full border text-xs ${
                  isActive || isComplete
                    ? 'border-pf-accent bg-pf-accent text-white'
                    : 'border-white/25 text-pf-light/50'
                }`}
              >
                {isActive || isComplete ? '' : index + 1}
              </span>
              <span
                className={
                  isActive
                    ? 'font-semibold text-white'
                    : isComplete
                      ? 'text-pf-light'
                      : 'text-pf-light/50'
                }
              >
                {step.label}
              </span>
              {index < steps.length - 1 ? (
                <span className="hidden h-px w-12 bg-pf-primary/30 md:block" aria-hidden="true" />
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
          <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Name your venue</h2>
          <p className="mt-2 text-sm leading-6 text-pf-deep/60">
            Start with its identity, then choose whether this guide uses visitor location.
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="mb-2 block text-sm font-medium text-pf-deep/70" htmlFor="venue-name">
              Venue name
            </label>
            <input
              id="venue-name"
              className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-pf-accent/20"
              {...register('name')}
            />
            <p className="mt-1 text-xs text-pf-deep/40">
              This is what guests will see in the chat header.
            </p>
            {errors.name ? (
              <p className="mt-2 text-sm text-rose-600">{errors.name.message}</p>
            ) : null}
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-pf-deep/70" htmlFor="venue-slug">
              Slug
            </label>
            <input
              id="venue-slug"
              className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-pf-accent/20"
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
              className="mb-2 block text-sm font-medium text-pf-deep/70"
              htmlFor="venue-category"
            >
              Venue category (optional)
            </label>
            <input
              id="venue-category"
              className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-pf-accent/20"
              placeholder="Museum, hotel, campus..."
              {...register('category')}
            />
            <p className="mt-1 text-xs text-pf-deep/40">
              Descriptive only. It does not lock the venue into a product mode.
            </p>
            {errors.category ? (
              <p className="mt-2 text-sm text-rose-600">{errors.category.message}</p>
            ) : null}
          </div>

          <fieldset className="space-y-3 sm:col-span-2">
            <legend className="text-sm font-medium text-pf-deep/70">Guide style</legend>
            <label className="flex cursor-pointer gap-3 rounded-2xl border border-pf-light p-4">
              <input type="radio" value="location_aware" {...register('guideMode')} />
              <span>
                <span className="block text-sm font-semibold text-pf-deep">On-site guide</span>
                <span className="mt-1 block text-xs leading-5 text-pf-deep/50">
                  Uses visitor location for nearby places and directions when permission is shared.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer gap-3 rounded-2xl border border-pf-light p-4">
              <input type="radio" value="non_location" {...register('guideMode')} />
              <span>
                <span className="block text-sm font-semibold text-pf-deep">
                  Guide without visitor location
                </span>
                <span className="mt-1 block text-xs leading-5 text-pf-deep/50">
                  Answers venue questions without collecting or using visitor location.
                </span>
              </span>
            </label>
            {errors.guideMode ? (
              <p className="text-sm text-rose-600">{errors.guideMode.message}</p>
            ) : null}
          </fieldset>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-deep/70 transition hover:bg-pf-surface disabled:cursor-not-allowed disabled:opacity-50"
          disabled
          type="button"
          onClick={onBack}
        >
          Back
        </button>
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-full bg-pf-primary px-5 text-sm font-medium text-white transition hover:bg-pf-accent"
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
  defaultValues: {
    defaultCenterLat: number | undefined
    defaultCenterLng: number | undefined
  }
  onBack: (values: VenueLocationValues) => void
  onNext: (values: VenueLocationValues) => void
}) {
  const {
    control,
    formState: { errors },
    getValues,
    handleSubmit,
  } = useForm<VenueLocationValues>({
    resolver: zodResolver(VenueLocationSchema),
    defaultValues: {
      ...(defaultValues.defaultCenterLat !== undefined
        ? { defaultCenterLat: defaultValues.defaultCenterLat }
        : {}),
      ...(defaultValues.defaultCenterLng !== undefined
        ? { defaultCenterLng: defaultValues.defaultCenterLng }
        : {}),
    },
  })

  return (
    <form className="space-y-8" onSubmit={handleSubmit(onNext)}>
      <div className="space-y-5">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Set your location</h2>
          <p className="mt-2 text-sm leading-6 text-pf-deep/60">
            Coordinates start blank. Enter the venue&apos;s real center or main entrance.
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label className="mb-2 block text-sm font-medium text-pf-deep/70" htmlFor="venue-lat">
              Center latitude
            </label>
            <Controller
              control={control}
              name="defaultCenterLat"
              render={({ field }) => (
                <input
                  id="venue-lat"
                  inputMode="decimal"
                  className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-pf-accent/20"
                  value={field.value || field.value === 0 ? field.value : ''}
                  onChange={(event) => {
                    field.onChange(parseNumber(event.target.value))
                  }}
                />
              )}
            />
            <p className="mt-1 text-xs text-pf-deep/40">
              Used to order venue content when a guest has not shared a live position. It is never
              treated as the guest&apos;s location.
            </p>
            {errors.defaultCenterLat ? (
              <p className="mt-2 text-sm text-rose-600">{errors.defaultCenterLat.message}</p>
            ) : null}
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-pf-deep/70" htmlFor="venue-lng">
              Center longitude
            </label>
            <Controller
              control={control}
              name="defaultCenterLng"
              render={({ field }) => (
                <input
                  id="venue-lng"
                  inputMode="decimal"
                  className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-pf-accent/20"
                  value={field.value || field.value === 0 ? field.value : ''}
                  onChange={(event) => {
                    field.onChange(parseNumber(event.target.value))
                  }}
                />
              )}
            />
            <p className="mt-1 text-xs text-pf-deep/40">
              Right-click the venue center or main entrance in your map tool and copy its longitude.
            </p>
            {errors.defaultCenterLng ? (
              <p className="mt-2 text-sm text-rose-600">{errors.defaultCenterLng.message}</p>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-deep/70 transition hover:bg-pf-surface"
          type="button"
          onClick={() => onBack(getValues())}
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

function ContentKindStep({
  defaultValue,
  onBack,
  onNext,
}: {
  defaultValue: FirstContentKind | null
  onBack: () => void
  onNext: (value: FirstContentKind) => void
}) {
  const [value, setValue] = useState<FirstContentKind | null>(defaultValue)
  const [showError, setShowError] = useState(false)
  const firstChoiceRef = useRef<HTMLInputElement>(null)

  return (
    <form
      className="space-y-8"
      onSubmit={(event) => {
        event.preventDefault()
        if (!value) {
          setShowError(true)
          firstChoiceRef.current?.focus()
          return
        }
        onNext(value)
      }}
    >
      <fieldset
        className="space-y-5"
        aria-describedby={showError ? 'first-content-kind-error' : undefined}
        aria-invalid={showError}
        aria-required="true"
      >
        <legend className="text-2xl font-semibold tracking-tight text-pf-deep">
          Choose your first public content
        </legend>
        <p className="text-sm leading-6 text-pf-deep/60">
          This content is available to guests using the public guide. Audience-restricted or
          employee-only content is not supported by this setup.
        </p>
        <label className="flex cursor-pointer gap-4 rounded-2xl border border-pf-light p-4">
          <input
            ref={firstChoiceRef}
            type="radio"
            name="first-content-kind"
            value="place"
            checked={value === 'place'}
            onChange={() => {
              setValue('place')
              setShowError(false)
            }}
          />
          <span>
            <span className="block font-semibold text-pf-deep">Place or guide item</span>
            <span className="mt-1 block text-sm text-pf-deep/60">
              An exhibit, room, landmark, amenity, service point, or other named item.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer gap-4 rounded-2xl border border-pf-light p-4">
          <input
            type="radio"
            name="first-content-kind"
            value="knowledge"
            checked={value === 'knowledge'}
            onChange={() => {
              setValue('knowledge')
              setShowError(false)
            }}
          />
          <span>
            <span className="block font-semibold text-pf-deep">Venue knowledge</span>
            <span className="mt-1 block text-sm text-pf-deep/60">
              A fact, policy, procedure, frequently asked question, or general answer.
            </span>
          </span>
        </label>
        {showError ? (
          <p id="first-content-kind-error" role="alert" className="text-sm text-rose-600">
            Choose a content type to continue.
          </p>
        ) : null}
      </fieldset>

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-deep/70 transition hover:bg-pf-surface"
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
  guideMode,
  isSubmitting,
  onBack,
  onSubmit,
}: {
  defaultValues: FirstPlaceValues
  guideMode: VenueBasicsValues['guideMode']
  isSubmitting: boolean
  onBack: (values: FirstPlaceValues) => void
  onSubmit: (values: FirstPlaceValues) => void
}) {
  const {
    formState: { errors },
    getValues,
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
          <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">
            {guideMode === 'location_aware'
              ? 'Add your central starting point'
              : 'Add your first place or guide item'}
          </h2>
          <p className="mt-2 text-sm leading-6 text-pf-deep/60">
            {guideMode === 'location_aware'
              ? 'Choose the main entrance or a central landmark at the center coordinates you entered.'
              : 'Add one named exhibit, room, service point, experience, or other guide item.'}
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="mb-2 block text-sm font-medium text-pf-deep/70" htmlFor="place-name">
              Guide item name
            </label>
            <input
              id="place-name"
              className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-pf-accent/20"
              {...register('name')}
            />
            <p className="mt-1 text-xs text-pf-deep/40">
              {guideMode === 'location_aware'
                ? 'This item starts at the venue center. You can add other precisely located items after setup.'
                : 'You can add and organize more guide content after setup.'}
            </p>
            {errors.name ? (
              <p className="mt-2 text-sm text-rose-600">{errors.name.message}</p>
            ) : null}
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-pf-deep/70" htmlFor="place-type">
              Category
            </label>
            <select
              id="place-type"
              className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-pf-accent/20"
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
              className="mb-2 block text-sm font-medium text-pf-deep/70"
              htmlFor="place-description"
            >
              Brief description
            </label>
            <textarea
              id="place-description"
              className="min-h-28 w-full rounded-2xl border border-pf-light px-4 py-3 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-pf-accent/20"
              {...register('shortDescription')}
            />
            {errors.shortDescription ? (
              <p className="mt-2 text-sm text-rose-600">{errors.shortDescription.message}</p>
            ) : null}
          </div>
        </div>
        <p className="rounded-2xl bg-pf-surface px-4 py-3 text-xs leading-5 text-pf-deep/40">
          {guideMode === 'location_aware'
            ? 'The server creates this central item at the validated venue center in the same atomic setup operation.'
            : 'This public guide item stores no venue center or item coordinates.'}
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-deep/70 transition hover:bg-pf-surface"
          type="button"
          onClick={() => onBack(getValues())}
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

function FirstKnowledgeStep({
  defaultValues,
  isSubmitting,
  onBack,
  onSubmit,
}: {
  defaultValues: FirstKnowledgeValues
  isSubmitting: boolean
  onBack: (values: FirstKnowledgeValues) => void
  onSubmit: (values: FirstKnowledgeValues) => void
}) {
  const {
    formState: { errors },
    getValues,
    handleSubmit,
    register,
  } = useForm<FirstKnowledgeValues>({
    resolver: zodResolver(FirstKnowledgeSchema),
    defaultValues,
  })

  return (
    <form className="space-y-8" onSubmit={handleSubmit(onSubmit)}>
      <div className="space-y-5">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">
            Add venue knowledge
          </h2>
          <p className="mt-2 text-sm leading-6 text-pf-deep/60">
            Add one fact, policy, procedure, or answer for the public guest guide. It is independent
            of visitor location and is not employee-only content.
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label
              className="mb-2 block text-sm font-medium text-pf-deep/70"
              htmlFor="knowledge-title"
            >
              Knowledge title
            </label>
            <input
              id="knowledge-title"
              className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-pf-accent/20"
              {...register('title')}
            />
            {errors.title ? (
              <p className="mt-2 text-sm text-rose-600">{errors.title.message}</p>
            ) : null}
          </div>

          <div>
            <label
              className="mb-2 block text-sm font-medium text-pf-deep/70"
              htmlFor="knowledge-category"
            >
              Knowledge category
            </label>
            <input
              id="knowledge-category"
              className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-pf-accent/20"
              {...register('category')}
            />
            {errors.category ? (
              <p className="mt-2 text-sm text-rose-600">{errors.category.message}</p>
            ) : null}
          </div>

          <div className="sm:col-span-2">
            <label
              className="mb-2 block text-sm font-medium text-pf-deep/70"
              htmlFor="knowledge-content"
            >
              Knowledge content
            </label>
            <textarea
              id="knowledge-content"
              className="min-h-32 w-full rounded-2xl border border-pf-light px-4 py-3 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-pf-accent/20"
              {...register('content')}
            />
            {errors.content ? (
              <p className="mt-2 text-sm text-rose-600">{errors.content.message}</p>
            ) : null}
          </div>
        </div>
        <p className="rounded-2xl bg-pf-surface px-4 py-3 text-xs leading-5 text-pf-deep/40">
          The server creates this enabled knowledge entry in the same atomic setup operation as the
          venue. No coordinates are attached to knowledge.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-deep/70 transition hover:bg-pf-surface"
          type="button"
          onClick={() => onBack(getValues())}
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
  const client = useTRPCClient()
  const [currentStep, setCurrentStep] = useState<SetupStep>('basics')
  const [setupState, setSetupState] = useState<SetupState>(INITIAL_STATE)
  const [formError, setFormError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isComplete, setIsComplete] = useState(false)
  const [completedVenueId, setCompletedVenueId] = useState<string | null>(null)
  const submissionInFlightRef = useRef(false)
  const totalSteps = getSetupSteps(setupState.venue.guideMode, setupState.contentKind).length

  useEffect(() => {
    if (!completedVenueId) {
      return
    }

    const redirectTimer = window.setTimeout(() => {
      router.push(`/venues/${completedVenueId}?onboarded=1`)
      router.refresh()
    }, 2000)

    return () => {
      window.clearTimeout(redirectTimer)
    }
  }, [completedVenueId, router])

  async function handleCreateVenue(initialContent: InitialContentSubmission) {
    if (submissionInFlightRef.current) return
    submissionInFlightRef.current = true
    setFormError(null)
    setIsSubmitting(true)

    try {
      const venue = await client.venue.create.mutate({
        name: setupState.venue.name,
        slug: setupState.venue.slug,
        ...(setupState.venue.category?.trim()
          ? { category: setupState.venue.category.trim() }
          : {}),
        guideMode: setupState.venue.guideMode,
        ...(setupState.venue.guideMode === 'location_aware'
          ? {
              defaultCenterLat: setupState.venue.defaultCenterLat!,
              defaultCenterLng: setupState.venue.defaultCenterLng!,
            }
          : {}),
        initialContent,
      })

      setIsComplete(true)
      setCompletedVenueId(venue.id)
    } catch (error) {
      submissionInFlightRef.current = false
      setFormError(getErrorMessage(error))
      setIsSubmitting(false)
    }
  }

  if (isComplete) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-pf-surface px-6 py-10">
        <section className="w-full max-w-xl rounded-3xl border border-emerald-200 bg-pf-white p-8 text-center shadow-sm">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
            <CheckCircle2 className="h-8 w-8" aria-hidden="true" />
          </div>
          <p className="mt-6 text-sm font-medium text-emerald-700">
            Step {totalSteps} of {totalSteps} - Done
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-pf-deep">
            Your venue setup is ready for review.
          </h1>
          <p className="mt-3 text-sm leading-6 text-pf-deep/60">
            Review the guide content and availability settings before sharing it with guests.
          </p>
          <p className="mt-6 text-sm font-medium text-emerald-700">
            Taking you to your dashboard...
          </p>
        </section>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-pf-surface px-6 py-10">
      <div className="mx-auto max-w-4xl space-y-8">
        <section className="rounded-[2rem] bg-pf-deep px-8 py-10 text-white shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-widest text-pf-light">
            Onboarding
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight">Set up your first venue</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-pf-light/70">
            Create the basics PathFinder needs to prepare your dashboard and AI guide for review.
          </p>
          <StepIndicator
            currentStep={currentStep}
            contentKind={setupState.contentKind}
            guideMode={setupState.venue.guideMode}
          />
        </section>

        {formError ? (
          <p
            role="alert"
            className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
          >
            {formError}
          </p>
        ) : null}

        <section className="rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
          {currentStep === 'basics' ? (
            <VenueBasicsStep
              defaultValues={{
                name: setupState.venue.name,
                slug: setupState.venue.slug,
                category: setupState.venue.category,
                guideMode: setupState.venue.guideMode,
              }}
              onBack={() => {}}
              onNext={(values) => {
                setSetupState((current) => ({
                  ...current,
                  venue: {
                    ...current.venue,
                    ...values,
                    ...(values.guideMode === 'non_location'
                      ? { defaultCenterLat: undefined, defaultCenterLng: undefined }
                      : {}),
                  },
                  place:
                    current.venue.guideMode !== values.guideMode
                      ? {
                          name: '',
                          type: values.guideMode === 'location_aware' ? 'ENTRANCE' : 'OTHER',
                          shortDescription: '',
                        }
                      : {
                          ...current.place,
                          type:
                            current.place.name.length > 0
                              ? current.place.type
                              : values.guideMode === 'location_aware'
                                ? 'ENTRANCE'
                                : 'OTHER',
                        },
                }))
                setCurrentStep(values.guideMode === 'location_aware' ? 'location' : 'content-kind')
              }}
            />
          ) : null}

          {currentStep === 'location' ? (
            <VenueLocationStep
              defaultValues={{
                defaultCenterLat: setupState.venue.defaultCenterLat,
                defaultCenterLng: setupState.venue.defaultCenterLng,
              }}
              onBack={(values) => {
                setSetupState((current) => ({
                  ...current,
                  venue: { ...current.venue, ...values },
                }))
                setCurrentStep('basics')
              }}
              onNext={(values) => {
                setSetupState((current) => ({
                  ...current,
                  venue: {
                    ...current.venue,
                    ...values,
                  },
                }))
                setCurrentStep('content-kind')
              }}
            />
          ) : null}

          {currentStep === 'content-kind' ? (
            <ContentKindStep
              defaultValue={setupState.contentKind}
              onBack={() => {
                setCurrentStep(
                  setupState.venue.guideMode === 'location_aware' ? 'location' : 'basics',
                )
              }}
              onNext={(contentKind) => {
                setSetupState((current) => ({ ...current, contentKind }))
                setCurrentStep(contentKind)
              }}
            />
          ) : null}

          {currentStep === 'place' ? (
            <FirstPlaceStep
              defaultValues={setupState.place}
              guideMode={setupState.venue.guideMode}
              isSubmitting={isSubmitting}
              onBack={(values) => {
                setSetupState((current) => ({ ...current, place: values }))
                setCurrentStep('content-kind')
              }}
              onSubmit={(values) => {
                setSetupState((current) => ({
                  ...current,
                  place: values,
                }))
                void handleCreateVenue({
                  kind: 'place',
                  value: { ...values, tags: [], importanceScore: 0 },
                })
              }}
            />
          ) : null}

          {currentStep === 'knowledge' ? (
            <FirstKnowledgeStep
              defaultValues={setupState.knowledge}
              isSubmitting={isSubmitting}
              onBack={(values) => {
                setSetupState((current) => ({ ...current, knowledge: values }))
                setCurrentStep('content-kind')
              }}
              onSubmit={(values) => {
                setSetupState((current) => ({ ...current, knowledge: values }))
                void handleCreateVenue({ kind: 'knowledge', value: values })
              }}
            />
          ) : null}
        </section>
      </div>
    </main>
  )
}
