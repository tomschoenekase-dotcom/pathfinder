'use client'

import React, { useRef, useState, type FormEvent } from 'react'

import type { SupportPortableExportSection } from '@pathfinder/contracts'

export type SupportPortableExportVenue = {
  id: string
  name: string
  isActive: boolean
}

export type SupportPortableExportRecipient = {
  userId: string
  fullName: string | null
  email: string
  role: 'STAFF' | 'MANAGER' | 'OWNER'
}

type SupportPortableExportFormProps = {
  tenantId: string
  venues: SupportPortableExportVenue[]
  recipients: SupportPortableExportRecipient[]
  sections: readonly SupportPortableExportSection[]
  maxExportBytes: number
}

const SECTION_COPY: Record<SupportPortableExportSection, { label: string; description: string }> = {
  'current-venue': {
    label: 'Current venue',
    description: 'Venue settings and the currently available guide content.',
  },
  'content-history': {
    label: 'Content history',
    description: 'Recorded venue-content changes within this venue. Manager or owner recipients only.',
  },
  'venue-packages': {
    label: 'Venue packages',
    description: 'Bounded package records for this venue. Manager or owner recipients only.',
  },
  'published-reports': {
    label: 'Published reports',
    description: 'Published reporting content for this venue.',
  },
  'recipient-support': {
    label: 'Recipient support',
    description: 'Support requests involving the selected existing account recipient.',
  },
}

function recipientLabel(recipient: SupportPortableExportRecipient) {
  const name = recipient.fullName?.trim()
  return `${name ? `${name} · ` : ''}${recipient.email} · ${recipient.role.toLowerCase()}`
}

function requiresManagerRole(section: SupportPortableExportSection) {
  return section === 'content-history' || section === 'venue-packages'
}

function canReceiveRestrictedSections(recipient: SupportPortableExportRecipient | undefined) {
  return recipient?.role === 'MANAGER' || recipient?.role === 'OWNER'
}

function responseMessage(response: Response): string {
  if (response.status === 401 || response.status === 403) {
    return 'Your current admin session cannot prepare this export.'
  }
  if (response.status === 404) {
    return 'The selected recipient or venue is no longer available. Refresh the client record and choose again.'
  }
  if (response.status === 409) {
    return 'The requested records are not available for this scope. Review the recipient, venue, and sections.'
  }
  if (response.status === 413) {
    return 'The requested export is larger than the safe download limit. Narrow the requested sections.'
  }
  return 'The export could not be prepared. Refresh the client record and try again.'
}

