'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'

import { useTRPCClient } from '../../lib/trpc'

function errorCode(error: unknown) {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  return data && typeof data === 'object' && 'code' in data ? data.code : null
}

export function FreshnessReviewControl(props: {
  tenantId: string
  venueId: string
  entityType: 'PLACE' | 'KNOWLEDGE_ENTRY'
  entityId: string
  label: string
  expectedUpdatedAt: Date
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!confirmed) return setMessage('Explicit confirmation is required. No review was recorded.')
    const form = new FormData(event.currentTarget)
    const sourceType = String(form.get('sourceType') ?? '').trim()
    const sourceName = String(form.get('sourceName') ?? '').trim()
    const sourceUrl = String(form.get('sourceUrl') ?? '').trim()
    const provenanceRepair = {
      ...(sourceType ? { sourceType } : {}),
      ...(sourceName ? { sourceName } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
    }
    setBusy(true)
    setMessage(null)
    try {
      await client.admin.confirmFreshnessCurrent.mutate({
        tenantId: props.tenantId,
        venueId: props.venueId,
        entityType: props.entityType,
        entityId: props.entityId,
        expectedUpdatedAt: props.expectedUpdatedAt,
        conclusion: 'CONFIRMED_CURRENT',
        explicitlyConfirmedCurrent: true,
        ...(Object.keys(provenanceRepair).length ? { provenanceRepair } : {}),
      })
      setMessage('Current content confirmed. Review evidence was recorded without publishing.')
      router.refresh()
    } catch (error) {
      setMessage(
        errorCode(error) === 'CONFLICT'
          ? 'This record changed. Refresh and review the latest revision before confirming.'
          : 'The review was not recorded. No content was published or patched.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="mt-3 rounded-xl border border-pf-light bg-pf-surface/40 p-3">
      <summary className="cursor-pointer text-sm font-semibold text-pf-primary">
        Review current content
      </summary>
      <form className="mt-4 space-y-4" onSubmit={submit}>
        <p className="text-sm leading-6 text-pf-deep/70">
          This records review evidence for {props.label}. It does not edit factual content, publish,
          create a package, or fetch a source.
        </p>
        <fieldset className="grid gap-3 rounded-xl border border-pf-light bg-white p-3">
          <legend className="px-1 text-sm font-semibold text-pf-deep">
            Optional provenance repair
          </legend>
          <label className="grid gap-1 text-sm text-pf-deep">
            Source type
            <input
              name="sourceType"
              maxLength={64}
              placeholder="For example, DOCUMENT"
              className="min-h-11 rounded-xl border border-pf-light px-3"
            />
          </label>
          <label className="grid gap-1 text-sm text-pf-deep">
            Source name
            <input
              name="sourceName"
              maxLength={200}
              className="min-h-11 rounded-xl border border-pf-light px-3"
            />
          </label>
          <label className="grid gap-1 text-sm text-pf-deep">
            Source URL
            <input
              name="sourceUrl"
              type="url"
              maxLength={2000}
              placeholder="https://"
              className="min-h-11 rounded-xl border border-pf-light px-3"
            />
          </label>
        </fieldset>
        <label className="flex items-start gap-3 text-sm font-semibold leading-6 text-pf-deep">
          <input
            type="checkbox"
            required
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            className="mt-1 size-4"
          />
          I reviewed the current factual content and explicitly confirm it is current.
        </label>
        <button
          type="submit"
          disabled={busy || !confirmed}
          className="min-h-11 rounded-xl bg-pf-primary px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-55"
        >
          {busy ? 'Recording review…' : 'Confirm current content'}
        </button>
        {message ? (
          <p role="status" aria-live="polite" className="text-sm text-pf-deep/70">
            {message}
          </p>
        ) : null}
      </form>
    </details>
  )
}
