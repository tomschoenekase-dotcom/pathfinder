'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type Resolver, useForm } from 'react-hook-form'

import { CreateOperationalUpdateInput, CreateOperationalUpdateInputBase } from '@pathfinder/api/schemas'

import { createTRPCClient } from '../lib/trpc'

type VenueOption = {
  id: string
  name: string
}

type OperationalUpdateFormProps = {
  venues: VenueOption[]
}

type FormValues = {
  venueId: string
  severity: 'INFO' | 'WARNING' | 'CLOSURE' | 'REDIRECT'
  title: string
  body: string | undefined
}

type ExpiryPreset = '1h' | '4h' | 'end-of-day' | 'custom'

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return 'Something went wrong. Please try again.'
}

function computeExpiryFromPreset(preset: ExpiryPreset, customValue: string) {
  const now = new Date()

  if (preset === 'custom') {
    return customValue ? new Date(customValue) : null
  }

  if (preset === '1h') {
    return new Date(now.getTime() + 60 * 60 * 1000)
  }

  if (preset === '4h') {
    return new Date(now.getTime() + 4 * 60 * 60 * 1000)
  }

  const endOfDay = new Date(now)
  endOfDay.setHours(23, 59, 0, 0)
  return endOfDay
}

function formatDateTimeLocal(value: Date) {
  const year = value.getFullYear()
  const month = `${value.getMonth() + 1}`.padStart(2, '0')
  const day = `${value.getDate()}`.padStart(2, '0')
  const hours = `${value.getHours()}`.padStart(2, '0')
  const minutes = `${value.getMinutes()}`.padStart(2, '0')

  return `${year}-${month}-${day}T${hours}:${minutes}`
}

export function OperationalUpdateForm({ venues }: OperationalUpdateFormProps) {
  const router = useRouter()
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) {
    clientRef.current = createTRPCClient()
  }
  const client = clientRef.current

  const [preset, setPreset] = useState<ExpiryPreset>('1h')
  const [customExpiry, setCustomExpiry] = useState(
    formatDateTimeLocal(new Date(Date.now() + 60 * 60 * 1000)),
  )
  const [formError, setFormError] = useState<string | null>(null)

  const resolver = zodResolver(
    CreateOperationalUpdateInputBase.omit({
      expiresAt: true,
      placeId: true,
      redirectTo: true,
    }).passthrough(),
  ) as unknown as Resolver<FormValues>

  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
    watch,
  } = useForm<FormValues>({
    resolver,
    defaultValues: {
      venueId: venues[0]?.id ?? '',
      severity: 'INFO',
      title: '',
      body: '',
    },
  })

  const title = watch('title')
  const body = watch('body')
  const resolvedExpiry = useMemo(() => computeExpiryFromPreset(preset, customExpiry), [customExpiry, preset])

  async function onSubmit(values: FormValues) {
    setFormError(null)

    if (!resolvedExpiry || Number.isNaN(resolvedExpiry.getTime())) {
      setFormError('Choose a valid expiry time.')
      return
    }

    try {
      await client.operationalUpdate.create.mutate(
        CreateOperationalUpdateInput.parse({
          venueId: values.venueId,
          severity: values.severity,
          title: values.title,
          body: values.body?.trim() || undefined,
          expiresAt: resolvedExpiry,
        }),
      )

      router.push('/operational-updates')
      router.refresh()
    } catch (error) {
      setFormError(getErrorMessage(error))
    }
  }

  return (
    <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-6 space-y-2">
        <Link href="/operational-updates" className="text-sm font-medium text-cyan-700 hover:text-cyan-800">
          Back to active alerts
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950">Create Alert</h1>
        <p className="text-sm leading-6 text-slate-600">
          Publish a short-lived notice for guests and staff. Alerts automatically expire.
        </p>
      </div>

      <form className="space-y-6" onSubmit={handleSubmit(onSubmit)}>
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor="update-venue">
              Venue
            </label>
            <select
              id="update-venue"
              className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              {...register('venueId')}
            >
              {venues.map((venue) => (
                <option key={venue.id} value={venue.id}>
                  {venue.name}
                </option>
              ))}
            </select>
            {errors.venueId ? <p className="mt-2 text-sm text-rose-600">{errors.venueId.message}</p> : null}
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor="update-severity">
              Severity
            </label>
            <select
              id="update-severity"
              className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              {...register('severity')}
            >
              <option value="INFO">INFO</option>
              <option value="WARNING">WARNING</option>
              <option value="CLOSURE">CLOSURE</option>
              <option value="REDIRECT">REDIRECT</option>
            </select>
            {errors.severity ? <p className="mt-2 text-sm text-rose-600">{errors.severity.message}</p> : null}
          </div>

          <div className="sm:col-span-2">
            <div className="mb-2 flex items-center justify-between gap-4">
              <label className="block text-sm font-medium text-slate-700" htmlFor="update-title">
                Title
              </label>
              <span className="text-xs text-slate-500">{title.length}/60</span>
            </div>
            <input
              id="update-title"
              maxLength={60}
              className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              {...register('title')}
            />
            {errors.title ? <p className="mt-2 text-sm text-rose-600">{errors.title.message}</p> : null}
          </div>

          <div className="sm:col-span-2">
            <div className="mb-2 flex items-center justify-between gap-4">
              <label className="block text-sm font-medium text-slate-700" htmlFor="update-body">
                Body
              </label>
              <span className="text-xs text-slate-500">{body?.length ?? 0}/300</span>
            </div>
            <textarea
              id="update-body"
              maxLength={300}
              className="min-h-32 w-full rounded-2xl border border-slate-300 px-4 py-3 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              {...register('body')}
            />
            {errors.body ? <p className="mt-2 text-sm text-rose-600">{errors.body.message}</p> : null}
          </div>

          <div className="sm:col-span-2">
            <label className="mb-3 block text-sm font-medium text-slate-700">Expiry</label>
            <div className="flex flex-wrap gap-3">
              {[
                ['1h', '1 hour'],
                ['4h', '4 hours'],
                ['end-of-day', 'End of day'],
                ['custom', 'Custom'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setPreset(value as ExpiryPreset)
                  }}
                  className={[
                    'rounded-full border px-4 py-2 text-sm font-medium transition',
                    preset === value
                      ? 'border-cyan-500 bg-cyan-50 text-cyan-700'
                      : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400',
                  ].join(' ')}
                >
                  {label}
                </button>
              ))}
            </div>

            {preset === 'custom' ? (
              <div className="mt-4">
                <input
                  type="datetime-local"
                  value={customExpiry}
                  onChange={(event) => {
                    setCustomExpiry(event.target.value)
                  }}
                  className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                />
              </div>
            ) : (
              <p className="mt-4 text-sm text-slate-600">
                Expires {resolvedExpiry ? resolvedExpiry.toLocaleString() : '—'}
              </p>
            )}
          </div>
        </div>

        {formError ? (
          <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {formError}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={isSubmitting || venues.length === 0}
          className="inline-flex min-h-11 items-center rounded-full bg-slate-950 px-5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
        >
          {isSubmitting ? 'Creating...' : 'Create Alert'}
        </button>
      </form>
    </section>
  )
}