async function readBoundedResponseBytes(
  response: Response,
  maxExportBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maxExportBytes)) {
    return null
  }
  if (!response.body) return null

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    let result = await reader.read()
    while (!result.done) {
      const value = result.value
      total += value.byteLength
      if (total > maxExportBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
      result = await reader.read()
    }
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
  if (total === 0) return null
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export function SupportPortableExportForm({
  tenantId,
  venues,
  recipients,
  sections: availableSections,
  maxExportBytes,
}: SupportPortableExportFormProps) {
  const [venueId, setVenueId] = useState('')
  const [recipientUserId, setRecipientUserId] = useState('')
  const [sections, setSections] = useState<SupportPortableExportSection[]>([])
  const [isPreparing, setIsPreparing] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const requestInFlightRef = useRef(false)

  const selectedRecipient = recipients.find((recipient) => recipient.userId === recipientUserId)
  const selectedVenue = venues.find((venue) => venue.id === venueId)
  const noChoices = venues.length === 0 || recipients.length === 0
  const canPrepare = !noChoices && venueId && recipientUserId && sections.length > 0 && !isPreparing

  function toggleSection(section: SupportPortableExportSection) {
    if (requiresManagerRole(section) && !canReceiveRestrictedSections(selectedRecipient)) return
    setMessage(null)
    setErrorMessage(null)
    setSections((selected) =>
      selected.includes(section) ? selected.filter((value) => value !== section) : [...selected, section],
    )
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canPrepare || requestInFlightRef.current) return

    requestInFlightRef.current = true
    setIsPreparing(true)
    setMessage(null)
    setErrorMessage(null)

    try {
      const response = await fetch(`/admin/clients/${encodeURIComponent(tenantId)}/support-export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ tenantId, venueId, recipientUserId, sections }),
      })
      if (!response.ok) {
        setErrorMessage(responseMessage(response))
        return
      }
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
        setErrorMessage('The export response was not a portable JSON file. Refresh and try again.')
        return
      }

      const bytes = await readBoundedResponseBytes(response, maxExportBytes)
      if (!bytes) {
        setErrorMessage('The export response was empty or exceeded the safe download limit. Try narrower sections.')
        return
      }
      const blob = new Blob([bytes], { type: 'application/json' })
      const objectUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = 'support-portable-export.json'
      anchor.style.display = 'none'
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
      setMessage('Prepared a scoped JSON download. It was not sent or attached to a support ticket.')
    } catch {
      setErrorMessage('The export could not be prepared. Check your connection and try again.')
    } finally {
      requestInFlightRef.current = false
      setIsPreparing(false)
    }
  }

  return (
    <section
      className="min-w-0 overflow-hidden rounded-2xl border border-pf-light bg-pf-white p-5 sm:p-6"
      aria-labelledby="support-portable-export-heading"
    >
      <div className="max-w-3xl">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">Support tool</p>
        <h2 id="support-portable-export-heading" className="mt-1 text-xl font-semibold tracking-tight text-pf-deep">
          Portable client export
        </h2>
        <p className="mt-2 text-sm leading-6 text-pf-deep/80">
          Prepare a limited JSON download for one existing active account recipient and one venue. This
          does not send a file, complete a support request, or include account-wide material.
        </p>
      </div>

      {noChoices ? (
        <p className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950" role="status">
          {venues.length === 0
            ? 'A venue is required before a scoped export can be prepared.'
            : 'An existing active account recipient is required before a scoped export can be prepared.'}
        </p>
      ) : (
        <form className="mt-6 space-y-6" onSubmit={(event) => void handleSubmit(event)}>
          <div className="grid min-w-0 gap-5 md:grid-cols-2">
            <label className="block min-w-0 text-sm font-semibold text-pf-deep">
              Existing account recipient
              <select
                aria-label="Existing account recipient"
                className="mt-2 block min-h-11 w-full min-w-0 rounded-xl border border-pf-light bg-pf-white px-3 text-sm font-normal text-pf-deep shadow-sm focus:border-pf-accent focus:outline-none focus:ring-2 focus:ring-pf-accent/20"
                value={recipientUserId}
                onChange={(event) => {
                  const nextRecipient = recipients.find((recipient) => recipient.userId === event.target.value)
                  setRecipientUserId(event.target.value)
                  if (!canReceiveRestrictedSections(nextRecipient)) {
                    setSections((selected) => selected.filter((section) => !requiresManagerRole(section)))
                  }
                  setMessage(null)
                  setErrorMessage(null)
                }}
                disabled={isPreparing}
              >
                <option value="">Choose a recipient</option>
                {recipients.map((recipient) => (
                  <option key={recipient.userId} value={recipient.userId}>
                    {recipientLabel(recipient)}
                  </option>
                ))}
              </select>
              <span className="mt-1 block break-words text-xs font-normal leading-5 text-pf-deep/80">
                {selectedRecipient
                  ? `${selectedRecipient.email} · ${selectedRecipient.role.toLowerCase()} access`
                  : 'Recipient access determines which requested sections can be included.'}
              </span>
            </label>

            <label className="block min-w-0 text-sm font-semibold text-pf-deep">
              Venue
              <select
                aria-label="Venue"
                className="mt-2 block min-h-11 w-full min-w-0 rounded-xl border border-pf-light bg-pf-white px-3 text-sm font-normal text-pf-deep shadow-sm focus:border-pf-accent focus:outline-none focus:ring-2 focus:ring-pf-accent/20"
                value={venueId}
                onChange={(event) => {
                  setVenueId(event.target.value)
                  setMessage(null)
                  setErrorMessage(null)
                }}
                disabled={isPreparing}
              >
                <option value="">Choose one venue</option>
                {venues.map((venue) => (
                  <option key={venue.id} value={venue.id}>
                    {venue.name} {venue.isActive ? '' : '(guest access paused)'}
                  </option>
                ))}
              </select>
              <span className="mt-1 block break-words text-xs font-normal leading-5 text-pf-deep/80">
                {selectedVenue
                  ? selectedVenue.name
                  : 'Choose only the venue relevant to the support request.'}
              </span>
            </label>
          </div>

          <fieldset className="min-w-0">
            <legend className="text-sm font-semibold text-pf-deep">Requested sections</legend>
            <p className="mt-1 text-sm leading-6 text-pf-deep/80">
              Select each section deliberately. Guest conversations, provider sessions, credentials,
              raw analytics, asset links and bytes, and account-wide material are excluded.
            </p>
            <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
              {availableSections.map((section) => {
                const selected = sections.includes(section)
                const restricted = requiresManagerRole(section)
                const unavailable = restricted && !canReceiveRestrictedSections(selectedRecipient)
                return (
                  <label
                    key={section}
                    className={`flex min-w-0 items-start gap-3 rounded-xl border p-3 transition ${
                      unavailable ? 'cursor-not-allowed border-pf-light bg-pf-surface/20 opacity-60' : 'cursor-pointer'
                    } ${
                      selected
                        ? 'border-pf-accent bg-pf-accent/5'
                        : 'border-pf-light bg-pf-surface/30 hover:border-pf-accent/60'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 shrink-0 accent-pf-primary"
                      checked={selected}
                      disabled={isPreparing || unavailable}
                      onChange={() => toggleSection(section)}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-pf-deep">{SECTION_COPY[section].label}</span>
                      <span className="mt-0.5 block text-xs leading-5 text-pf-deep/80">
                        {SECTION_COPY[section].description}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          </fieldset>

          <div className="flex flex-col gap-3 border-t border-pf-light pt-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-xl text-xs leading-5 text-pf-deep/80">
              The downloaded file is scoped to this recipient and venue. Review the request before
              sharing it through an approved support channel.
            </p>
            <button
              type="submit"
              disabled={!canPrepare}
              className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white transition hover:bg-pf-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-pf-deep/30"
            >
              {isPreparing ? 'Preparing export…' : 'Prepare JSON download'}
            </button>
          </div>
        </form>
      )}

      {message ? (
        <p className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
      {errorMessage ? (
        <p className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </section>
  )
}
