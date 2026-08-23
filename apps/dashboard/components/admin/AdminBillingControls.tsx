'use client'

import { useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'

type Props = {
  tenantId: string
  venues: ReadonlyArray<{ id: string; name: string }>
  catalog: ReadonlyArray<{ key: string; version: number; displayName: string }>
  agreementId: string | null
  hasManualBase: boolean
  rolloutFlags: ReadonlyArray<{
    tenantFlagKey: string
    label: string
    description: string
    globalEnabled: boolean
    tenantEnabled: boolean
    effective: boolean
  }>
  agentCommands?: ReadonlyArray<{
    id: string
    action: string
    status: string
    createdAt: Date | string
    approvalRequest: {
      expiresAt: Date | string | null
      decision: { decision: string; decidedByType: string; createdAt: Date | string } | null
    }
  }>
}

export function AdminBillingControls({
  tenantId,
  venues,
  catalog,
  agreementId,
  hasManualBase,
  rolloutFlags,
  agentCommands = [],
}: Props) {
  const client = useTRPCClient()
  const [venueIds, setVenueIds] = useState(venues.map((venue) => venue.id))
  const [planKey, setPlanKey] = useState(catalog[0]?.key ?? '')
  const [mode, setMode] = useState<
    'MANUAL_INVOICE' | 'COMPLIMENTARY' | 'PILOT' | 'NO_BILLING_REQUIRED'
  >('MANUAL_INVOICE')
  const [reason, setReason] = useState('')
  const [reference, setReference] = useState('')
  const [expiry, setExpiry] = useState('')
  const [amount, setAmount] = useState('')
  const [negotiatedCheckout, setNegotiatedCheckout] = useState(false)
  const [checkoutAmountMinor, setCheckoutAmountMinor] = useState('')
  const [checkoutVenueAmounts, setCheckoutVenueAmounts] = useState<Record<string, string>>({})
  const [manualVenueAmounts, setManualVenueAmounts] = useState<Record<string, string>>({})
  const [checkoutInterval, setCheckoutInterval] = useState<'month' | 'year'>('month')
  const [checkoutReason, setCheckoutReason] = useState('')
  const [checkoutReference, setCheckoutReference] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [flags, setFlags] = useState(rolloutFlags)

  function toggleVenue(id: string, checked: boolean) {
    setVenueIds((current) =>
      checked ? [...new Set([...current, id])] : current.filter((value) => value !== id),
    )
  }
  function completeVenueBreakdown(values: Record<string, string>, total: string) {
    if (!/^[1-9]\d{0,11}$/u.test(total) || !venueIds.length) return false
    const components = venueIds.map((id) => values[id] ?? '')
    if (components.some((value) => !/^[1-9]\d{0,11}$/u.test(value))) return false
    return components.reduce((sum, value) => sum + BigInt(value), 0n) === BigInt(total)
  }
  async function run(operation: () => Promise<string>) {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      setResult(await operation())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Billing operation failed.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <section
        className="rounded-2xl border border-cyan-200 bg-cyan-50 p-5"
        aria-labelledby="billing-rollout-heading"
      >
        <h2 id="billing-rollout-heading" className="text-lg font-semibold text-cyan-950">
          Pilot rollout controls
        </h2>
        <p className="mt-1 text-sm leading-6 text-cyan-900">
          Each capability requires both its staging kill switch and this client allowlist. Changes
          are tenant-scoped and strictly audited.
        </p>
        <ul className="mt-4 grid gap-3 lg:grid-cols-2">
          {flags.map((flag) => (
            <li key={flag.tenantFlagKey} className="rounded-xl border border-cyan-200 bg-white p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-semibold text-pf-deep">{flag.label}</h3>
                  <p className="mt-1 text-xs leading-5 text-pf-deep/65">{flag.description}</p>
                  <p className="mt-2 text-xs font-semibold text-pf-deep">
                    {flag.effective
                      ? 'Enabled for this client'
                      : flag.globalEnabled
                        ? 'Staging ready · client allowlist off'
                        : 'Staging kill switch off'}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy || (!flag.globalEnabled && !flag.tenantEnabled)}
                  onClick={() =>
                    void run(async () => {
                      const saved = await client.admin.setBillingTenantFlag.mutate({
                        tenantId,
                        flagKey: flag.tenantFlagKey,
                        enabled: !flag.tenantEnabled,
                      })
                      setFlags((current) =>
                        current.map((candidate) =>
                          candidate.tenantFlagKey === flag.tenantFlagKey
                            ? {
                                ...candidate,
                                tenantEnabled: saved.enabled,
                                globalEnabled: saved.globalEnabled,
                                effective: saved.effective,
                              }
                            : candidate,
                        ),
                      )
                      return `${flag.label} ${saved.effective ? 'enabled' : 'disabled'} for this client and audited.`
                    })
                  }
                  className="min-h-11 shrink-0 rounded-full border border-cyan-800 px-4 text-sm font-semibold text-cyan-950 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {flag.tenantEnabled ? 'Disable' : 'Enable'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
      {agentCommands.length ? (
        <section
          className="mt-8 rounded-2xl border border-amber-200 bg-amber-50 p-5"
          aria-labelledby="agent-billing-commands-heading"
        >
          <h2 id="agent-billing-commands-heading" className="text-lg font-semibold text-amber-950">
            Agent billing proposals
          </h2>
          <p className="mt-1 text-sm leading-6 text-amber-900">
            Agents can prepare exact commercial actions, but only a current human approval can make
            Execute available.
          </p>
          <ul className="mt-4 space-y-3">
            {agentCommands.map((command) => {
              const approved =
                command.approvalRequest.decision?.decision === 'APPROVED' &&
                command.approvalRequest.decision.decidedByType === 'HUMAN'
              return (
                <li
                  key={command.id}
                  className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="font-semibold text-pf-deep">
                      {command.action.replaceAll('_', ' ').toLowerCase()}
                    </p>
                    <p className="mt-1 text-xs text-pf-deep/60">
                      {command.status.replaceAll('_', ' ').toLowerCase()} · proposed{' '}
                      {new Date(command.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={!approved || command.status === 'COMPLETED' || busy}
                    onClick={() =>
                      void run(async () => {
                        await client.admin.executeApprovedBillingCommand.mutate({
                          tenantId,
                          commandId: command.id,
                        })
                        return 'Approved billing command executed through the canonical billing service. Refresh to view provider state.'
                      })
                    }
                    className="min-h-11 rounded-full bg-amber-900 px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {command.status === 'COMPLETED'
                      ? 'Executed'
                      : approved
                        ? 'Execute approved action'
                        : 'Human approval required'}
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}
      <section
        aria-labelledby="billing-controls-heading"
        className="mt-8 rounded-2xl border border-pf-light bg-white p-5"
      >
        <h2 id="billing-controls-heading" className="text-lg font-semibold text-pf-deep">
          Audited billing actions
        </h2>
        <p className="mt-1 text-sm leading-6 text-pf-deep/65">
          Only a signed-in platform administrator can create these records. Every grant requires a
          reason and expiry; no action here uses live Stripe mode.
        </p>
        {error ? (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
          >
            {error}
          </p>
        ) : null}
        {result ? (
          <p
            role="status"
            className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"
          >
            {result}
          </p>
        ) : null}
        <fieldset disabled={busy} className="mt-5">
          <legend className="text-sm font-semibold text-pf-deep">Covered venues</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {venues.map((venue) => (
              <label
                key={venue.id}
                className="flex min-h-11 items-center gap-3 rounded-xl border border-pf-light px-3 text-sm"
              >
                <input
                  type="checkbox"
                  checked={venueIds.includes(venue.id)}
                  onChange={(event) => toggleVenue(venue.id, event.target.checked)}
                />
                {venue.name}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="mt-6 grid gap-5 xl:grid-cols-3">
          <form
            className="rounded-2xl border border-sky-200 bg-sky-50 p-4"
            onSubmit={(event) => {
              event.preventDefault()
              const plan = catalog.find((candidate) => candidate.key === planKey)
              if (!plan) return
              void run(async () => {
                const session = await client.admin.createClientCheckout.mutate({
                  tenantId,
                  planKey: plan.key,
                  planVersion: plan.version,
                  venueIds,
                  operationKey: crypto.randomUUID(),
                  replaceManualArrangement: hasManualBase,
                  ...(negotiatedCheckout
                    ? {
                        negotiatedTerms: {
                          amountMinor: checkoutAmountMinor,
                          venueAmounts: venueIds.map((venueId) => ({
                            venueId,
                            amountMinor: checkoutVenueAmounts[venueId]!,
                          })),
                          currency: 'usd',
                          interval: checkoutInterval,
                          intervalCount: 1,
                          reason: checkoutReason,
                          reference: checkoutReference,
                        },
                      }
                    : {}),
                })
                if (!session.url)
                  return 'A matching Checkout attempt already exists; refresh the billing timeline.'
                window.open(session.url, '_blank', 'noopener,noreferrer')
                return 'Test-mode Checkout link opened. Access remains pending until verified webhook processing.'
              })
            }}
          >
            <h3 className="font-semibold text-sky-950">Create test Checkout</h3>
            <label
              className="mt-3 block text-xs font-bold uppercase tracking-wider text-sky-900"
              htmlFor="admin-billing-plan"
            >
              Approved plan
            </label>
            <select
              id="admin-billing-plan"
              value={planKey}
              onChange={(event) => setPlanKey(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-xl border border-sky-200 bg-white px-3 text-sm"
            >
              <option value="">Select a configured test plan</option>
              {catalog.map((plan) => (
                <option key={`${plan.key}:${plan.version}`} value={plan.key}>
                  {plan.displayName}
                </option>
              ))}
            </select>
            <label className="mt-4 flex min-h-11 items-center gap-3 rounded-xl border border-sky-200 bg-white px-3 text-sm text-sky-950">
              <input
                type="checkbox"
                checked={negotiatedCheckout}
                onChange={(event) => setNegotiatedCheckout(event.target.checked)}
              />
              Use an approved negotiated total
            </label>
            {negotiatedCheckout ? (
              <div className="mt-3 space-y-3 rounded-xl border border-sky-200 bg-white p-3">
                <p className="text-xs leading-5 text-sky-900">
                  Creates an inline recurring Price under the configured Torchiko Product. It does
                  not add another visible catalog price, and quantity remains one regardless of the
                  number of covered venues.
                </p>
                <label className="block text-xs font-bold uppercase tracking-wider text-sky-900">
                  Total in USD cents
                  <input
                    required
                    inputMode="numeric"
                    pattern="[1-9][0-9]{0,11}"
                    value={checkoutAmountMinor}
                    onChange={(event) => setCheckoutAmountMinor(event.target.value)}
                    className="mt-1 min-h-11 w-full rounded-xl border border-sky-200 px-3 text-sm font-normal tracking-normal"
                  />
                  <span className="mt-1 block normal-case font-normal tracking-normal">
                    Enter the exact founder-approved monthly total in whole cents.
                  </span>
                </label>
                <fieldset className="rounded-xl border border-sky-200 p-3">
                  <legend className="px-1 text-xs font-bold uppercase tracking-wider text-sky-900">
                    Approved venue breakdown
                  </legend>
                  <p className="text-xs leading-5 text-sky-900">
                    Every covered venue needs a positive component, and the components must equal
                    the approved total.
                  </p>
                  <div className="mt-3 space-y-3">
                    {venues
                      .filter((venue) => venueIds.includes(venue.id))
                      .map((venue) => (
                        <label key={venue.id} className="block text-xs font-semibold text-sky-950">
                          {venue.name} in USD cents
                          <input
                            required
                            aria-label={`${venue.name} negotiated amount in USD cents`}
                            inputMode="numeric"
                            pattern="[1-9][0-9]{0,11}"
                            value={checkoutVenueAmounts[venue.id] ?? ''}
                            onChange={(event) =>
                              setCheckoutVenueAmounts((current) => ({
                                ...current,
                                [venue.id]: event.target.value,
                              }))
                            }
                            className="mt-1 min-h-11 w-full rounded-xl border border-sky-200 px-3 text-sm font-normal"
                          />
                        </label>
                      ))}
                  </div>
                  {checkoutAmountMinor &&
                  completeVenueBreakdown(checkoutVenueAmounts, checkoutAmountMinor) ? (
                    <p role="status" className="mt-3 text-xs font-semibold text-emerald-800">
                      Venue components match the approved total.
                    </p>
                  ) : (
                    <p className="mt-3 text-xs font-semibold text-amber-800">
                      Complete and reconcile the venue components before creating Checkout.
                    </p>
                  )}
                </fieldset>
                <label className="block text-xs font-bold uppercase tracking-wider text-sky-900">
                  Billing interval
                  <select
                    value={checkoutInterval}
                    onChange={(event) =>
                      setCheckoutInterval(event.target.value as 'month' | 'year')
                    }
                    className="mt-1 min-h-11 w-full rounded-xl border border-sky-200 px-3 text-sm font-normal tracking-normal"
                  >
                    <option value="month">Monthly</option>
                    <option value="year">Yearly</option>
                  </select>
                </label>
                <label className="block text-xs font-bold uppercase tracking-wider text-sky-900">
                  Agreement or quote reference
                  <input
                    required
                    value={checkoutReference}
                    onChange={(event) => setCheckoutReference(event.target.value)}
                    className="mt-1 min-h-11 w-full rounded-xl border border-sky-200 px-3 text-sm font-normal tracking-normal"
                  />
                </label>
                <label className="block text-xs font-bold uppercase tracking-wider text-sky-900">
                  Pricing reason
                  <textarea
                    required
                    minLength={3}
                    value={checkoutReason}
                    onChange={(event) => setCheckoutReason(event.target.value)}
                    className="mt-1 min-h-20 w-full rounded-xl border border-sky-200 p-3 text-sm font-normal tracking-normal"
                  />
                </label>
              </div>
            ) : null}
            {hasManualBase ? (
              <p className="mt-2 text-xs text-sky-900">
                On successful provider creation, the current manual arrangement will end and this
                pending Stripe arrangement becomes the base.
              </p>
            ) : null}
            <button
              type="submit"
              disabled={
                !planKey ||
                !venueIds.length ||
                busy ||
                (negotiatedCheckout &&
                  (!checkoutAmountMinor ||
                    !completeVenueBreakdown(checkoutVenueAmounts, checkoutAmountMinor) ||
                    !checkoutReference.trim() ||
                    !checkoutReason.trim()))
              }
              className="mt-4 min-h-11 rounded-full bg-sky-900 px-4 text-sm font-semibold text-white disabled:opacity-50"
            >
              Create Checkout link
            </button>
          </form>

          <form
            className="rounded-2xl border border-violet-200 bg-violet-50 p-4"
            onSubmit={(event) => {
              event.preventDefault()
              void run(async () => {
                await client.admin.createManualArrangement.mutate({
                  tenantId,
                  mode,
                  planKey: planKey || 'negotiated',
                  amountMinor: amount || null,
                  ...(amount
                    ? {
                        venueAmounts: venueIds.map((venueId) => ({
                          venueId,
                          amountMinor: manualVenueAmounts[venueId]!,
                        })),
                      }
                    : {}),
                  accessEndsAt: expiry ? new Date(`${expiry}T23:59:59.000Z`).toISOString() : null,
                  venueIds,
                  reason,
                  reference: reference || null,
                })
                return 'Manual commercial arrangement created and strictly audited. Refresh to view it.'
              })
            }}
          >
            <h3 className="font-semibold text-violet-950">Create manual arrangement</h3>
            <label
              className="mt-3 block text-xs font-bold uppercase tracking-wider text-violet-900"
              htmlFor="manual-mode"
            >
              Billing source
            </label>
            <select
              id="manual-mode"
              value={mode}
              onChange={(event) => setMode(event.target.value as typeof mode)}
              className="mt-1 min-h-11 w-full rounded-xl border border-violet-200 bg-white px-3 text-sm"
            >
              <option value="MANUAL_INVOICE">Manual invoice</option>
              <option value="COMPLIMENTARY">Complimentary</option>
              <option value="PILOT">Pilot</option>
              <option value="NO_BILLING_REQUIRED">No billing required</option>
            </select>
            <label
              className="mt-3 block text-xs font-bold uppercase tracking-wider text-violet-900"
              htmlFor="manual-amount"
            >
              Amount in minor units (optional)
            </label>
            <input
              id="manual-amount"
              inputMode="numeric"
              pattern="\d*"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-xl border border-violet-200 px-3 text-sm"
            />
            {amount ? (
              <fieldset className="mt-3 rounded-xl border border-violet-200 bg-white p-3">
                <legend className="px-1 text-xs font-bold uppercase tracking-wider text-violet-900">
                  Venue breakdown
                </legend>
                <div className="space-y-3">
                  {venues
                    .filter((venue) => venueIds.includes(venue.id))
                    .map((venue) => (
                      <label key={venue.id} className="block text-xs font-semibold text-violet-950">
                        {venue.name} in minor units
                        <input
                          required
                          aria-label={`${venue.name} manual amount in minor units`}
                          inputMode="numeric"
                          pattern="[1-9][0-9]{0,11}"
                          value={manualVenueAmounts[venue.id] ?? ''}
                          onChange={(event) =>
                            setManualVenueAmounts((current) => ({
                              ...current,
                              [venue.id]: event.target.value,
                            }))
                          }
                          className="mt-1 min-h-11 w-full rounded-xl border border-violet-200 px-3 text-sm font-normal"
                        />
                      </label>
                    ))}
                </div>
                <p className="mt-3 text-xs font-semibold text-violet-900">
                  {completeVenueBreakdown(manualVenueAmounts, amount)
                    ? 'Venue components match the arrangement total.'
                    : 'Venue components must equal the arrangement total.'}
                </p>
              </fieldset>
            ) : null}
            <label
              className="mt-3 block text-xs font-bold uppercase tracking-wider text-violet-900"
              htmlFor="manual-expiry"
            >
              Access expiry{' '}
              {mode === 'COMPLIMENTARY' || mode === 'PILOT' ? '(required)' : '(optional)'}
            </label>
            <input
              id="manual-expiry"
              type="date"
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-xl border border-violet-200 px-3 text-sm"
            />
            <label
              className="mt-3 block text-xs font-bold uppercase tracking-wider text-violet-900"
              htmlFor="manual-reason"
            >
              Reason
            </label>
            <textarea
              id="manual-reason"
              required
              minLength={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="mt-1 min-h-24 w-full rounded-xl border border-violet-200 p-3 text-sm"
            />
            <label
              className="mt-3 block text-xs font-bold uppercase tracking-wider text-violet-900"
              htmlFor="manual-reference"
            >
              Agreement reference
            </label>
            <input
              id="manual-reference"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-xl border border-violet-200 px-3 text-sm"
            />
            <button
              type="submit"
              disabled={
                !venueIds.length ||
                !reason.trim() ||
                (Boolean(amount) && !completeVenueBreakdown(manualVenueAmounts, amount)) ||
                ((mode === 'COMPLIMENTARY' || mode === 'PILOT') && !expiry) ||
                busy
              }
              className="mt-4 min-h-11 rounded-full bg-violet-900 px-4 text-sm font-semibold text-white disabled:opacity-50"
            >
              Create arrangement
            </button>
          </form>

          <form
            className="rounded-2xl border border-amber-200 bg-amber-50 p-4"
            onSubmit={(event) => {
              event.preventDefault()
              if (!agreementId || !expiry) return
              void run(async () => {
                await client.admin.createBillingAccessOverride.mutate({
                  tenantId,
                  agreementId,
                  effect: 'GRANT',
                  kind: 'PLATFORM_ADMIN',
                  expiresAt: new Date(`${expiry}T23:59:59.000Z`).toISOString(),
                  reason,
                  reference: reference || null,
                })
                return 'Time-bounded access override created and strictly audited. Refresh to view it.'
              })
            }}
          >
            <h3 className="font-semibold text-amber-950">Temporary access override</h3>
            <p className="mt-2 text-xs leading-5 text-amber-900">
              This is explicit admin evidence, never a Stripe payment. Use the reason, reference,
              and expiry fields at left.
            </p>
            <button
              type="submit"
              disabled={!agreementId || !expiry || !reason.trim() || busy}
              className="mt-4 min-h-11 rounded-full bg-amber-900 px-4 text-sm font-semibold text-white disabled:opacity-50"
            >
              Grant until expiry
            </button>
          </form>
        </div>
      </section>
    </>
  )
}
