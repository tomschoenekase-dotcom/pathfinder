'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Controller, type Resolver, useForm } from 'react-hook-form'

import { CreatePlaceInput, UpdatePlaceInput } from '@pathfinder/api/schemas'
import type { Place } from '@pathfinder/db'

import { createTRPCClient } from '../lib/trpc'

type PlaceFormValues = {
  id: string | undefined
  venueId: string | undefined
  name: string
  type: string
  shortDescription: string | undefined
  longDescription: string | undefined
  lat: number
  lng: number
  tags: string[]
  importanceScore: number
  areaName: string | undefined
  hours: string | undefined
  photoUrl: string | undefined
  isActive: boolean | undefined
}

type PlaceFormProps = {
  mode: 'create' | 'edit'
  venueId: string
  placeId?: string
  initialValues?: PlaceFormValues
}

const PLACE_TYPE_SUGGESTIONS = [
  'attraction',
  'amenity',
  'restroom',
  'food',
  'seating',
  'exhibit',
  'scenic_spot',
  'entrance',
] as const

function parseNumber(value: string, fallback?: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : (fallback ?? 0)
}

function splitTags(value: string): string[] {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return 'Something went wrong. Please try again.'
}

function hasAdvancedFields(
  values: Pick<
    PlaceFormValues,
    'longDescription' | 'tags' | 'importanceScore' | 'areaName' | 'hours' | 'photoUrl'
  >,
): boolean {
  return Boolean(
    values.longDescription ||
    values.tags.length > 0 ||
    values.importanceScore !== 0 ||
    values.areaName ||
    values.hours ||
    values.photoUrl,
  )
}

function mapPlaceToValues(
  place: Pick<
    Place,
    | 'id'
    | 'venueId'
    | 'name'
    | 'type'
    | 'shortDescription'
    | 'longDescription'
    | 'lat'
    | 'lng'
    | 'tags'
    | 'importanceScore'
    | 'areaName'
    | 'hours'
    | 'photoUrl'
    | 'isActive'
  >,
): PlaceFormValues {
  return {
    id: place.id,
    venueId: place.venueId,
    name: place.name,
    type: place.type,
    shortDescription: place.shortDescription ?? '',
    longDescription: place.longDescription ?? '',
    lat: place.lat,
    lng: place.lng,
    tags: place.tags,
    importanceScore: place.importanceScore,
    areaName: place.areaName ?? '',
    hours: place.hours ?? '',
    photoUrl: place.photoUrl ?? '',
    isActive: place.isActive,
  }
}

