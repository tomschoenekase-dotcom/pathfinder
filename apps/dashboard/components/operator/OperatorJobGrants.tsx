'use client'

import { useRouter } from 'next/navigation'
import { useId, useState } from 'react'

import { formatWhen, untilLabel } from './format'
import type { OperatorJobGrantPanel } from './types'
import { CANCELLED_TEXT, errorText, useOperatorPost } from './useOperatorPost'

const EXPIRY_CHOICES = [
  { minutes: 60, label: '1 hour' },
  { minutes: 240, label: '4 hours' },
  { minutes: 1440, label: '24 hours' },
  { minutes: 4320, label: '3 days' },
  { minutes: 10080, label: '7 days' },
] as const

const STATUS_TEXT = {
  active: 'Active',
  exhausted: 'Used up',
  expired: 'Expired',
  revoked: 'Revoked',
} as const

const field =
  'mt-1 block min-h-11 w-full rounded-lg border border-slate-400 bg-white px-3 text-sm text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500'

function RevokeJobGrantButton({ id, name }: { id: string; name: string }) {
  const post = useOperatorPost('/api/operator/job-grants')
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setMessage(null)
    try {
      const result = await post({ action: 'revoke', id })
      if (result?.revoked === true) {
        setMessage('Revoked.')
        router.refresh()
      } else {
        setMessage(errorText(result?.error))
      }
    } catch {
      setMessage(CANCELLED_TEXT)
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <div className="flex flex-col items-start gap-2 lg:items-end">
      {confirming ? (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            aria-label={`Confirm revoke ${name}`}
            className="min-h-11 rounded-xl bg-red-800 px-4 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-2 disabled:opacity-50"
          >
            Confirm revoke
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming(false)}
            className="min-h-11 rounded-xl border border-slate-400 px-4 text-sm font-semibold text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          aria-label={`Revoke ${name}`}
          className="min-h-11 rounded-xl border border-red-800 px-4 text-sm font-semibold text-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-2"
        >
          Revoke
        </button>
      )}
      <p role="status" className="text-sm text-slate-800">
        {message}
      </p>
    </div>
  )
}

/**
 * Bounded job grants. A grant lets one named job from one connected app have specific, opted-in
 * actions applied from the approval page, within a client, a number of uses and a time limit.
 * Everything here is a signed-in person's decision: the Dot cannot create, widen, spend or revoke one, and
 * anything outside the bounds goes back to ask-first.
 */
