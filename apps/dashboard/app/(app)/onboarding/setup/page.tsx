'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Controller, useForm } from 'react-hook-form'
import {
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  Compass,
  FileText,
  LoaderCircle,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'

import { CreateVenueInput, KnowledgeEntryInput, PlaceInput } from '@pathfinder/api/schemas'

import { useTRPCClient } from '../../../../lib/trpc'
import styles from './onboarding.module.css'

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
    { id: 'basics', label: 'Your venue', title: 'Tell us about your venue' },
    ...(guideMode === 'location_aware'
      ? [{ id: 'location', label: 'Visitor arrival', title: 'Set the venue center' }]
      : []),
    { id: 'content-kind', label: 'Starting point', title: 'Choose starting information' },
    {
      id: 'content',
      label: 'Share a detail',
      title:
        contentKind === 'knowledge'
          ? 'Add venue knowledge'
          : contentKind === 'place'
            ? 'Add a place or guide item'
            : 'Share starting information for review',
    },
    { id: 'done', label: 'Received', title: 'Information received' },
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
    <div className={styles.stepper} aria-label="Onboarding progress">
      <div className={styles.stepperHeading} aria-live="polite">
        <span>
          Step {currentIndex + 1} of {steps.length}
        </span>
        <span>{currentTitle}</span>
      </div>
      <div className={styles.stepTrack} aria-hidden="true">
        <span style={{ width: `${((currentIndex + 1) / steps.length) * 100}%` }} />
      </div>
      <ol className={styles.stepList}>
        {steps.map((step, index) => {
          const isActive = index === currentIndex
          const isComplete = index < currentIndex

          return (
            <li
              key={step.id}
              className={styles.stepItem}
              aria-current={isActive ? 'step' : undefined}
            >
              <span
                className={`${styles.stepDot} ${isActive ? styles.stepDotActive : ''} ${isComplete ? styles.stepDotComplete : ''}`}
              >
                {isComplete ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : index + 1}
              </span>
              <span className={isActive ? styles.stepLabelActive : styles.stepLabel}>
                {step.label}
              </span>
            </li>
          )
        })}
      </ol>
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
          <p className={styles.eyebrow}>A quick introduction</p>
          <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">
            Tell us where to begin
          </h2>
          <p className="mt-2 text-sm leading-6 text-pf-deep/75">
            A few basics help our team shape the right visitor experience. You can refine everything
            when your first preview is ready.
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="mb-2 block text-sm font-medium text-pf-deep/70" htmlFor="venue-name">
              Venue name
            </label>
            <input
              id="venue-name"
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={`venue-name-help${errors.name ? ' venue-name-error' : ''}`}
              className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-pf-accent/20"
              {...register('name')}
            />
            <p id="venue-name-help" className="mt-1 text-xs text-pf-deep/70">
              Use the name visitors already know.
            </p>
            {errors.name ? (
              <p id="venue-name-error" role="alert" className="mt-2 text-sm text-rose-700">
                {errors.name.message}
              </p>
            ) : null}
          </div>

          <div hidden>
            <label className="mb-2 block text-sm font-medium text-pf-deep/70" htmlFor="venue-slug">
              Slug
            </label>
            <input
              id="venue-slug"
              type="text"
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
            <p className="mt-1 text-xs text-pf-deep/70">
              Descriptive only. It does not lock the venue into a product mode.
            </p>
            {errors.category ? (
              <p className="mt-2 text-sm text-rose-600">{errors.category.message}</p>
            ) : null}
          </div>

          <fieldset className="space-y-3 sm:col-span-2">
            <legend className="text-sm font-medium text-pf-deep/70">
              How will visitors usually use Torchiko?
            </legend>
            <label className={styles.choiceCard}>
              <input type="radio" value="location_aware" {...register('guideMode')} />
              <span>
                <span className={styles.choiceTitle}>On-site guide</span>
                <span className="mt-1 block text-xs leading-5 text-pf-deep/70">
                  Help people explore nearby places and get directions while they visit.
                </span>
              </span>
            </label>
            <label className={styles.choiceCard}>
              <input type="radio" value="non_location" {...register('guideMode')} />
              <span>
                <span className={styles.choiceTitle}>Guide without visitor location</span>
                <span className="mt-1 block text-xs leading-5 text-pf-deep/70">
                  Answer questions anywhere, without asking visitors to share their location.
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
          Continue <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
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
          <p className={styles.eyebrow}>Visitor arrival</p>
          <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Set your location</h2>
          <p className="mt-2 text-sm leading-6 text-pf-deep/75">
            Share the center of your venue or its main entrance so nearby recommendations begin in
            the right place.
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
                  aria-invalid={errors.defaultCenterLat ? true : undefined}
                  aria-describedby={`venue-lat-help${errors.defaultCenterLat ? ' venue-lat-error' : ''}`}
                  inputMode="decimal"
                  className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-pf-accent/20"
                  value={field.value || field.value === 0 ? field.value : ''}
                  onChange={(event) => {
                    field.onChange(parseNumber(event.target.value))
                  }}
                />
              )}
            />
            <p id="venue-lat-help" className="mt-1 text-xs text-pf-deep/70">
              You can copy this from your venue&apos;s pin in any map app.
            </p>
            {errors.defaultCenterLat ? (
              <p id="venue-lat-error" role="alert" className="mt-2 text-sm text-rose-700">
                {errors.defaultCenterLat.message}
              </p>
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
                  aria-invalid={errors.defaultCenterLng ? true : undefined}
                  aria-describedby={`venue-lng-help${errors.defaultCenterLng ? ' venue-lng-error' : ''}`}
                  inputMode="decimal"
                  className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-pf-accent/20"
                  value={field.value || field.value === 0 ? field.value : ''}
                  onChange={(event) => {
                    field.onChange(parseNumber(event.target.value))
                  }}
                />
              )}
            />
            <p id="venue-lng-help" className="mt-1 text-xs text-pf-deep/70">
              Torchiko only uses this venue location; it is not a visitor&apos;s live location.
            </p>
            {errors.defaultCenterLng ? (
              <p id="venue-lng-error" role="alert" className="mt-2 text-sm text-rose-700">
                {errors.defaultCenterLng.message}
              </p>
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
          Continue <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
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
        <legend className="sr-only">Choose starting information</legend>
        <div>
          <p className={styles.eyebrow}>One useful starting point</p>
          <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">
            What should Torchiko learn first?
          </h2>
        </div>
        <p className="text-sm leading-6 text-pf-deep/75">
          Share one representative detail now. We&apos;ll use it to shape the first preview; your
          brochures, links, photos, and the rest can follow from your portal.
        </p>
        <p className="text-xs leading-5 text-pf-deep/70">
          Audience-restricted or employee-only content is not supported in the public experience.
        </p>
        <label className={styles.choiceCard}>
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
            <span className={styles.choiceTitle}>A place visitors ask about</span>
            <span className="sr-only">Place or guide item</span>
            <span className="mt-1 block text-sm text-pf-deep/75">
              For example, an entrance, exhibit, room, landmark, or service point.
            </span>
          </span>
        </label>
        <label className={styles.choiceCard}>
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
            <span className={styles.choiceTitle}>An answer visitors need</span>
            <span className="sr-only">Venue knowledge</span>
            <span className="mt-1 block text-sm text-pf-deep/75">
              For example, a policy, accessibility detail, frequently asked question, or useful
              fact.
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
          Continue <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
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
          <p className={styles.eyebrow}>A visitor-facing example</p>
          <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">
            {guideMode === 'location_aware'
              ? 'Add your central starting point'
              : 'Add your first place or guide item'}
          </h2>
          <p className="mt-2 text-sm leading-6 text-pf-deep/75">
            {guideMode === 'location_aware'
              ? 'Share a main entrance or central landmark. We will turn it into a polished part of your first preview.'
              : 'Share one named place or experience. A rough description is enough for us to begin.'}
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="mb-2 block text-sm font-medium text-pf-deep/70" htmlFor="place-name">
              Guide item name
            </label>
            <input
              id="place-name"
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={`place-name-help${errors.name ? ' place-name-error' : ''}`}
              className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-pf-accent/20"
              {...register('name')}
            />
            <p id="place-name-help" className="mt-1 text-xs text-pf-deep/70">
              Don&apos;t worry about perfect wording. Torchiko will organize and refine it for
              review.
            </p>
            {errors.name ? (
              <p id="place-name-error" role="alert" className="mt-2 text-sm text-rose-700">
                {errors.name.message}
              </p>
            ) : null}
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-pf-deep/70" htmlFor="place-type">
              Category
            </label>
            <select
              id="place-type"
              aria-invalid={errors.type ? true : undefined}
              aria-describedby={errors.type ? 'place-type-error' : undefined}
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
              <p id="place-type-error" role="alert" className="mt-2 text-sm text-rose-700">
                {errors.type.message}
              </p>
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
              aria-invalid={errors.shortDescription ? true : undefined}
              aria-describedby={errors.shortDescription ? 'place-description-error' : undefined}
              className="min-h-28 w-full rounded-2xl border border-pf-light px-4 py-3 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-pf-accent/20"
              {...register('shortDescription')}
            />
            {errors.shortDescription ? (
              <p id="place-description-error" role="alert" className="mt-2 text-sm text-rose-700">
                {errors.shortDescription.message}
              </p>
            ) : null}
          </div>
        </div>
        <p className={styles.reassurance}>
          <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
          Nothing goes live from this step. You&apos;ll review the visitor experience first.
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
          aria-label="Create venue"
          className="inline-flex min-h-11 items-center justify-center rounded-full bg-slate-900 px-5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
          disabled={isSubmitting}
          type="submit"
        >
          {isSubmitting ? (
            <>
              <LoaderCircle
                className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              Receiving your information...
            </>
          ) : (
            <>
              Send to Torchiko <Sparkles className="ml-2 h-4 w-4" aria-hidden="true" />
            </>
          )}
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
          <p className={styles.eyebrow}>A visitor-facing example</p>
          <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">
            Add venue knowledge
          </h2>
          <p className="mt-2 text-sm leading-6 text-pf-deep/75">
            Share one question and the answer your staff would give. Notes and rough wording are
            welcome—we&apos;ll shape them for your first preview.
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
              aria-invalid={errors.title ? true : undefined}
              aria-describedby={errors.title ? 'knowledge-title-error' : undefined}
              className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-pf-accent/20"
              {...register('title')}
            />
            {errors.title ? (
              <p id="knowledge-title-error" role="alert" className="mt-2 text-sm text-rose-700">
                {errors.title.message}
              </p>
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
              aria-invalid={errors.category ? true : undefined}
              aria-describedby={errors.category ? 'knowledge-category-error' : undefined}
              className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-pf-accent/20"
              {...register('category')}
            />
            {errors.category ? (
              <p id="knowledge-category-error" role="alert" className="mt-2 text-sm text-rose-700">
                {errors.category.message}
              </p>
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
              aria-invalid={errors.content ? true : undefined}
              aria-describedby={errors.content ? 'knowledge-content-error' : undefined}
              className="min-h-32 w-full rounded-2xl border border-pf-light px-4 py-3 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-pf-accent/20"
              {...register('content')}
            />
            {errors.content ? (
              <p id="knowledge-content-error" role="alert" className="mt-2 text-sm text-rose-700">
                {errors.content.message}
              </p>
            ) : null}
          </div>
        </div>
        <p className={styles.reassurance}>
          <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
          Nothing goes live from this step. You&apos;ll review the visitor experience first.
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
          aria-label="Create venue"
          className="inline-flex min-h-11 items-center justify-center rounded-full bg-slate-900 px-5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
          disabled={isSubmitting}
          type="submit"
        >
          {isSubmitting ? (
            <>
              <LoaderCircle
                className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              Receiving your information...
            </>
          ) : (
            <>
              Send to Torchiko <Sparkles className="ml-2 h-4 w-4" aria-hidden="true" />
            </>
          )}
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
  const submissionIdentityRef = useRef<{ requestId: string; fingerprint: string } | null>(null)
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
      const rawContent =
        initialContent.kind === 'place'
          ? {
              kind: 'place' as const,
              value: {
                name: initialContent.value.name,
                type: initialContent.value.type,
                shortDescription: initialContent.value.shortDescription,
              },
            }
          : initialContent
      const venue = {
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
      }
      const fingerprint = JSON.stringify({ venue, rawContent })
      if (submissionIdentityRef.current?.fingerprint !== fingerprint) {
        submissionIdentityRef.current = { requestId: crypto.randomUUID(), fingerprint }
      }
      const result = await client.intake.submitOnboardingBootstrap.mutate({
        requestId: submissionIdentityRef.current.requestId,
        venue,
        rawContent,
      })

      setIsComplete(true)
      setCompletedVenueId(result.venue.id)
    } catch (error) {
      submissionInFlightRef.current = false
      setFormError(getErrorMessage(error))
      setIsSubmitting(false)
    }
  }

  if (isComplete) {
    return (
      <main className={styles.completePage}>
        <section className={styles.completeCard} aria-labelledby="received-title">
          <div className={styles.successMark}>
            <CheckCircle2 className="h-8 w-8" aria-hidden="true" />
          </div>
          <p className={styles.eyebrow}>
            Step {totalSteps} of {totalSteps} - Information received
          </p>
          <h1 id="received-title" className={styles.completeTitle}>
            Your starting information is awaiting review.
          </h1>
          <p className={styles.completeCopy}>
            We&apos;ve created a private venue shell and saved your information as a review
            proposal. No guide content was created, applied, or published.
          </p>
          <ol className={styles.buildMilestones} aria-label="What happens next">
            <li className={styles.milestoneComplete}>
              <Check className="h-4 w-4" aria-hidden="true" />
              <span>
                <strong>Information received</strong>
                <small>Your starting details are secure.</small>
              </span>
            </li>
            <li className={styles.milestoneActive}>
              <LoaderCircle className="h-4 w-4" aria-hidden="true" />
              <span>
                <strong>Torchiko review pending</strong>
                <small>Your raw information has not been added to the visitor guide.</small>
              </span>
            </li>
            <li>
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              <span>
                <strong>First preview</strong>
                <small>You&apos;ll review before anything goes live.</small>
              </span>
            </li>
          </ol>
          <p className={styles.redirectNote} aria-live="polite">
            Taking you to your Torchiko...
          </p>
        </section>
      </main>
    )
  }

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <section className={styles.hero}>
          <div className={styles.brandLine}>
            <span className={styles.brandMark}>
              <Compass className="h-5 w-5" aria-hidden="true" />
            </span>
            <span>TORCHIKO</span>
            <span className={styles.secureNote}>
              <ShieldCheck className="h-4 w-4" aria-hidden="true" /> Private setup
            </span>
          </div>
          <p className={styles.heroEyebrow}>Your visitor experience starts here</p>
          <h1>
            Give us the raw details.
            <br />
            <span>We&apos;ll build the Torchiko.</span>
          </h1>
          <p className={styles.heroCopy}>
            No chatbot configuration and no perfect copy required. Start with what you know; our
            team and tools will turn it into a polished experience for your review.
          </p>
          <StepIndicator
            currentStep={currentStep}
            contentKind={setupState.contentKind}
            guideMode={setupState.venue.guideMode}
          />
        </section>

        <div className={styles.workArea}>
          <aside className={styles.promisePanel} aria-label="What to expect">
            <p className={styles.eyebrow}>What to expect</p>
            <h2>A thoughtful first preview, built with you.</h2>
            <ul>
              <li>
                <Building2 aria-hidden="true" />
                <span>
                  <strong>You share the essentials</strong>
                  <small>A few venue details and one useful example.</small>
                </span>
              </li>
              <li>
                <FileText aria-hidden="true" />
                <span>
                  <strong>Add source material later</strong>
                  <small>Links, brochures, photos, video, and staff knowledge.</small>
                </span>
              </li>
              <li>
                <Sparkles aria-hidden="true" />
                <span>
                  <strong>Torchiko does the assembly</strong>
                  <small>We organize, refine, and prepare the visitor experience.</small>
                </span>
              </li>
              <li>
                <CheckCircle2 aria-hidden="true" />
                <span>
                  <strong>You stay in control</strong>
                  <small>Review the preview before anything is published.</small>
                </span>
              </li>
            </ul>
          </aside>

          <div className={styles.formColumn}>
            {formError ? (
              <p role="alert" className={styles.errorBanner}>
                {formError}
              </p>
            ) : null}

            <section className={styles.formCard}>
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
                    setCurrentStep(
                      values.guideMode === 'location_aware' ? 'location' : 'content-kind',
                    )
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
            <p className={styles.privacyLine}>
              <ShieldCheck aria-hidden="true" /> Your information stays private during setup.
            </p>
          </div>
        </div>
      </div>
    </main>
  )
}
