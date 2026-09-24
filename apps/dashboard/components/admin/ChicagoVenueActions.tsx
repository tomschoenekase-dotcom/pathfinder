'use client'

import { useEffect, useState } from 'react'
import { z } from 'zod'
import {
  chicagoAddInput,
  chicagoChangeInput,
  chicagoDuplicateInput,
} from '@pathfinder/api/chicago-intelligence-contract'
import { useTRPCClient } from '../../lib/trpc'
import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { ChicagoEvidenceValue, chicagoControl } from './ChicagoVenueDetail'

type Action =
  | { kind: 'add'; input: z.input<typeof chicagoAddInput> }
  | { kind: 'change'; input: z.input<typeof chicagoChangeInput> }
  | { kind: 'duplicate'; input: z.input<typeof chicagoDuplicateInput> }
export type ChicagoMutationTransport = (action: Action, signal: AbortSignal) => Promise<unknown>

export function ChicagoVenueActions({
  venue,
  territoryId,
  act,
  onSuccess,
}: {
  venue?: { venueId: string; revision: number }
  territoryId?: string | undefined
  act?: ChicagoMutationTransport | undefined
  onSuccess: () => void
}) {
  const client = useTRPCClient()
  const [kind, setKind] = useState<Action['kind']>(venue ? 'change' : 'add')
  const [values, setValues] = useState<Record<string, string>>({
    state: 'IL',
    field: 'website',
    mode: 'propose',
    relation: 'possible-duplicate',
    researchedAt: new Date().toISOString().slice(0, 10),
  })
  const [firstParty, setFirstParty] = useState(false)
  const [pending, setPending] = useState<Action | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [receipt, setReceipt] = useState<unknown>(null)
  const [rejected, setRejected] = useState(false)
  const [unreadableRecovery, setUnreadableRecovery] = useState(false)
  const storageKey = `torchiko.chicago.pending.${venue?.venueId ?? 'new'}`
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(storageKey)
      if (stored) {
        const value: unknown = JSON.parse(stored)
        const action = z
          .discriminatedUnion('kind', [
            z.object({ kind: z.literal('add'), input: chicagoAddInput }),
            z.object({ kind: z.literal('change'), input: chicagoChangeInput }),
            z.object({ kind: z.literal('duplicate'), input: chicagoDuplicateInput }),
          ])
          .parse(value)
        setPending(action)
        setError(
          'A previous request has no confirmed result in this browser. Retry the exact request to recover its receipt safely.',
        )
      }
    } catch {
      setUnreadableRecovery(true)
      setError(
        'A saved recovery request could not be read. Inspect the venue audit history before starting a replacement change.',
      )
    }
  }, [storageKey])
  async function submit(action: Action) {
    if (busy) return
    setBusy(true)
    setError('')
    setReceipt(null)
    setRejected(false)
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(action))
    } catch {
      setError(
        'Browser recovery storage is unavailable. No request was sent. Enable session storage before making a change.',
      )
      setBusy(false)
      return
    }
    try {
      setPending(action)
      const controller = new AbortController()
      const result = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: 20_000,
        request: (signal) => {
          if (act) return act(action, signal)
          if (action.kind === 'add')
            return client.admin.addChicagoVenue.mutate(action.input, { signal })
          if (action.kind === 'change')
            return client.admin.changeChicagoVenue.mutate(action.input, { signal })
          return client.admin.proposeChicagoDuplicate.mutate(action.input, { signal })
        },
      })
      setReceipt(result)
      try {
        sessionStorage.removeItem(storageKey)
      } catch {
        /* The confirmed receipt is shown; a later retry is still idempotent. */
      }
      setPending(null)
      onSuccess()
    } catch (failure) {
      const data = failure && typeof failure === 'object' && 'data' in failure ? failure.data : null
      const code = data && typeof data === 'object' && 'code' in data ? data.code : null
      setRejected(['CONFLICT', 'BAD_REQUEST', 'FORBIDDEN', 'NOT_FOUND'].includes(String(code)))
      setError(
        `${failure instanceof Error ? failure.message : 'The request did not return a confirmed receipt.'} Your exact request is retained. Retry it to recover the result; a version conflict requires rereading the venue before making a new proposal.`,
      )
    } finally {
      setBusy(false)
    }
  }
  function retainRejectedRequest() {
    if (!pending || !rejected) return
    try {
      sessionStorage.setItem(
        `${storageKey}.rejected.${pending.input.idempotencyKey}`,
        JSON.stringify(pending),
      )
      sessionStorage.removeItem(storageKey)
      setPending(null)
      setRejected(false)
      setError(
        'Rejected request retained in this browser. Refresh the canonical record and review current evidence before preparing a new change.',
      )
      onSuccess()
    } catch {
      setError(
        'Recovery storage could not retain the rejected request. The original request remains available for inspection.',
      )
    }
  }
  function retainUnreadableRecovery() {
    try {
      const raw = sessionStorage.getItem(storageKey)
      if (raw !== null) sessionStorage.setItem(`${storageKey}.unreadable.${Date.now()}`, raw)
      sessionStorage.removeItem(storageKey)
      setUnreadableRecovery(false)
      setError(
        'The previous recovery text is retained separately in this browser. Inspect the venue audit before submitting another request.',
      )
    } catch {
      setError('Recovery text could not be retained safely. No replacement request can be sent.')
    }
  }
  function prepare() {
    try {
      const evidence = {
        url: values.url ?? '',
        researchedAt: values.researchedAt ?? '',
        statement: values.statement ?? '',
        firstParty,
      }
      const idempotencyKey = `ui-${crypto.randomUUID()}`
      let action: Action
      if (kind === 'add')
        action = {
          kind,
          input: chicagoAddInput.parse({
            name: values.name,
            city: values.city,
            state: values.state,
            website: values.website,
            category: values.category || undefined,
            territoryId,
            territoryRationale: values.territoryRationale,
            evidence,
            idempotencyKey,
          }),
        }
      else if (kind === 'change')
        action = {
          kind,
          input: chicagoChangeInput.parse({
            venueId: venue?.venueId,
            expectedVersion: venue?.revision,
            field: values.field,
            value: values.value,
            mode: values.mode,
            evidence,
            idempotencyKey,
          }),
        }
      else
        action = {
          kind,
          input: chicagoDuplicateInput.parse({
            venueId: venue?.venueId,
            expectedVersion: venue?.revision,
            otherVenueId: values.otherVenueId,
            relation: values.relation,
            reason: values.reason,
            evidence,
            idempotencyKey,
          }),
        }
      void submit(action)
    } catch (failure) {
      setError(
        failure instanceof z.ZodError
          ? failure.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(' · ')
          : 'The request could not be prepared.',
      )
    }
  }
  function input(key: string, title: string, options?: string[]) {
    return (
      <label key={key} className="block min-w-0 text-sm font-medium">
        {title}
        {options ? (
          <select
            className={`${chicagoControl} mt-1 w-full`}
            value={values[key] ?? ''}
            onChange={(event) =>
              setValues((current) => ({ ...current, [key]: event.target.value }))
            }
          >
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : (
          <input
            className={`${chicagoControl} mt-1 w-full`}
            type={key === 'researchedAt' ? 'date' : 'text'}
            maxLength={key === 'statement' ? 4000 : 2000}
            value={values[key] ?? ''}
            onChange={(event) =>
              setValues((current) => ({ ...current, [key]: event.target.value }))
            }
          />
        )}
      </label>
    )
  }
  return (
    <section className="border-y border-slate-300 py-5" aria-label="Maintain Chicago venue">
      <details>
        <summary className="min-h-11 cursor-pointer py-2 text-base font-semibold">
          {venue ? 'Maintain this venue with evidence' : 'Add a source-backed Chicago venue'}
        </summary>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          Each change keeps its evidence, actor, before/after state and retry receipt. Duplicate
          proposals enter review; records are not automatically merged.
        </p>
        {!venue && !territoryId && (
          <p className="mt-3 text-sm text-amber-900">
            The Chicago territory identity must be loaded before adding a venue.
          </p>
        )}
        <fieldset
          disabled={busy || Boolean(pending) || unreadableRecovery || (!venue && !territoryId)}
          className="mt-4 min-w-0 space-y-4 disabled:opacity-60"
        >
          {venue && (
            <label className="block text-sm font-medium">
              Action
              <select
                className={`${chicagoControl} mt-1 w-full`}
                value={kind}
                onChange={(event) => setKind(event.target.value as Action['kind'])}
              >
                <option value="change">Append evidence / change a field</option>
                <option value="duplicate">Propose duplicate or same operator</option>
              </select>
            </label>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {kind === 'add' ? (
              <>
                {input('name', 'Venue name')}
                {input('city', 'City')}
                {input('state', 'State', ['IL', 'IN', 'WI'])}
                {input('category', 'Category')}
                {input('website', 'Official venue website')}
                {input('territoryRationale', 'Evidence for Chicago operating territory membership')}
              </>
            ) : kind === 'change' ? (
              <>
                {input('field', 'Field', [
                  'name',
                  'website',
                  'venueType',
                  'addressLine1',
                  'city',
                  'region',
                  'estimatedSize',
                  'description',
                ])}
                {input('value', 'Verified value')}
                {input('mode', 'Disposition', ['propose', 'apply'])}
                <p className="self-end py-3 text-xs text-slate-600">
                  Expected record revision: {venue?.revision}. Concurrent changes produce a visible
                  conflict.
                </p>
              </>
            ) : (
              <>
                {input('otherVenueId', 'Other canonical venue ID')}
                {input('relation', 'Relationship', ['possible-duplicate', 'same-operator'])}
                {input('reason', 'Reason for review')}
              </>
            )}
            {input('url', 'Exact first-party source URL')}
            {input('researchedAt', 'Research date')}
            {input('statement', 'What the source actually establishes')}
          </div>
          <label className="flex min-h-11 items-start gap-3 py-2 text-sm">
            <input
              type="checkbox"
              className="mt-1 h-5 w-5 shrink-0"
              checked={firstParty}
              onChange={(event) => setFirstParty(event.target.checked)}
            />
            <span>I inspected this first-party source and it supports the recorded claim.</span>
          </label>
          <button className={chicagoControl} onClick={prepare}>
            {kind === 'add'
              ? 'Add venue with receipt'
              : kind === 'duplicate'
                ? 'Send relationship to review'
                : values.mode === 'apply'
                  ? 'Apply verified field with receipt'
                  : 'Propose field change'}
          </button>
        </fieldset>
        {busy && (
          <p role="status" className="mt-4 text-sm">
            Saving the source-backed request…
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="mt-4 break-words border border-amber-300 bg-amber-50 p-4 text-sm"
          >
            {error}
          </p>
        )}
        {unreadableRecovery && (
          <button className={`${chicagoControl} mt-4`} onClick={retainUnreadableRecovery}>
            Retain unreadable recovery text before a new request
          </button>
        )}
        {pending && !busy && (
          <div className="mt-4 space-y-3">
            <button
              className={chicagoControl}
              onClick={() => {
                void submit(pending)
              }}
            >
              Retry exact request / recover receipt
            </button>
            {rejected && (
              <button className={chicagoControl} onClick={retainRejectedRequest}>
                Retain rejected request & review current record
              </button>
            )}
            <details>
              <summary className="min-h-11 cursor-pointer py-3 text-sm">
                Retained request {pending.input.idempotencyKey}
              </summary>
              <ChicagoEvidenceValue value={pending} />
            </details>
          </div>
        )}
        {receipt !== null && (
          <div role="status" className="mt-4 border-t border-slate-200 pt-4">
            <h3 className="font-semibold">Mutation result & audit receipt</h3>
            <div className="mt-3">
              <ChicagoEvidenceValue value={receipt} />
            </div>
          </div>
        )}
      </details>
    </section>
  )
}
