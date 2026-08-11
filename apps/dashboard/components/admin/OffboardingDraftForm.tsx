'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { OffboardingRevocationTarget } from '@pathfinder/contracts/offboarding'

import { useTRPCClient } from '../../lib/trpc'

type VenueOption = { id: string; name: string }

type OffboardingDraftFormProps = {
  tenantId: string
  venues: VenueOption[]
}

const targetLabels: Record<(typeof OffboardingRevocationTarget.options)[number], string> = {
  GUEST_LINKS: 'Guest links',
  WIDGETS: 'Embedded widgets',
  PARTNER_API_KEYS: 'Partner API credentials',
  MCP_CREDENTIALS: 'MCP credentials',
  BACKGROUND_JOBS: 'Background jobs',
  AGENT_IDENTITIES: 'Agent identities',
  CLIENT_ACCESS: 'Client access',
  OPERATOR_IMPERSONATION: 'Operator impersonation',
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'The draft was not created. No offboarding action was taken.'
}

export function OffboardingDraftForm({ tenantId, venues }: OffboardingDraftFormProps) {
  const client = useTRPCClient()
  const router = useRouter()
  const [selectedVenueIds, setSelectedVenueIds] = useState<string[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [outcome, setOutcome] = useState<{ kind: 'success' | 'error'; message: string } | null>(
    null,
  )

  const canSubmit = selectedVenueIds.length > 0 && confirmed && !submitting

  async function createDraft() {
    if (!canSubmit) return
    setSubmitting(true)
    setOutcome(null)
    try {
      const result = await client.admin.createOffboardingDraft.mutate({
        tenantId,
        venueIds: selectedVenueIds,
        revocationTargets: [...OffboardingRevocationTarget.options],
        exportKinds: [],
      })
      setOutcome({
        kind: 'success',
        message: `Draft ${result.id} was created in requested status. No access was revoked and no data was deleted.`,
      })
      setSelectedVenueIds([])
      setConfirmed(false)
      router.refresh()
    } catch (error) {
      setOutcome({ kind: 'error', message: errorMessage(error) })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault()
        void createDraft()
      }}
    >
      <fieldset disabled={submitting}>
        <legend className="text-sm font-semibold text-pf-deep">Target venues</legend>
        <p className="mt-1 text-sm leading-6 text-pf-deep/75">
          Select every venue that should be recorded in this planning draft.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {venues.map((venue) => (
            <label
              key={venue.id}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-pf-light bg-white px-3 py-2 text-sm font-medium text-pf-deep focus-within:ring-2 focus-within:ring-pf-accent"
            >
              <input
                type="checkbox"
                checked={selectedVenueIds.includes(venue.id)}
                onChange={(event) => {
                  setSelectedVenueIds((current) =>
                    event.target.checked
                      ? [...current, venue.id]
                      : current.filter((id) => id !== venue.id),
                  )
                }}
                className="h-4 w-4 accent-pf-primary"
              />
              {venue.name}
            </label>
          ))}
        </div>
        {venues.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-pf-light p-4 text-sm text-pf-deep/75">
            This client has no venues available for a draft.
          </p>
        ) : null}
      </fieldset>

      <div>
        <p className="text-sm font-semibold text-pf-deep">Required revocation checklist</p>
        <ul className="mt-2 grid gap-1 text-sm text-pf-deep/75 sm:grid-cols-2">
          {OffboardingRevocationTarget.options.map((target) => (
            <li key={target}>• {targetLabels[target]}</li>
          ))}
        </ul>
        <p className="mt-2 text-xs leading-5 text-pf-deep/75">
          These are planning targets only. Creating the draft does not execute any revocation.
        </p>
      </div>

      <label className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={submitting}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-0.5 h-4 w-4 accent-pf-primary"
        />
        <span>
          I confirm this creates only a REQUESTED planning draft for the selected venues. It does
          not revoke access, complete offboarding, delete data, or enforce a retention policy.
        </span>
      </label>

      <button
        type="submit"
        disabled={!canSubmit}
        className="inline-flex min-h-11 items-center rounded-xl bg-pf-primary px-5 py-2 text-sm font-semibold text-white transition hover:bg-pf-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2 motion-reduce:transition-none disabled:cursor-not-allowed disabled:bg-pf-deep/35"
      >
        {submitting ? 'Creating requested draft…' : 'Create requested draft'}
      </button>

      <div aria-live="polite" aria-atomic="true">
        {outcome ? (
          <p
            className={`rounded-xl border px-4 py-3 text-sm ${
              outcome.kind === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                : 'border-rose-200 bg-rose-50 text-rose-900'
            }`}
          >
            {outcome.message}
          </p>
        ) : null}
      </div>
    </form>
  )
}
