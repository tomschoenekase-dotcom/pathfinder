'use client'

import React, { useRef, useState, type FormEvent } from 'react'
import Link from 'next/link'

import { useTRPCClient } from '../lib/trpc'

type FormState = 'idle' | 'submitting' | 'success' | 'error'

function newRequestId(): string {
  return crypto.randomUUID()
}

function optionalValue(form: FormData, name: string): string | undefined {
  const value = String(form.get(name) ?? '').trim()
  return value || undefined
}

function normalizedWebsite(value: string | undefined): string | undefined {
  if (!value) return undefined
  return /^https?:\/\//iu.test(value) ? value : `https://${value}`
}

const inputClass =
  'mt-2 min-h-12 min-w-0 w-full rounded-2xl border border-pf-light bg-white px-4 text-base text-pf-deep outline-none transition placeholder:text-pf-deep/35 focus:border-pf-accent focus:ring-4 focus:ring-pf-accent/10'

export function RequestDemoForm() {
  const client = useTRPCClient()
  const requestId = useRef(newRequestId())
  const [state, setState] = useState<FormState>('idle')
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (state === 'submitting') return
    setState('submitting')
    setError(null)
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    try {
      await client.publicInterest.submit.mutate({
        requestId: requestId.current,
        organizationName: String(form.get('organizationName') ?? ''),
        contactName: String(form.get('contactName') ?? ''),
        workEmail: String(form.get('workEmail') ?? ''),
        website: normalizedWebsite(optionalValue(form, 'website')),
        cityRegion: optionalValue(form, 'cityRegion'),
        venueType: optionalValue(form, 'venueType'),
        message: optionalValue(form, 'message'),
        companyFax: optionalValue(form, 'companyFax'),
      })
      setState('success')
      formElement.reset()
      requestId.current = newRequestId()
    } catch (cause) {
      setState('error')
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : 'We could not save your request. Please try again.',
      )
    }
  }

  if (state === 'success') {
    return (
      <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-7" role="status">
        <p className="text-lg font-semibold text-emerald-950">Your request is in.</p>
        <p className="mt-2 text-sm leading-6 text-emerald-900/75">
          Torchiko has saved your details for review. Submitting this form did not create a price,
          subscription, or customer account.
        </p>
        <button
          type="button"
          className="mt-5 text-sm font-semibold text-emerald-900 underline underline-offset-4"
          onClick={() => setState('idle')}
        >
          Send another request
        </button>
      </div>
    )
  }

  return (
    <form className="space-y-5" onSubmit={submit} noValidate>
      <div className="grid min-w-0 gap-5 sm:grid-cols-2">
        <label className="min-w-0 text-sm font-semibold text-pf-deep">
          Your name
          <input
            className={inputClass}
            name="contactName"
            autoComplete="name"
            required
            minLength={2}
            maxLength={120}
          />
        </label>
        <label className="min-w-0 text-sm font-semibold text-pf-deep">
          Work email
          <input
            className={inputClass}
            name="workEmail"
            type="email"
            autoComplete="email"
            required
            maxLength={320}
          />
        </label>
      </div>
      <label className="block text-sm font-semibold text-pf-deep">
        Organization or venue
        <input
          className={inputClass}
          name="organizationName"
          autoComplete="organization"
          required
          minLength={2}
          maxLength={160}
        />
      </label>
      <div className="grid min-w-0 gap-5 sm:grid-cols-2">
        <label className="min-w-0 text-sm font-semibold text-pf-deep">
          Website <span className="font-normal text-pf-deep/50">(optional)</span>
          <input
            className={inputClass}
            name="website"
            inputMode="url"
            autoComplete="url"
            maxLength={1000}
            placeholder="yourvenue.org"
          />
        </label>
        <label className="min-w-0 text-sm font-semibold text-pf-deep">
          City / region <span className="font-normal text-pf-deep/50">(optional)</span>
          <input
            className={inputClass}
            name="cityRegion"
            autoComplete="address-level2"
            maxLength={200}
          />
        </label>
      </div>
      <label className="block text-sm font-semibold text-pf-deep">
        Venue type <span className="font-normal text-pf-deep/50">(optional)</span>
        <select className={inputClass} name="venueType" defaultValue="">
          <option value="">Select a type</option>
          <option>Museum or gallery</option>
          <option>Zoo or aquarium</option>
          <option>Park or botanical garden</option>
          <option>Sports venue or stadium</option>
          <option>Retail or mixed-use destination</option>
          <option>Other visitor venue</option>
        </select>
      </label>
      <label className="block text-sm font-semibold text-pf-deep">
        What would you like guests to get help with?{' '}
        <span className="font-normal text-pf-deep/50">(optional)</span>
        <textarea className={`${inputClass} min-h-32 py-3`} name="message" maxLength={2000} />
      </label>
      <div className="hidden" aria-hidden="true">
        <label>
          Company fax
          <input name="companyFax" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      {state === 'error' ? (
        <div
          className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
          role="alert"
        >
          {error}
        </div>
      ) : null}
      <button
        type="submit"
        disabled={state === 'submitting'}
        className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-pf-accent px-7 text-sm font-semibold text-white transition hover:bg-[#4d8de0] disabled:cursor-wait disabled:opacity-60 sm:w-auto"
      >
        {state === 'submitting' ? 'Saving your request…' : 'Request a demo'}
      </button>
      <p className="text-xs leading-5 text-pf-deep/55">
        Torchiko stores the details you provide so the team can review and respond. This form does
        not start billing or create a customer account. See the current{' '}
        <Link
          href="/privacy"
          className="font-semibold text-pf-primary underline underline-offset-2"
        >
          privacy status notice
        </Link>
        .
      </p>
    </form>
  )
}
