'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Controller, type Resolver, useForm } from 'react-hook-form'

import { CreateVenueInput, UpdateVenueInput } from '@pathfinder/api/schemas'

import { createTRPCClient } from '../lib/trpc'

type VenueFormProps = {
  mode: 'create' | 'edit'
  venueId?: string
}

type VenueFormValues = {
  name: string
  slug: string | undefined
  description: string | undefined
  guideNotes: string | undefined
  category: string | undefined
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

export function VenueForm({ mode, venueId }: VenueFormProps) {
  const router = useRouter()
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) clientRef.current = createTRPCClient()
  const client = clientRef.current
  const [formError, setFormError] = useState<string | null>(null)
  const [isLoadingVenue, setIsLoadingVenue] = useState(mode === 'edit')

  const resolver =
    mode === 'create'
      ? (zodResolver(CreateVenueInput.passthrough()) as unknown as Resolver<VenueFormValues>)
      : // id comes from the venueId prop, not the form — omit it from validation
        (zodResolver(UpdateVenueInput.omit({ id: true }).passthrough()) as unknown as Resolver<VenueFormValues>)

  const {
    control,
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
    reset,
  } = useForm<VenueFormValues>({
    resolver,
    defaultValues: {
      name: '',
      slug: '',
      description: '',
      guideNotes: '',
      category: '',
      defaultCenterLat: undefined,
      defaultCenterLng: undefined,
    },
  })

  useEffect(() => {
    let disposed = false

    async function loadVenue() {
      if (mode !== 'edit' || !venueId) return
      setIsLoadingVenue(true)
      setFormError(null)
      try {
        const venue = await client.venue.getById.query({ id: venueId })
        if (!disposed) {
          reset({
            name: venue.name,
            slug: venue.slug,
            description: venue.description ?? '',
            guideNotes: venue.guideNotes ?? '',
            category: venue.category ?? '',
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
    return () => { disposed = true }
  }, [client, mode, venueId, reset])

  async function onSubmit(values: VenueFormValues) {
    setFormError(null)
    try {
      if (mode === 'create') {
        const venue = await client.venue.create.mutate({
          name: values.name,
          slug: values.slug?.trim() || undefined,
          description: values.description?.trim() || undefined,
          guideNotes: values.guideNotes?.trim() || undefined,
          category: values.category?.trim() || undefined,
          defaultCenterLat: values.defaultCenterLat,
          defaultCenterLng: values.defaultCenterLng,
        })
        router.push(`/venues/${venue.id}`)
      } else {
        await client.venue.update.mutate({
          id: venueId!,
          name: values.name,
          description: values.description?.trim() || undefined,
          guideNotes: values.guideNotes?.trim() || undefined,
          category: values.category?.trim() || undefined,
          defaultCenterLat: values.defaultCenterLat,
          defaultCenterLng: values.defaultCenterLng,
        })
        router.push(`/venues/${venueId}`)
      }
      router.refresh()
    } catch (error) {
      setFormError(getErrorMessage(error))
    }
  }

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-6 space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
          {mode === 'create' ? 'Create venue' : 'Edit venue'}
        </h1>
        <p className="text-sm leading-6 text-slate-600">
          {mode === 'create'
            ? 'Set up a new venue for the Path Finder chat experience.'
            : 'Update venue details and guide context.'}
        </p>
      </div>

      {isLoadingVenue ? (
        <p className="text-sm text-slate-500">Loading venue...</p>
      ) : (
        <form
          className="space-y-5"
          onSubmit={handleSubmit(onSubmit, (fieldErrors) => {
            // Surface validation errors that have no dedicated field display
            const messages = Object.entries(fieldErrors)
              .map(([field, err]) => `${field}: ${err?.message ?? 'invalid'}`)
              .join(', ')
            setFormError(`Validation failed — ${messages}`)
          })}
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor="venue-name">
                Name
              </label>
              <input
                id="venue-name"
                className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                {...register('name')}
              />
              {errors.name ? <p className="mt-2 text-sm text-rose-600">{errors.name.message}</p> : null}
            </div>

            {mode === 'create' && (
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor="venue-slug">
                  Slug
                </label>
                <input
                  id="venue-slug"
                  className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                  {...register('slug')}
                />
                {errors.slug ? <p className="mt-2 text-sm text-rose-600">{errors.slug.message}</p> : null}
              </div>
            )}

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor="venue-category">
                Category
              </label>
              <input
                id="venue-category"
                className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                {...register('category')}
              />
            </div>

            <div className="sm:col-span-2">
              <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor="venue-description">
                Description
              </label>
              <textarea
                id="venue-description"
                className="min-h-28 w-full rounded-2xl border border-slate-300 px-4 py-3 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                {...register('description')}
              />
            </div>

            <div className="sm:col-span-2">
              <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor="venue-guide-notes">
                Guide notes
              </label>
              <p className="mb-2 text-xs text-slate-500">
                2–3 sentences describing how the venue is laid out and how zones relate to each other. Goes directly to the AI on every chat.
              </p>
              <textarea
                id="venue-guide-notes"
                className="min-h-28 w-full rounded-2xl border border-slate-300 px-4 py-3 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                {...register('guideNotes')}
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor="venue-lat">
                Default center latitude
              </label>
              <Controller
                control={control}
                name="defaultCenterLat"
                render={({ field }) => (
                  <input
                    id="venue-lat"
                    className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                    inputMode="decimal"
                    value={field.value ?? ''}
                    onChange={(event) => { field.onChange(parseOptionalNumber(event.target.value)) }}
                  />
                )}
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor="venue-lng">
                Default center longitude
              </label>
              <Controller
                control={control}
                name="defaultCenterLng"
                render={({ field }) => (
                  <input
                    id="venue-lng"
                    className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                    inputMode="decimal"
                    value={field.value ?? ''}
                    onChange={(event) => { field.onChange(parseOptionalNumber(event.target.value)) }}
                  />
                )}
              />
            </div>
          </div>

          {formError ? (
            <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {formError}
            </p>
          ) : null}

          <button
            className="inline-flex min-h-11 items-center rounded-full bg-slate-900 px-5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
            disabled={isSubmitting}
            type="submit"
          >
            {isSubmitting ? 'Saving...' : mode === 'create' ? 'Create venue' : 'Save changes'}
          </button>
        </form>
      )}
    </section>
  )
}
