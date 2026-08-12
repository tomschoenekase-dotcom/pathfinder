'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import type { FormEvent } from 'react'

import {
  SupportRequestCategory,
  type SupportRequestCategory as SupportRequestCategoryType,
} from '@pathfinder/contracts/support-workflow'

import { useTRPCClient } from '../../lib/trpc'

const categoryLabels: Record<SupportRequestCategoryType, string> = {
  CONTENT_CORRECTION: 'Content correction',
  OPERATIONAL_UPDATE: 'Operational update',
  BRANDING: 'Branding',
  EXPERIENCE_BEHAVIOR: 'Experience behavior',
  ACCESSIBILITY: 'Accessibility',
  GENERAL: 'General',
}

function missingInformationLines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
}

function errorCode(error: unknown): string | null {
  const direct = (error as { data?: { code?: unknown } } | null)?.data?.code
  if (typeof direct === 'string') return direct
  const shaped = (error as { shape?: { data?: { code?: unknown } } } | null)?.shape?.data?.code
  return typeof shaped === 'string' ? shaped : null
}

export function SupportTriageForm({
  tenantId,
  venueId,
  requestId,
  expectedVersion,
  initialCategory,
  initialMissingInformation,
  closed,
}: {
  tenantId: string
  venueId: string
  requestId: string
  expectedVersion: number
  initialCategory: SupportRequestCategoryType
  initialMissingInformation: string[]
  closed: boolean
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const active = useRef(false)
  const [category, setCategory] = useState(initialCategory)
  const [missingInformation, setMissingInformation] = useState(initialMissingInformation.join('\n'))
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (active.current || closed) return
    const items = missingInformationLines(missingInformation)
    if (new Set(items).size !== items.length) {
      setFailed(true)
      setFeedback('Each missing-information request must be unique.')
      return
    }
    active.current = true
    setPending(true)
    setFailed(false)
    setFeedback(null)
    try {
      await client.admin.triageSupportRequest.mutate({
        tenantId,
        venueId,
        requestId,
        expectedVersion,
        category,
        missingInformation: items,
      })
      setFeedback(
        'Triage recorded. No status changed, client message sent, or package action executed.',
      )
      router.refresh()
    } catch (error) {
      setFailed(true)
      setFeedback(
        errorCode(error) === 'CONFLICT'
          ? 'This request changed before triage was recorded. Your selections remain in this form; review or copy them, then refresh the page before retrying.'
          : 'Triage was not recorded. Your selections remain in this form; review the error and try again.',
      )
    } finally {
      active.current = false
      setPending(false)
    }
  }

  return (
    <section className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm">
      <h3 className="text-lg font-semibold text-pf-deep">Structure request triage</h3>
      <p className="mt-1 text-sm leading-6 text-pf-deep/65">
        Classify the request and record the exact information still needed. This does not change
        workflow status, contact the client, or create or apply a package.
      </p>
      {closed ? (
        <p className="mt-4 text-sm text-pf-deep/65">Closed requests cannot be re-triaged.</p>
      ) : (
        <form
          className="mt-4 space-y-4"
          onSubmit={(event) => void submit(event)}
          aria-busy={pending}
        >
          <label className="grid gap-2 text-sm font-semibold text-pf-deep">
            Request category
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value as SupportRequestCategoryType)}
              disabled={pending}
              className="min-h-11 rounded-xl border border-pf-light bg-white px-3 font-normal"
            >
              {SupportRequestCategory.options.map((option) => (
                <option key={option} value={option}>
                  {categoryLabels[option]}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-2 text-sm font-semibold text-pf-deep">
            Missing information
            <textarea
              value={missingInformation}
              onChange={(event) => setMissingInformation(event.target.value)}
              disabled={pending}
              rows={4}
              maxLength={15_030}
              placeholder="One specific request per line; leave empty when nothing is missing"
              className="rounded-xl border border-pf-light bg-white px-3 py-2 font-normal"
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={pending}
              className="min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {pending ? 'Recording…' : 'Record triage'}
            </button>
            <span className="text-xs text-pf-deep/55">Request version {expectedVersion}</span>
          </div>
        </form>
      )}
      {feedback ? (
        <p className="mt-3 text-sm text-pf-deep/70" role={failed ? 'alert' : 'status'}>
          {feedback}
        </p>
      ) : null}
    </section>
  )
}
