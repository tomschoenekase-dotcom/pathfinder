'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import type { FormEvent } from 'react'

import { useTRPCClient } from '../../lib/trpc'

type DraftPackage = {
  id: string
  schemaVersion: number
  payloadHash: string
  createdBy: string
  createdAt: Date
}

export function SupportPackageHandoffForm({
  tenantId,
  venueId,
  requestId,
  expectedVersion,
  packages,
  closed,
}: {
  tenantId: string
  venueId: string
  requestId: string
  expectedVersion: number
  packages: DraftPackage[]
  closed: boolean
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const active = useRef(false)
  const [packageId, setPackageId] = useState(packages[0]?.id ?? '')
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (active.current || closed || !packageId) return
    active.current = true
    setPending(true)
    setFeedback(null)
    try {
      await client.admin.linkSupportDraftPackage.mutate({
        tenantId,
        venueId,
        requestId,
        venuePackageId: packageId,
        expectedVersion,
      })
      setFeedback(
        'Draft package linked. The package was not created, approved, applied, or published.',
      )
      router.refresh()
    } catch {
      setFeedback(
        'The link outcome could not be confirmed. Your selection is retained; refresh before trying again.',
      )
      router.refresh()
    } finally {
      active.current = false
      setPending(false)
    }
  }

  return (
    <section className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm">
      <h3 className="text-lg font-semibold text-pf-deep">Link an existing draft package</h3>
      <p className="mt-1 text-sm leading-6 text-pf-deep/65">
        This records lineage only. It never creates, approves, applies, or publishes a package.
      </p>
      {closed ? (
        <p className="mt-4 text-sm text-pf-deep/65">
          Closed requests cannot receive package links.
        </p>
      ) : packages.length === 0 ? (
        <p className="mt-4 text-sm text-pf-deep/65">
          No unlinked DRAFT packages are available for this venue.
        </p>
      ) : (
        <form onSubmit={(event) => void submit(event)} className="mt-4" aria-busy={pending}>
          <label className="grid gap-2 text-sm font-semibold text-pf-deep">
            Existing DRAFT package
            <select
              value={packageId}
              onChange={(event) => setPackageId(event.target.value)}
              disabled={pending}
              className="min-h-11 rounded-xl border border-pf-light bg-white px-3 font-normal"
            >
              {packages.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id} · schema v{item.schemaVersion} · {item.payloadHash.slice(0, 12)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={pending || !packageId}
            className="mt-4 min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {pending ? 'Linking…' : 'Link selected draft'}
          </button>
        </form>
      )}
      {feedback ? (
        <p className="mt-3 text-sm text-pf-deep/70" role="status">
          {feedback}
        </p>
      ) : null}
    </section>
  )
}