export function PlaceForm({ mode, venueId, placeId, initialValues }: PlaceFormProps) {
  const router = useRouter()
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) clientRef.current = createTRPCClient()
  const client = clientRef.current
  const [formError, setFormError] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(
    initialValues ? hasAdvancedFields(initialValues) : false,
  )
  const [isLoadingPlace, setIsLoadingPlace] = useState(mode === 'edit' && !initialValues)
  const resolver =
    mode === 'create'
      ? (zodResolver(CreatePlaceInput.passthrough()) as unknown as Resolver<PlaceFormValues>)
      : (zodResolver(UpdatePlaceInput.passthrough()) as unknown as Resolver<PlaceFormValues>)
  const {
    control,
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
    reset,
  } = useForm<PlaceFormValues>({
    resolver,
    defaultValues: initialValues ?? {
      id: placeId,
      venueId,
      name: '',
      type: 'attraction',
      shortDescription: '',
      longDescription: '',
      lat: 0,
      lng: 0,
      tags: [],
      importanceScore: 0,
      areaName: '',
      hours: '',
      photoUrl: '',
      isActive: true,
    },
  })

  useEffect(() => {
    let disposed = false

    async function loadPlace() {
      if (initialValues) {
        reset(initialValues)
        setShowAdvanced(hasAdvancedFields(initialValues))
        setIsLoadingPlace(false)
        return
      }

      if (mode !== 'edit' || !placeId) {
        return
      }

      setIsLoadingPlace(true)
      setFormError(null)

      try {
        const place = await client.place.getById.query({ id: placeId })
        const nextValues = mapPlaceToValues(place)

        if (!disposed) {
          reset(nextValues)
          setShowAdvanced(hasAdvancedFields(nextValues))
        }
      } catch (error) {
        if (!disposed) {
          setFormError(getErrorMessage(error))
        }
      } finally {
        if (!disposed) {
          setIsLoadingPlace(false)
        }
      }
    }

    void loadPlace()

    return () => {
      disposed = true
    }
  }, [client, initialValues, mode, placeId, reset])

  useEffect(() => {
    if (mode === 'create') {
      setShowAdvanced(false)
    }
  }, [mode])

  async function onSubmit(values: PlaceFormValues) {
    setFormError(null)

    try {
      if (mode === 'create') {
        await client.place.create.mutate({
          venueId,
          name: values.name,
          type: values.type,
          lat: values.lat,
          lng: values.lng,
          tags: values.tags,
          importanceScore: values.importanceScore,
          shortDescription: values.shortDescription?.trim() || undefined,
          longDescription: values.longDescription?.trim() || undefined,
          areaName: values.areaName?.trim() || undefined,
          hours: values.hours?.trim() || undefined,
          photoUrl: values.photoUrl?.trim() || undefined,
        })
      } else {
        await client.place.update.mutate(
          UpdatePlaceInput.parse({
            id: placeId,
            name: values.name,
            type: values.type,
            lat: values.lat,
            lng: values.lng,
            tags: values.tags,
            importanceScore: values.importanceScore,
            shortDescription: values.shortDescription?.trim() || undefined,
            longDescription: values.longDescription?.trim() || undefined,
            areaName: values.areaName?.trim() || undefined,
            hours: values.hours?.trim() || undefined,
            photoUrl: values.photoUrl?.trim() || null,
            isActive: values.isActive,
          }),
        )
      }

      router.push(`/venues/${venueId}`)
      router.refresh()
    } catch (error) {
      setFormError(getErrorMessage(error))
    }
  }

  async function handleDelete() {
    if (mode !== 'edit' || !placeId) {
      return
    }

    const confirmed = window.confirm('Delete this place? This cannot be undone.')

    if (!confirmed) {
      return
    }

    setIsDeleting(true)
    setFormError(null)

    try {
      await client.place.delete.mutate({ id: placeId })
      router.push(`/venues/${venueId}`)
      router.refresh()
    } catch (error) {
      setFormError(getErrorMessage(error))
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-6 space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
          {mode === 'create' ? 'Add place' : 'Edit place'}
        </h1>
        <p className="text-sm leading-6 text-slate-600">
          {mode === 'create'
            ? 'Create a new point of interest for this venue.'
            : 'Update the place data that powers the public chat experience.'}
        </p>
      </div>

      {isLoadingPlace ? (
        <p className="text-sm text-slate-500">Loading place...</p>
      ) : (
        <form className="space-y-5" onSubmit={handleSubmit(onSubmit)}>
          <input type="hidden" {...register('venueId')} value={venueId} />
          {mode === 'edit' ? <input type="hidden" {...register('id')} value={placeId} /> : null}

          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor="place-name">
                Name
              </label>
              <input
                id="place-name"
                className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                {...register('name')}
              />
              {errors.name ? (
                <p className="mt-2 text-sm text-rose-600">{errors.name.message}</p>
              ) : null}
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor="place-type">
                Type
              </label>
              <input
                id="place-type"
                list="place-type-suggestions"
                className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                {...register('type')}
              />
              <datalist id="place-type-suggestions">
                {PLACE_TYPE_SUGGESTIONS.map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
              {errors.type ? (
                <p className="mt-2 text-sm text-rose-600">{errors.type.message}</p>
              ) : null}
            </div>

            <div className="sm:col-span-2">
              <label
                className="mb-2 block text-sm font-medium text-slate-700"
                htmlFor="place-short-description"
              >
                Short description
              </label>
              <textarea
                id="place-short-description"
                className="min-h-24 w-full rounded-2xl border border-slate-300 px-4 py-3 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                {...register('shortDescription')}
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor="place-lat">
                Latitude
              </label>
              <Controller
                control={control}
                name="lat"
                render={({ field }) => (
                  <input
                    id="place-lat"
                    inputMode="decimal"
                    className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                    value={field.value}
                    onChange={(event) => {
                      field.onChange(parseNumber(event.target.value, field.value))
                    }}
                  />
                )}
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor="place-lng">
                Longitude
              </label>
              <Controller
                control={control}
                name="lng"
                render={({ field }) => (
                  <input
                    id="place-lng"
                    inputMode="decimal"
                    className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                    value={field.value}
                    onChange={(event) => {
                      field.onChange(parseNumber(event.target.value, field.value))
                    }}
                  />
                )}
              />
            </div>
          </div>

          <details
            className="group rounded-2xl border border-slate-200"
            open={showAdvanced}
            onToggle={(event) => setShowAdvanced((event.target as HTMLDetailsElement).open)}
          >
            <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-sm font-medium text-slate-700">
              <span>Advanced options</span>
              <span className="text-xs text-slate-400 group-open:hidden">Show</span>
              <span className="hidden text-xs text-slate-400 group-open:inline">Hide</span>
            </summary>
            <div className="grid gap-5 border-t border-slate-200 px-5 pb-5 pt-5 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label
                  className="mb-2 block text-sm font-medium text-slate-700"
                  htmlFor="place-long-description"
                >
                  Long description
                </label>
                <textarea
                  id="place-long-description"
                  className="min-h-32 w-full rounded-2xl border border-slate-300 px-4 py-3 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                  {...register('longDescription')}
                />
              </div>

              <div>
                <label
                  className="mb-2 block text-sm font-medium text-slate-700"
                  htmlFor="place-tags"
                >
                  Tags
                </label>
                <Controller
                  control={control}
                  name="tags"
                  render={({ field }) => (
                    <input
                      id="place-tags"
                      className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                      placeholder="family, indoor, water"
                      value={field.value.join(', ')}
                      onChange={(event) => {
                        field.onChange(splitTags(event.target.value))
                      }}
                    />
                  )}
                />
              </div>

              <div>
                <label
                  className="mb-2 block text-sm font-medium text-slate-700"
                  htmlFor="place-importance"
                >
                  Importance score
                </label>
                <Controller
                  control={control}
                  name="importanceScore"
                  render={({ field }) => (
                    <input
                      id="place-importance"
                      inputMode="numeric"
                      className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                      value={field.value}
                      onChange={(event) => {
                        field.onChange(parseNumber(event.target.value, field.value))
                      }}
                    />
                  )}
                />
              </div>

              <div>
                <label
                  className="mb-2 block text-sm font-medium text-slate-700"
                  htmlFor="place-area"
                >
                  Area name
                </label>
                <input
                  id="place-area"
                  className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                  {...register('areaName')}
                />
              </div>

              <div>
                <label
                  className="mb-2 block text-sm font-medium text-slate-700"
                  htmlFor="place-hours"
                >
                  Hours
                </label>
                <input
                  id="place-hours"
                  className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                  {...register('hours')}
                />
              </div>

              <div className="sm:col-span-2">
                <label
                  className="mb-2 block text-sm font-medium text-slate-700"
                  htmlFor="place-photo-url"
                >
                  Photo URL
                </label>
                <input
                  id="place-photo-url"
                  type="text"
                  placeholder="https://..."
                  className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                  {...register('photoUrl')}
                />
                <p className="mt-1 text-xs text-slate-500">
                  Shown as a card in the visitor chat when this place is recommended.
                </p>
                {errors.photoUrl ? (
                  <p className="mt-2 text-sm text-rose-600">{errors.photoUrl.message}</p>
                ) : null}
              </div>

              <Controller
                control={control}
                name="isActive"
                render={({ field }) => (
                  <label className="flex items-center gap-3 rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-700 sm:col-span-2">
                    <input
                      className="h-4 w-4"
                      type="checkbox"
                      checked={field.value ?? true}
                      onChange={(e) => field.onChange(e.target.checked)}
                    />
                    Place is active
                  </label>
                )}
              />
            </div>
          </details>

          {formError ? (
            <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {formError}
            </p>
          ) : null}

          <div className="flex items-center justify-between gap-4">
            {mode === 'edit' ? (
              <button
                type="button"
                disabled={isDeleting || isSubmitting}
                onClick={() => {
                  void handleDelete()
                }}
                className="inline-flex min-h-11 items-center rounded-full border border-rose-200 px-5 text-sm font-medium text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isDeleting ? 'Deleting...' : 'Delete place'}
              </button>
            ) : (
              <div />
            )}

            <button
              className="inline-flex min-h-11 items-center rounded-full bg-slate-900 px-5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
              disabled={isSubmitting || isDeleting}
              type="submit"
            >
              {isSubmitting ? 'Saving...' : mode === 'create' ? 'Add place' : 'Save changes'}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
