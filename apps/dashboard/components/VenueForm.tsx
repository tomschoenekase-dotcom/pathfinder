'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Controller, type Resolver, useForm } from 'react-hook-form'

import { CreateVenueInput, UpdateVenueInput } from '@pathfinder/api/schemas'

import { useTRPCClient } from '../lib/trpc'

type VenueFormProps = {
  mode: 'create' | 'edit'
  venueId?: string
  initialValues?: {
    name: string
    slug: string
    description: string
    guideNotes: string
    category: string
    guideMode: 'location_aware' | 'non_location'
    defaultCenterLat: number | undefined
    defaultCenterLng: number | undefined
    updatedAt: string
  }
}

type VenueFormValues = {
  name: string
  slug: string | undefined
  description: string | undefined
  guideNotes: string | undefined
  category: string | undefined
  guideMode: 'location_aware' | 'non_location'
  defaultCenterLat: number | undefined
  defaultCenterLng: number | undefined
}

function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'Something went wrong. Please try again.'
}

export function VenueForm({ mode, venueId, initialValues }: VenueFormProps) {
  const router = useRouter()
  const client = useTRPCClient()
  const [formError, setFormError] = useState<string | null>(null)
  const isMountedRef = useRef(true)
  const mutationInFlightRef = useRef(false)
  const expectedUpdatedAtRef = useRef<Date | null>(
    initialValues ? new Date(initialValues.updatedAt) : null,
  )
  const [activeMutation, setActiveMutation] = useState<'save' | 'delete' | null>(null)
  const [isLoadingVenue, setIsLoadingVenue] = useState(mode === 'edit' && !initialValues)

  const resolver =
    mode === 'create'
      ? (zodResolver(CreateVenueInput.passthrough()) as unknown as Resolver<VenueFormValues>)
      : // id comes from the venueId prop, not the form — omit it from validation
        (zodResolver(
          UpdateVenueInput.omit({ id: true, expectedUpdatedAt: true }).passthrough(),
        ) as unknown as Resolver<VenueFormValues>)

  const {
    control,
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
    reset,
    watch,
  } = useForm<VenueFormValues>({
    resolver,
    defaultValues: initialValues ?? {
      name: '',
      slug: '',
      description: '',
      guideNotes: '',
      category: '',
      guideMode: 'location_aware',
      defaultCenterLat: undefined,
      defaultCenterLng: undefined,
    },
  })
  const guideMode = watch('guideMode')

  useEffect(() => {
    isMountedRef.current = true

    return () => {
      isMountedRef.current = false
      mutationInFlightRef.current = false
    }
  }, [])

  useEffect(() => {
    let disposed = false

    async function loadVenue() {
      if (initialValues) {
        reset(initialValues)
        expectedUpdatedAtRef.current = new Date(initialValues.updatedAt)
        setIsLoadingVenue(false)
        return
      }

      if (mode !== 'edit' || !venueId) return
      setIsLoadingVenue(true)
      setFormError(null)
      try {
        const venue = await client.venue.getById.query({ id: venueId })
        if (!disposed) {
          expectedUpdatedAtRef.current = venue.updatedAt
          reset({
            name: venue.name,
            slug: venue.slug,
            description: venue.description ?? '',
            guideNotes: venue.guideNotes ?? '',
            category: venue.category ?? '',
            guideMode: venue.guideMode === 'non_location' ? 'non_location' : 'location_aware',
            defaultCenterLat: venue.defaultCenterLat ?? undefined,
            defaultCenterLng: venue.defaultCenterLng ?? undefined,
          })
        }
      } catch (error) {
        if (!disposed) setFormError(getErrorMessage(error))
      } finally {
        if (!disposed) setIsLoadingVenue(false)
      }
    }

    void loadVenue()
    return () => {
      disposed = true
    }
  }, [client, initialValues, mode, venueId, reset])

  function startMutation(kind: 'save' | 'delete'): boolean {
    if (mutationInFlightRef.current) return false
    mutationInFlightRef.current = true
    setActiveMutation(kind)
    return true
  }

  function finishMutation() {
    mutationInFlightRef.current = false
    if (isMountedRef.current) setActiveMutation(null)
  }

  async function onSubmit(values: VenueFormValues) {
    setFormError(null)
    const defaultCenterLat =
      values.guideMode === 'non_location' ? undefined : values.defaultCenterLat
    const defaultCenterLng =
      values.guideMode === 'non_location' ? undefined : values.defaultCenterLng
    try {
      if (mode === 'create') {
        const venue = await client.venue.create.mutate({
          name: values.name,
          slug: values.slug?.trim() || undefined,
          description: values.description?.trim() || undefined,
          guideNotes: values.guideNotes?.trim() || undefined,
          category: values.category?.trim() || undefined,
          guideMode: values.guideMode,
          defaultCenterLat,
          defaultCenterLng,
        })
        if (isMountedRef.current) router.push(`/venues/${venue.id}`)
      } else {
        const expectedUpdatedAt = expectedUpdatedAtRef.current
        if (!expectedUpdatedAt) {
          setFormError('Venue revision is unavailable. Refresh and try again.')
          return
        }
        await client.venue.update.mutate({
          id: venueId!,
          expectedUpdatedAt,
          name: values.name,
          description: values.description?.trim() || undefined,
          guideNotes: values.guideNotes?.trim() || undefined,
          category: values.category?.trim() || undefined,
          guideMode: values.guideMode,
          defaultCenterLat,
          defaultCenterLng,
        })
        if (isMountedRef.current) router.push(`/venues/${venueId}`)
      }
      if (isMountedRef.current) router.refresh()
    } catch (error) {
      if (isMountedRef.current) setFormError(getErrorMessage(error))
    }
  }

  async function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    if (!startMutation('save')) {
      event.preventDefault()
      return
    }

    try {
      await handleSubmit(onSubmit, (fieldErrors) => {
        const messages = Object.entries(fieldErrors)
          .map(([field, err]) => `${field}: ${err?.message ?? 'invalid'}`)
          .join(', ')
        setFormError(`Validation failed — ${messages}`)
      })(event)
    } finally {
      finishMutation()
    }
  }

  async function handleDelete() {
    if (mode !== 'edit' || !venueId || mutationInFlightRef.current) return

    const confirmed = window.confirm('Delete this venue? This cannot be undone.')

    if (!confirmed) return

    if (!startMutation('delete')) return
    setFormError(null)

    try {
      await client.venue.delete.mutate({ id: venueId })
      if (isMountedRef.current) {
        router.push('/venues')
        router.refresh()
      }
    } catch (error) {
      if (isMountedRef.current) setFormError(getErrorMessage(error))
    } finally {
      finishMutation()
    }
  }

  const isMutating = activeMutation !== null || isSubmitting

  return (
    <section className="rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
      <div className="mb-6 space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-pf-deep">
          {mode === 'create' ? 'Create venue' : 'Edit venue'}
        </h1>
        <p className="text-sm leading-6 text-pf-deep/60">
          {mode === 'create'
            ? 'Set up a new venue for the Path Finder chat experience.'
            : 'Update venue details and guide context.'}
        </p>
      </div>

      {isLoadingVenue ? (
        <p className="text-sm text-pf-deep/50">Loading venue...</p>
      ) : (
        <form aria-busy={isMutating} className="space-y-5" onSubmit={handleFormSubmit}>
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label
                className="mb-2 block text-sm font-medium text-pf-deep/70"
                htmlFor="venue-name"
              >
                Name
              </label>
              <input
                id="venue-name"
                disabled={isMutating}
                className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
                {...register('name')}
              />
              {errors.name ? (
                <p className="mt-2 text-sm text-rose-600">{errors.name.message}</p>
              ) : null}
            </div>

            {mode === 'create' && (
              <div>
                <label
                  className="mb-2 block text-sm font-medium text-pf-deep/70"
                  htmlFor="venue-slug"
                >
                  Slug
                </label>
                <input
                  id="venue-slug"
                  disabled={isMutating}
                  className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
                  {...register('slug')}
                />
                {errors.slug ? (
                  <p className="mt-2 text-sm text-rose-600">{errors.slug.message}</p>
                ) : null}
              </div>
            )}

            <div>
              <label
                className="mb-2 block text-sm font-medium text-pf-deep/70"
                htmlFor="venue-category"
              >
                Category
              </label>
              <input
                id="venue-category"
                disabled={isMutating}
                className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
                {...register('category')}
              />
            </div>

            <fieldset
              className="sm:col-span-2 rounded-2xl border border-pf-light p-4"
              disabled={isMutating}
            >
              <legend className="px-1 text-sm font-medium text-pf-deep/70">
                Use location features?
              </legend>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <label className="flex cursor-pointer gap-3 rounded-2xl border border-pf-light p-4 transition hover:border-pf-accent">
                  <input
                    type="radio"
                    value="location_aware"
                    className="mt-1"
                    disabled={isMutating}
                    {...register('guideMode')}
                  />
                  <span>
                    <span className="block text-sm font-semibold text-pf-deep">Yes</span>
                    <span className="mt-1 block text-sm leading-6 text-pf-deep/60">
                      This venue uses physical guide items with coordinates.
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer gap-3 rounded-2xl border border-pf-light p-4 transition hover:border-pf-accent">
                  <input
                    type="radio"
                    value="non_location"
                    className="mt-1"
                    disabled={isMutating}
                    {...register('guideMode')}
                  />
                  <span>
                    <span className="block text-sm font-semibold text-pf-deep">No</span>
                    <span className="mt-1 block text-sm leading-6 text-pf-deep/60">
                      This venue is an exhibit, service, or informational guide.
                    </span>
                  </span>
                </label>
              </div>
            </fieldset>

            <div className="sm:col-span-2">
              <label
                className="mb-2 block text-sm font-medium text-pf-deep/70"
                htmlFor="venue-description"
              >
                Description
              </label>
              <textarea
                id="venue-description"
                disabled={isMutating}
                className="min-h-28 w-full rounded-2xl border border-pf-light px-4 py-3 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
                {...register('description')}
              />
            </div>

            <div className="sm:col-span-2">
              <label
                className="mb-2 block text-sm font-medium text-pf-deep/70"
                htmlFor="venue-guide-notes"
              >
                Guide notes
              </label>
              <p className="mb-2 text-xs text-pf-deep/40">
                2–3 sentences describing how the venue is laid out and how zones relate to each
                other. Goes directly to the AI on every chat.
              </p>
              <textarea
                id="venue-guide-notes"
                disabled={isMutating}
                className="min-h-28 w-full rounded-2xl border border-pf-light px-4 py-3 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
                {...register('guideNotes')}
              />
            </div>

            {guideMode !== 'non_location' ? (
              <>
                <div>
                  <label
                    className="mb-2 block text-sm font-medium text-pf-deep/70"
                    htmlFor="venue-lat"
                  >
                    Default center latitude
                  </label>
                  <Controller
                    control={control}
                    name="defaultCenterLat"
                    render={({ field }) => (
                      <input
                        id="venue-lat"
                        disabled={isMutating}
                        className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
                        inputMode="decimal"
                        value={field.value ?? ''}
                        onChange={(event) => {
                          field.onChange(parseOptionalNumber(event.target.value))
                        }}
                      />
                    )}
                  />
                </div>

                <div>
                  <label
                    className="mb-2 block text-sm font-medium text-pf-deep/70"
                    htmlFor="venue-lng"
                  >
                    Default center longitude
                  </label>
                  <Controller
                    control={control}
                    name="defaultCenterLng"
                    render={({ field }) => (
                      <input
                        id="venue-lng"
                        disabled={isMutating}
                        className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
                        inputMode="decimal"
                        value={field.value ?? ''}
                        onChange={(event) => {
                          field.onChange(parseOptionalNumber(event.target.value))
                        }}
                      />
                    )}
                  />
                </div>
              </>
            ) : null}
          </div>

          {formError ? (
            <p
              className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
              role="alert"
            >
              {formError}
            </p>
          ) : null}

          {mode === 'edit' ? (
            <p className="text-xs text-pf-deep/40">
              Venues with guide items cannot be deleted. Remove all guide items first.
            </p>
          ) : null}

          <div className="flex items-center justify-between gap-4">
            {mode === 'edit' ? (
              <button
                type="button"
                disabled={isMutating}
                onClick={() => {
                  void handleDelete()
                }}
                className="inline-flex min-h-11 items-center rounded-full border border-rose-200 px-5 text-sm font-medium text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {activeMutation === 'delete' ? 'Deleting...' : 'Delete venue'}
              </button>
            ) : (
              <div />
            )}

            <button
              className="inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-medium text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:bg-pf-light"
              disabled={isMutating}
              type="submit"
            >
              {activeMutation === 'save'
                ? 'Saving...'
                : mode === 'create'
                  ? 'Create venue'
                  : 'Save changes'}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
