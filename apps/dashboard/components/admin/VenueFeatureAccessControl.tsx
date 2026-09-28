'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

import { useTRPCClient } from '../../lib/trpc'
import { runBoundedClientRequest } from '../../lib/bounded-client-request'

type Entitlement = inferRouterOutputs<AppRouter>['admin']['listProductEntitlements'][number]
type VoiceUsage = inferRouterOutputs<AppRouter>['admin']['getVenueVoiceUsageSummary']

function localExpiry(minutes: number): string {
  const date = new Date(Date.now() + minutes * 60_000)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function sourceLabel(source: Entitlement['source']): string {
  return source.toLowerCase().replaceAll('_', ' ')
}

function formatEstimatedUsd(amount: string): string {
  const [whole, fraction = ''] = amount.split('.')
  const meaningfulFraction = fraction.replace(/0+$/u, '')
  const displayedFraction =
    meaningfulFraction.length < 4 ? fraction.slice(0, 4) : meaningfulFraction
  return `$${whole}.${displayedFraction}`
}

export function VenueFeatureAccessControl({
  tenantId,
  venueId,
  venueName,
  entitlements,
  initialVoiceUsage,
}: {
  tenantId: string
  venueId: string
  venueName: string
  entitlements: Entitlement[]
  initialVoiceUsage?: VoiceUsage | null
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const premiumVoice = useMemo(
    () => entitlements.find((entitlement) => entitlement.capability === 'premium-voice'),
    [entitlements],
  )
  const hasActiveVoiceCap = premiumVoice?.enabled === true
  const monthlyCapMinutes = hasActiveVoiceCap
    ? typeof premiumVoice.settings.monthlySeconds === 'number' &&
      Number.isFinite(premiumVoice.settings.monthlySeconds)
      ? Math.floor(premiumVoice.settings.monthlySeconds / 60)
      : 300
    : null
  const [voiceUsage, setVoiceUsage] = useState<VoiceUsage | null>(initialVoiceUsage ?? null)
  const [usageMonth, setUsageMonth] = useState(
    initialVoiceUsage?.month ?? new Date().toISOString().slice(0, 7),
  )
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageUnavailable, setUsageUnavailable] = useState(!initialVoiceUsage)
  const [effect, setEffect] = useState<'GRANT' | 'DENY'>('GRANT')
  const [endsAt, setEndsAt] = useState(() => localExpiry(60))
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const activeUsageRead = useRef<AbortController | null>(null)

  useEffect(() => () => activeUsageRead.current?.abort(), [])

  async function loadUsage(month: string) {
    activeUsageRead.current?.abort()
    const controller = new AbortController()
    activeUsageRead.current = controller
    setUsageMonth(month)
    setUsageLoading(true)
    setUsageUnavailable(false)
    try {
      const next = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: 10_000,
        request: (signal) =>
          client.admin.getVenueVoiceUsageSummary.query({ tenantId, venueId, month }, { signal }),
      })
      if (activeUsageRead.current !== controller) return
      setVoiceUsage(next)
    } catch {
      if (activeUsageRead.current !== controller) return
      setVoiceUsage(null)
      setUsageUnavailable(true)
    } finally {
      if (activeUsageRead.current === controller) {
        activeUsageRead.current = null
        setUsageLoading(false)
      }
    }
  }

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
        capability: 'premium-voice',
        effect,
        kind: 'ADMIN',
        endsAt: expiry.toISOString(),
        settings:
          effect === 'GRANT'
            ? {
                maxSessionSeconds: 600,
                dailySeconds: 3600,
                monthlySeconds: 18000,
                maxConcurrentSessions: 2,
                voice: 'marin',
              }
            : {},
        reason: reason.trim(),
      })
      setMessage(
        effect === 'GRANT'
          ? 'Bounded Premium voice venue entitlement appended. The runtime gate remains separate.'
          : 'Premium voice denial appended. Existing session history was retained.',
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
              <h3 className="text-lg font-semibold text-pf-deep">Premium voice</h3>
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                  premiumVoice?.enabled
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-slate-100 text-slate-700'
                }`}
              >
                {premiumVoice?.enabled ? 'Entitled' : 'Not entitled'}
              </span>
            </div>
            <p className="mt-2 text-sm leading-6 text-pf-deep/70">
              Effective source: {premiumVoice ? sourceLabel(premiumVoice.source) : 'unavailable'}
              {premiumVoice?.validUntil
                ? ` · expires ${new Date(premiumVoice.validUntil).toLocaleString()}`
                : ' · no effective expiry'}
            </p>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-950 sm:max-w-64">
            <strong className="block">Two-key activation</strong>
            This decision controls this venue’s Premium voice eligibility. Platform Voice must also
            be enabled.
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
              Append a bounded Premium voice decision for {venueName}
            </legend>
            <label className="text-sm font-medium text-pf-deep">
              Decision
              <select
                value={effect}
                onChange={(event) => setEffect(event.target.value as 'GRANT' | 'DENY')}
                className="mt-1 min-h-11 w-full rounded-xl border border-pf-light bg-white px-3 text-sm"
              >
                <option value="GRANT">Grant bounded Premium voice</option>
                <option value="DENY">Deny Premium voice</option>
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
                placeholder="Why this venue needs temporary Premium voice access"
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
                evidence. A grant allows two concurrent sessions, ten minutes per session, one hour
                per day, and five hours per month.
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
                  ? 'Append Premium voice grant'
                  : 'Append Premium voice denial'}
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

      <article
        className="rounded-2xl border border-pf-light bg-white p-5"
        aria-labelledby="voice-usage-heading"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 id="voice-usage-heading" className="text-lg font-semibold text-pf-deep">
              Voice usage and estimated cost
            </h3>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-pf-deep/70">
              Session minutes are allocated to each UTC month by connected-time overlap. Recorded
              realtime voice event costs use their creation month for the same venue. Token counts
              are reported by the visitor client and are unverified estimates, not an invoice.
            </p>
          </div>
          <label className="text-sm font-medium text-pf-deep">
            Month
            <input
              type="month"
              max={new Date().toISOString().slice(0, 7)}
              value={usageMonth}
              onChange={(event) => {
                if (event.target.value) void loadUsage(event.target.value)
              }}
              className="mt-1 min-h-11 rounded-xl border border-pf-light bg-white px-3 text-sm"
            />
          </label>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-live="polite">
          <div className="rounded-xl bg-pf-surface p-4">
            <p className="text-xs text-pf-deep/65">Voice minutes</p>
            <p className="mt-1 text-xl font-semibold text-pf-deep">
              {usageLoading ? 'Loading…' : (voiceUsage?.minutes ?? '—')}
            </p>
            <p className="text-xs text-pf-deep/60">{voiceUsage?.sessionCount ?? '—'} sessions</p>
          </div>
          <div className="rounded-xl bg-pf-surface p-4">
            <p className="text-xs text-pf-deep/65">Client-reported cost estimate</p>
            <p className="mt-1 text-xl font-semibold text-pf-deep">
              {usageLoading
                ? 'Loading…'
                : voiceUsage
                  ? formatEstimatedUsd(voiceUsage.estimatedCostUsd)
                  : '—'}
            </p>
          </div>
          <div className="rounded-xl bg-pf-surface p-4">
            <p className="text-xs text-pf-deep/65">Client-reported cost per minute</p>
            <p className="mt-1 text-xl font-semibold text-pf-deep">
              {usageLoading
                ? 'Loading…'
                : voiceUsage?.estimatedCostPerMinuteUsd == null
                  ? '—'
                  : formatEstimatedUsd(voiceUsage.estimatedCostPerMinuteUsd)}
            </p>
          </div>
          <div className="rounded-xl bg-pf-surface p-4">
            <p className="text-xs text-pf-deep/65">Effective monthly cap</p>
            <p className="mt-1 text-xl font-semibold text-pf-deep">
              {monthlyCapMinutes === null ? 'No active cap' : `${monthlyCapMinutes} min`}
            </p>
            <p className="text-xs text-pf-deep/60">
              {hasActiveVoiceCap
                ? 'From the effective Premium voice entitlement'
                : 'Default grant setting: 300 min'}
            </p>
          </div>
        </div>
        {usageUnavailable ? (
          <p role="status" className="mt-3 text-sm text-pf-deep/70">
            Usage summary is unavailable. Feature access controls remain available.
          </p>
        ) : null}
      </article>
    </section>
  )
}