export function OperatorJobGrants({ panel, now }: { panel: OperatorJobGrantPanel; now: Date }) {
  const post = useOperatorPost('/api/operator/job-grants')
  const router = useRouter()
  const formId = useId()
  const [name, setName] = useState('')
  const [clientId, setClientId] = useState('')
  const [tenantId, setTenantId] = useState('')
  const [venueId, setVenueId] = useState('')
  const [kinds, setKinds] = useState<string[]>([])
  const [maxExecutions, setMaxExecutions] = useState('5')
  const [expiresInMinutes, setExpiresInMinutes] = useState('1440')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const amountApplies = panel.kinds.some((kind) => kinds.includes(kind.kind) && kind.carriesAmount)
  const executions = Number(maxExecutions)
  const valid =
    name.trim().length > 0 &&
    clientId !== '' &&
    tenantId !== '' &&
    kinds.length > 0 &&
    Number.isInteger(executions) &&
    executions >= 1 &&
    executions <= 100

  async function create() {
    setBusy(true)
    setMessage(null)
    try {
      const dollars = amountApplies && amount.trim() !== '' ? Number(amount) : null
      const result = await post({
        action: 'create',
        name: name.trim(),
        clientId,
        tenantId,
        ...(venueId.trim() ? { venueId: venueId.trim() } : {}),
        kinds,
        maxExecutions: executions,
        expiresInMinutes: Number(expiresInMinutes),
        ...(dollars !== null && Number.isFinite(dollars) && dollars >= 0
          ? { maxAmountCents: Math.round(dollars * 100) }
          : {}),
      })
      if (result?.created === true) {
        setMessage('Grant created.')
        setName('')
        setKinds([])
        setVenueId('')
        setAmount('')
        router.refresh()
      } else {
        setMessage(errorText(result?.error))
      }
    } catch {
      setMessage(CANCELLED_TEXT)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <section
        aria-labelledby="job-grants-heading"
        className="rounded-xl border border-slate-300 bg-white p-4 sm:p-5"
      >
        <h2 id="job-grants-heading" className="text-lg font-semibold text-slate-950">
          Job grants
        </h2>
        <p className="mt-1 max-w-prose text-sm text-slate-700">
          Set limits for a named job from a connected app, then apply a matching pending change from
          its approval page. Each use requires your sign-in and spends one grant use. The grant
          stops when the uses run out, the time ends, or you revoke it. Only actions that opted in
          appear here; anything that emails, invites or bills stays outside grants.
        </p>
        {panel.kinds.length === 0 ? (
          <p className="mt-3 text-sm font-medium text-slate-900">
            No action can be granted yet, so there is nothing to create.
          </p>
        ) : (
          <form
            aria-labelledby="job-grants-heading"
            className="mt-4 grid gap-4 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (valid && !busy) void create()
            }}
          >
            <div className="sm:col-span-2">
              <label htmlFor={`${formId}-name`} className="text-sm font-semibold text-slate-950">
                Job name
              </label>
              <input
                id={`${formId}-name`}
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
                className={field}
              />
            </div>
            <div>
              <label htmlFor={`${formId}-client`} className="text-sm font-semibold text-slate-950">
                Connected app
              </label>
              <select
                id={`${formId}-client`}
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                className={field}
              >
                <option value="">Choose an app</option>
                {panel.clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${formId}-tenant`} className="text-sm font-semibold text-slate-950">
                Client
              </label>
              <select
                id={`${formId}-tenant`}
                value={tenantId}
                onChange={(event) => setTenantId(event.target.value)}
                className={field}
              >
                <option value="">Choose a client</option>
                {panel.tenants.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${formId}-venue`} className="text-sm font-semibold text-slate-950">
                Venue ID (blank covers every venue of the client)
              </label>
              <input
                id={`${formId}-venue`}
                value={venueId}
                maxLength={191}
                onChange={(event) => setVenueId(event.target.value)}
                className={field}
              />
            </div>
            <div>
              <label htmlFor={`${formId}-uses`} className="text-sm font-semibold text-slate-950">
                Most uses (1 to 100)
              </label>
              <input
                id={`${formId}-uses`}
                inputMode="numeric"
                value={maxExecutions}
                onChange={(event) => setMaxExecutions(event.target.value)}
                className={field}
              />
            </div>
            <div>
              <label htmlFor={`${formId}-expiry`} className="text-sm font-semibold text-slate-950">
                Ends after
              </label>
              <select
                id={`${formId}-expiry`}
                value={expiresInMinutes}
                onChange={(event) => setExpiresInMinutes(event.target.value)}
                className={field}
              >
                {EXPIRY_CHOICES.map((choice) => (
                  <option key={choice.minutes} value={choice.minutes}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </div>
            {amountApplies ? (
              <div>
                <label
                  htmlFor={`${formId}-amount`}
                  className="text-sm font-semibold text-slate-950"
                >
                  Most total amount (dollars, optional)
                </label>
                <input
                  id={`${formId}-amount`}
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  className={field}
                />
              </div>
            ) : null}
            <fieldset className="sm:col-span-2">
              <legend className="text-sm font-semibold text-slate-950">Actions it may apply</legend>
              <div className="mt-1 flex flex-wrap gap-3">
                {panel.kinds.map((kind) => (
                  <label
                    key={kind.kind}
                    className="flex min-h-11 items-center gap-2 text-sm text-slate-900"
                  >
                    <input
                      type="checkbox"
                      checked={kinds.includes(kind.kind)}
                      onChange={(event) =>
                        setKinds((previous) =>
                          event.target.checked
                            ? [...previous, kind.kind]
                            : previous.filter((entry) => entry !== kind.kind),
                        )
                      }
                    />
                    {kind.kind}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
              <button
                type="submit"
                disabled={!valid || busy}
                className="min-h-11 rounded-xl bg-slate-950 px-5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 disabled:opacity-50"
              >
                Create grant
              </button>
              <p className="text-sm text-slate-700">
                Creating a grant asks for Face ID or your passkey.
              </p>
              <p role="status" className="w-full text-sm font-medium text-slate-900">
                {message}
              </p>
            </div>
          </form>
        )}
      </section>

      <section aria-labelledby="job-grant-list-heading">
        <h2 id="job-grant-list-heading" className="text-lg font-semibold text-slate-950">
          Current and past grants
        </h2>
        {panel.grants.length === 0 ? (
          <p className="mt-2 rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-700">
            No job grants yet. Every change asks first.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
            {panel.grants.map((grant) => (
              <li
                key={grant.id}
                className="grid gap-3 p-4 sm:px-5 lg:grid-cols-[1.6fr_1fr_1fr_auto] lg:items-center"
              >
                <div className="min-w-0">
                  <p className="break-words text-base font-semibold text-slate-950">{grant.name}</p>
                  <p className="text-sm text-slate-700">
                    {grant.clientName} for {grant.tenantName ?? grant.tenantId}
                    {grant.venueId ? `, one venue` : ', every venue'}
                  </p>
                  <p className="break-words text-xs text-slate-600">{grant.kinds.join(', ')}</p>
                </div>
                <div className="text-sm text-slate-800">
                  <p>
                    {grant.remainingExecutions} of {grant.maxExecutions} uses left
                  </p>
                  {grant.maxAmountCents !== null && grant.remainingAmountCents !== null ? (
                    <p className="text-xs text-slate-600">
                      ${(grant.remainingAmountCents / 100).toFixed(2)} of $
                      {(grant.maxAmountCents / 100).toFixed(2)} left
                    </p>
                  ) : null}
                </div>
                <div className="text-sm text-slate-800">
                  <p className="font-semibold">{STATUS_TEXT[grant.status]}</p>
                  <p className="text-xs text-slate-600">
                    {grant.status === 'revoked'
                      ? `Revoked ${formatWhen(grant.revokedAt)}`
                      : grant.status === 'active'
                        ? `${untilLabel(grant.expiresAt, now)} (${formatWhen(grant.expiresAt)})`
                        : `Ended ${formatWhen(grant.expiresAt)}`}
                  </p>
                </div>
                <div>
                  {grant.status === 'active' ? (
                    <RevokeJobGrantButton id={grant.id} name={grant.name} />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
