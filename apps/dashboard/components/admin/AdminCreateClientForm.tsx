'use client'

import { type FormEvent, useRef, useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return 'Something went wrong. Please try again.'
}

export function AdminCreateClientForm() {
  const client = useTRPCClient()

  const [clientName, setClientName] = useState('')
  const [venueName, setVenueName] = useState('')
  const [venueCategory, setVenueCategory] = useState('')
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const submitInFlightRef = useRef(false)
  const requestIdRef = useRef(crypto.randomUUID())

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!clientName.trim() || !venueName.trim() || saving || submitInFlightRef.current) return

    submitInFlightRef.current = true
    setSaving(true)
    setErrorMessage(null)

    try {
      const { tenant } = await client.admin.createClientAndVenue.mutate({
        requestId: requestIdRef.current,
        clientName: clientName.trim(),
        venue: {
          name: venueName.trim(),
          ...(venueCategory.trim() ? { category: venueCategory.trim() } : {}),
        },
      })

      // Drop the admin straight into the new client's dashboard (impersonated)
      // so they can keep configuring it right away.
      await fetch('/api/admin/impersonate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: tenant.id }),
      })
      window.location.href = '/'
    } catch (error) {
      submitInFlightRef.current = false
      setErrorMessage(getErrorMessage(error))
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-6 rounded-3xl border border-pf-light bg-pf-white p-8 shadow-sm"
    >
      <div className="space-y-2">
        <label htmlFor="client-name" className="text-sm font-medium text-pf-deep">
          Client name
        </label>
        <input
          id="client-name"
          type="text"
          required
          value={clientName}
          onChange={(event) => setClientName(event.target.value)}
          placeholder="The Grand Hotel"
          className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
        />
        <p className="text-xs text-pf-deep/50">
          Creates a new organization and tenant. No account or sign-up is required from the client.
        </p>
      </div>

      <div className="space-y-2">
        <label htmlFor="venue-name" className="text-sm font-medium text-pf-deep">
          Venue name
        </label>
        <input
          id="venue-name"
          type="text"
          required
          value={venueName}
          onChange={(event) => setVenueName(event.target.value)}
          placeholder="Main Lobby"
          className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="venue-category" className="text-sm font-medium text-pf-deep">
          Venue category <span className="text-pf-deep/40">(optional)</span>
        </label>
        <input
          id="venue-category"
          type="text"
          value={venueCategory}
          onChange={(event) => setVenueCategory(event.target.value)}
          placeholder="Hotel, museum, mall..."
          className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
        />
      </div>

      {errorMessage ? (
        <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {errorMessage}
        </p>
      ) : null}

      <div className="space-y-3">
        <button
          type="submit"
          disabled={saving || !clientName.trim() || !venueName.trim()}
          className="inline-flex min-h-11 w-full items-center justify-center rounded-full bg-pf-primary px-5 text-sm font-medium text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Creating…' : 'Create client & venue →'}
        </button>
        <p className="text-xs text-pf-deep/50">
          You&apos;ll land in the new client&apos;s dashboard to finish setup. Whenever you&apos;re
          ready, use Settings → Invite a team member to bring the real client in by email.
        </p>
      </div>
    </form>
  )
}
