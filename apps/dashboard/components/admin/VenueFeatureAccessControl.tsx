'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

import { useTRPCClient } from '../../lib/trpc'

type Entitlement = inferRouterOutputs<AppRouter>['admin']['listProductEntitlements'][number]

function localExpiry(minutes: number): string {
  const date = new Date(Date.now() + minutes * 60_000)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function sourceLabel(source: Entitlement['source']): string {
  return source.toLowerCase().replaceAll('_', ' ')
}

export function VenueFeatureAccessControl({
  tenantId,
  venueId,
  venueName,
  entitlements,
}: {
  tenantId: string
  venueId: string
  venueName: string
  entitlements: Entitlement[]
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const voice = useMemo(
    () => entitlements.find((entitlement) => entitlement.capability === 'voice'),
    [entitlements],
  )
  const [effect, setEffect] = useState<'GRANT' | 'DENY'>('GRANT')
  const [endsAt, setEndsAt] = useState(() => localExpiry(60))
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function save() {
    if (!confirmed || reason.trim().length < 3 || !endsAt) return
    setBusy(true)
    setMessage(null)
    try {
      const expiry = new Date(endsAt)
      if (!Number.isFinite(expiry.getTime()) || expiry <= new Date()) {
        setMessage('Choose an expiry in the future. No entitlement was written.')
        return
      }
      await client.admin.setProductEntitlementOverride.mutate({
        tenantId,
        venueId,
        capability: 'voice',
        effect,
        kind: 'ADMIN',
        endsAt: expiry.toISOString(),
        settings:
          effect === 'GRANT'
            ? {
                maxSessionSeconds: 120,
                dailySeconds: 300,
                monthlySeconds: 900,
                maxConcurrentSessions: 1,
                voice: 'marin',
              }
            : {},
        reason: reason.trim(),
      })
      setMessage(
        effect === 'GRANT'
          ? 'Bounded Voice access appended. The separate runtime gate remains unchanged.'
          : 'Voice denial appended. Existing session history was retained.',
      )
      setConfirmed(false)
      setReason('')
      router.refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Feature access could not be changed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-6" aria-labelledby="feature-access-heading">
      <header className="max-w-3xl">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Venue authorization
        </p>
        <h2 id="feature-access-heading" className="mt-2 text-2xl font-semibold text-pf-deep">
          Feature access
        </h2>
        <p className="mt-2 text-sm leading-6 text-pf-deep/75">
          Append a short-lived, audited venue decision without changing a plan or billing record.
          Feature access alone never starts a provider session; the platform runtime gate remains a
          separate control.
        </p>
      </header>

      <article className="overflow-hidden rounded-2xl border border-pf-light bg-white">
        <div className="grid gap-5 border-b border-pf-light p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold text-pf-deep">Voice Mode</h3>
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                  voice?.enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'
                }`}
              >
                {voice?.enabled ? 'Entitled' : 'Not entitled'}
              </span>
            </div>
            <p className="mt-2 text-sm leading-6 text-pf-deep/70">
              Effective source: {voice ? sourceLabel(voice.source) : 'unavailable'}
              {voice?.validUntil
                ? ` · expires ${new Date(voice.validUntil).toLocaleString()}`
                : ' · no effective expiry'}
            </p>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-950 sm:max-w-64">
            <strong className="block">Two-key activation</strong>
            This decision controls venue eligibility. The runtime Voice switch must also be on.
          </div>
        </div>

        <form
          className="p-5"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
            <legend className="text-sm font-semibold text-pf-deep">
              Append a bounded decision for {venueName}
            </legend>
            <label className="text-sm font-medium text-pf-deep">
              Decision
              <select
                value={effect}
                onChange={(event) => setEffect(event.target.value as 'GRANT' | 'DENY')}
                className="mt-1 min-h-11 w-full rounded-xl border border-pf-light bg-white px-3 text-sm"
              >
                <option value="GRANT">Grant bounded Voice access</option>
                <option value="DENY">Deny Voice access</option>
              </select>
            </label>
            <label className="text-sm font-medium text-pf-deep">
              Expires
              <input
                type="datetime-local"
                required
                value={endsAt}
                onChange={(event) => setEndsAt(event.target.value)}
                className="mt-1 min-h-11 w-full rounded-xl border border-pf-light bg-white px-3 text-sm"
              />
            </label>
            <label className="text-sm font-medium text-pf-deep sm:col-span-2">
              Audit reason
              <textarea
                required
                minLength={3}
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why this venue needs temporary Voice access"
                className="mt-1 min-h-24 w-full rounded-xl border border-pf-light bg-white px-3 py-2 text-sm"
              />
            </label>
            <label className="flex items-start gap-3 rounded-xl border border-pf-light bg-pf-surface/60 p-4 text-sm leading-5 text-pf-deep sm:col-span-2">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                className="mt-1 h-4 w-4 shrink-0"
              />
              <span>
                I confirm this is the exact venue scope and understand this appends durable audit
                evidence. A grant uses canary limits: one concurrent session, two minutes per
                session, five minutes per day.
              </span>
            </label>
          </fieldset>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={busy || !confirmed || reason.trim().length < 3 || !endsAt}
              className={`min-h-11 rounded-xl px-4 text-sm font-semibold text-white transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent disabled:cursor-not-allowed disabled:opacity-50 ${
                effect === 'GRANT' ? 'bg-pf-primary' : 'bg-rose-700'
              }`}
            >
              {busy
                ? 'Appending…'
                : effect === 'GRANT'
                  ? 'Append Voice grant'
                  : 'Append Voice denial'}
            </button>
            <p className="text-xs text-pf-deep/65">
              No plan, invoice, or provider gate is changed.
            </p>
          </div>
          {message ? (
            <p role="status" className="mt-4 text-sm font-medium text-pf-deep">
              {message}
            </p>
          ) : null}
        </form>
      </article>
    </section>
  )
}
