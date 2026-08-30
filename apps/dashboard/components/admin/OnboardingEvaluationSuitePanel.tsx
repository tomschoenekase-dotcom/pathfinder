'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { useTRPCClient } from '../../lib/trpc'

type ReviewablePackage = {
  id: string
  status: 'DRAFT' | 'APPROVED'
  payloadHash: string
  baseDigest: string
  createdAt: Date
  approvedAt: Date | null
  supportHandoffs: { supportRequestId: string; requestVersion: number }[]
}

export function OnboardingEvaluationSuitePanel(props: {
  tenantId: string
  venueId: string
  reviewablePackages: ReviewablePackage[]
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [packageId, setPackageId] = useState(props.reviewablePackages[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const submitting = useRef(false)

  useEffect(() => {
    setPackageId(props.reviewablePackages[0]?.id ?? '')
    setBusy(false)
    setMessage(null)
    submitting.current = false
  }, [props.tenantId, props.venueId, props.reviewablePackages])

  async function prepare(suite: 'CORE' | 'LAUNCH_LANGUAGES') {
    if (!packageId || busy || submitting.current) return
    submitting.current = true
    setBusy(true)
    setMessage(null)
    try {
      const result = await client.admin.prepareOnboardingEvaluationSuite.mutate({
        tenantId: props.tenantId,
        venueId: props.venueId,
        packageId,
        suite,
      })
      const created = result.cases.filter((item) => !item.replayed).length
      const total = result.cases.length
      setMessage(
        `${suite === 'CORE' ? 'Seven-dimension review suite' : 'Ten-language grounded and fallback suite'} ready for this exact package: ${created} new revision${created === 1 ? '' : 's'}, ${total - created} exact replay${total - created === 1 ? '' : 's'}.`,
      )
      router.refresh()
    } catch {
      setMessage(
        'The suite could not be prepared. The package may no longer be reviewable or its exact validation evidence may have changed. No partial suite was committed.',
      )
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return (
    <section
      className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm sm:p-6"
      aria-labelledby="onboarding-suite-heading"
    >
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
        Remote onboarding gate
      </p>
      <h3 id="onboarding-suite-heading" className="mt-1 text-xl font-semibold text-pf-deep">
        Prepare the pre-approval package QA suite
      </h3>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/70">
        Creates immutable fact, navigation, accessibility, safety, multilingual, adversarial, and
        unanswerable cases from one exact DRAFT or APPROVED package. Missing facts become
        honest-unknown tests; they are never invented.
      </p>
      {props.reviewablePackages.length === 0 ? (
        <p className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          No error-free DRAFT or APPROVED package is available for QA preparation.
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="block flex-1 text-sm font-semibold text-pf-deep">
            Exact reviewable package
            <select
              aria-label="Exact reviewable package"
              value={packageId}
              onChange={(event) => setPackageId(event.target.value)}
              disabled={busy}
              className="mt-2 min-h-11 w-full rounded-xl border border-pf-light bg-white px-3"
            >
              {props.reviewablePackages.map((pkg) => (
                <option key={pkg.id} value={pkg.id}>
                  {pkg.status} · {pkg.payloadHash.slice(0, 12)}
                  {pkg.supportHandoffs[0]
                    ? ` · support ${pkg.supportHandoffs[0].supportRequestId}`
                    : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => prepare('CORE')}
              disabled={busy || !packageId}
              className="min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Preparing…' : 'Prepare seven cases'}
            </button>
            <button
              type="button"
              onClick={() => prepare('LAUNCH_LANGUAGES')}
              disabled={busy || !packageId}
              className="min-h-11 rounded-xl border border-pf-primary bg-white px-5 text-sm font-semibold text-pf-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Preparing…' : 'Prepare 20 language cases'}
            </button>
          </div>
        </div>
      )}
      {message ? (
        <p role="status" className="mt-3 text-sm text-pf-deep/75">
          {message}
        </p>
      ) : null}
      <p className="mt-3 text-xs text-pf-deep/70">
        Preparing cases does not run AI, spend a budget, publish content, or change the client
        package. The language suite pairs one grounded answer and one honest fallback in each of the
        ten supported launch languages.
      </p>
    </section>
  )
}
