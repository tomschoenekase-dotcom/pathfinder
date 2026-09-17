'use client'

import { type FormEvent, useState } from 'react'
import { useRouter } from 'next/navigation'

import { useTRPCClient } from '../../lib/trpc'

const EMAIL_READINESS = ['UNKNOWN', 'REVIEW_REQUIRED', 'VALID', 'INVALID'] as const
const PERMISSION_STATES = [
  'UNKNOWN',
  'REVIEW_REQUIRED',
  'LEGITIMATE_INTEREST_RECORDED',
  'OPTED_IN',
] as const

type EmailReadiness = (typeof EMAIL_READINESS)[number]
type PermissionState = (typeof PERMISSION_STATES)[number]
type ContactEmailReadiness = EmailReadiness | 'UNVERIFIED'
type ContactPermissionState = PermissionState | 'OPTED_OUT' | 'PROHIBITED'

function label(value: string) {
  return value
    .toLowerCase()
    .split('_')
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(' ')
}

export function ProspectContactabilityReview({
  contactId,
  emailReadiness: initialEmailReadiness,
  permissionState: initialPermissionState,
  disabledReason,
}: {
  contactId: string
  emailReadiness: ContactEmailReadiness
  permissionState: ContactPermissionState
  disabledReason?: string | undefined
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [emailReadiness, setEmailReadiness] = useState<EmailReadiness>(
    initialEmailReadiness === 'UNVERIFIED' ? 'REVIEW_REQUIRED' : initialEmailReadiness,
  )
  const [permissionState, setPermissionState] = useState<PermissionState>(
    initialPermissionState === 'OPTED_OUT' || initialPermissionState === 'PROHIBITED'
      ? 'REVIEW_REQUIRED'
      : initialPermissionState,
  )
  const [evidence, setEvidence] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving || disabledReason || !evidence.trim()) return
    setSaving(true)
    setMessage(null)
    try {
      await client.admin.reviewProspectContactReadiness.mutate({
        contactId,
        emailReadiness,
        permissionState,
        evidence: evidence.trim(),
      })
      setEvidence('')
      setMessage(
        'Contact readiness review recorded. No draft, campaign, batch, queue, or email was created.',
      )
      router.refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not record the contact review.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      aria-busy={saving}
      className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Human contact readiness review</h3>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            Records evidence and eligibility only. It does not approve a campaign, create a batch,
            or send a message.
          </p>
        </div>
        <span className="rounded-full bg-white px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-600 ring-1 ring-slate-200">
          Human only
        </span>
      </div>

      {disabledReason ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {disabledReason}
        </p>
      ) : (
        <>
          <fieldset disabled={saving} className="mt-4">
            <legend className="sr-only">Contact readiness decision</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-semibold text-slate-700">
                Email verification status
                <select
                  value={emailReadiness}
                  onChange={(event) => setEmailReadiness(event.target.value as EmailReadiness)}
                  className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-normal text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
                >
                  {EMAIL_READINESS.map((value) => (
                    <option key={value} value={value}>
                      {label(value)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold text-slate-700">
                Permission basis
                <select
                  value={permissionState}
                  onChange={(event) => setPermissionState(event.target.value as PermissionState)}
                  className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-normal text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
                >
                  {PERMISSION_STATES.map((value) => (
                    <option key={value} value={value}>
                      {label(value)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="mt-3 block text-xs font-semibold text-slate-700">
              Human review evidence
              <textarea
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
                maxLength={2000}
                rows={3}
                placeholder="Record what was checked and why this permission state is accurate."
                className="mt-1 w-full rounded-xl border border-slate-300 bg-white p-3 text-sm font-normal text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
              />
            </label>
          </fieldset>
          {message ? (
            <p
              role={message.includes('recorded') ? 'status' : 'alert'}
              className="mt-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900"
            >
              {message}
            </p>
          ) : null}
          <button
            disabled={saving || !evidence.trim()}
            className="mt-3 min-h-11 rounded-xl bg-sky-700 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Recording review…' : 'Record contact review'}
          </button>
        </>
      )}
    </form>
  )
}
