'use client'

import { useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'

export function ProspectContactRoutePanel({
  memberId,
  venueName,
  currentEmail,
  onSelected,
  onClose,
}: {
  memberId: string
  venueName: string
  currentEmail: string | null
  onSelected: (email: string) => Promise<void>
  onClose: () => void
}) {
  const client = useTRPCClient()
  const [email, setEmail] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [sourceLabel, setSourceLabel] = useState('')
  const [evidenceId, setEvidenceId] = useState<string | null>(null)
  const [contactId, setContactId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function recordSource() {
    setBusy(true)
    setError('')
    try {
      const result = await client.admin.appendProspectCampaignEmailSourceEvidence.mutate({
        memberId,
        email: email.trim(),
        sourceUrl: sourceUrl.trim(),
        ...(sourceLabel.trim() ? { sourceLabel: sourceLabel.trim() } : {}),
      })
      setEvidenceId(result.id)
      setNotice(
        result.idempotent
          ? 'The exact source was already retained. Review it before adding the contact.'
          : 'Public email source recorded for review. This does not approve outreach.',
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The source could not be recorded.')
    } finally {
      setBusy(false)
    }
  }

  async function addContact() {
    if (!evidenceId) return
    setBusy(true)
    setError('')
    try {
      const contact = await client.admin.addSourcedProspectCampaignContact.mutate({
        memberId,
        email: email.trim(),
        sourceEvidenceId: evidenceId,
      })
      setContactId(contact.id)
      setNotice('Contact added in review-required state. It has no sending approval.')
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The contact could not be added. Inspect the existing CRM route before retrying.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function selectRoute() {
    if (!contactId) return
    setBusy(true)
    setError('')
    try {
      await client.admin.selectProspectCampaignContactRoute.mutate({ memberId, contactId })
      await onSelected(email.trim())
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The selected route could not be read back. Inspect this CRM member before retrying.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-label={`Review contact route for ${venueName}`}
      className="mt-4 max-w-2xl border-l-2 border-sky-700 bg-slate-50 px-4 py-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h4 className="text-sm font-semibold text-slate-950">
            Review another public email route
          </h4>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            Check the venue’s public page, record the exact address it shows, then select the
            contact for this undrafted campaign member. This keeps the Gmail draft untouched and
            does not grant permission to send.
          </p>
          {currentEmail ? (
            <p className="mt-2 text-xs text-slate-600">
              Current route: <span className="font-medium">{currentEmail}</span>
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="text-xs font-semibold text-slate-600 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-40"
        >
          Close
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-semibold text-slate-700">
          Exact public email
          <input
            type="email"
            autoComplete="off"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            readOnly={Boolean(evidenceId)}
            placeholder="hello@venue.example"
            className="mt-1 min-h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm font-normal text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700 read-only:bg-slate-100"
          />
        </label>
        <label className="block text-xs font-semibold text-slate-700">
          Public source URL
          <input
            type="url"
            autoComplete="off"
            required
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
            readOnly={Boolean(evidenceId)}
            placeholder="https://venue.example/contact"
            className="mt-1 min-h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm font-normal text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700 read-only:bg-slate-100"
          />
        </label>
      </div>
      <label className="mt-3 block text-xs font-semibold text-slate-700">
        Source label (optional)
        <input
          type="text"
          autoComplete="off"
          value={sourceLabel}
          onChange={(event) => setSourceLabel(event.target.value)}
          readOnly={Boolean(evidenceId)}
          placeholder="Contact page"
          className="mt-1 min-h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm font-normal text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700 read-only:bg-slate-100"
        />
      </label>

      {error ? (
        <p role="alert" className="mt-3 text-xs font-semibold text-rose-700">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-3 text-xs text-slate-700">
          {notice}
        </p>
      ) : null}
      {evidenceId ? (
        <p className="mt-2 break-all text-[11px] text-slate-500">
          Source evidence ID: {evidenceId}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {!evidenceId ? (
          <button
            type="button"
            onClick={() => void recordSource()}
            disabled={busy || !email.trim() || !sourceUrl.trim()}
            className="min-h-10 rounded-md bg-slate-900 px-3 text-xs font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-40"
          >
            Record public source
          </button>
        ) : null}
        {evidenceId && !contactId ? (
          <button
            type="button"
            onClick={() => void addContact()}
            disabled={busy}
            className="min-h-10 rounded-md bg-slate-900 px-3 text-xs font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-40"
          >
            Add review-required contact
          </button>
        ) : null}
        {contactId ? (
          <button
            type="button"
            onClick={() => void selectRoute()}
            disabled={busy}
            className="min-h-10 rounded-md bg-sky-700 px-3 text-xs font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700 disabled:opacity-40"
          >
            Select this contact route
          </button>
        ) : null}
      </div>
    </section>
  )
}
