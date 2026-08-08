'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { createTRPCClient } from '../../lib/trpc'

type AdminVenueReportConfigurationProps = {
  tenantId: string
  venueId: string
  enabled: boolean
  updatedAt: string | null
}

export function AdminVenueReportConfiguration({
  tenantId,
  venueId,
  enabled: initialEnabled,
  updatedAt,
}: AdminVenueReportConfigurationProps) {
  const router = useRouter()
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) clientRef.current = createTRPCClient()

  const [enabled, setEnabled] = useState(initialEnabled)
  const [revision, setRevision] = useState(updatedAt)
  const [pending, setPending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    setEnabled(initialEnabled)
    setRevision(updatedAt)
  }, [initialEnabled, updatedAt])

  async function update(nextEnabled: boolean) {
    setPending(true)
    setErrorMessage(null)
    try {
      const result = await clientRef.current!.admin.updateVenueReportConfiguration.mutate({
        tenantId,
        venueId,
        enabled: nextEnabled,
        expectedUpdatedAt: revision ? new Date(revision) : null,
      })
      setEnabled(result.enabled)
      setRevision(result.updatedAt?.toISOString() ?? null)
      router.refresh()
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to update report availability.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-pf-deep">Client report access</h2>
          <p className="mt-1 text-sm text-pf-deep/60">
            Default-off. Disabling hides published reports and prevents new report requests without
            deleting report history.
          </p>
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            void update(!enabled)
          }}
          className="inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? 'Saving...' : enabled ? 'Disable Reports' : 'Enable Reports'}
        </button>
      </div>
      <p className="mt-3 text-sm font-medium text-pf-deep">
        Current state: {enabled ? 'Enabled' : 'Disabled'}
      </p>
      {errorMessage ? <p className="mt-3 text-sm text-rose-600">{errorMessage}</p> : null}
    </section>
  )
}
