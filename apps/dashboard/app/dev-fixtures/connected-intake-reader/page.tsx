import { notFound } from 'next/navigation'

import { IntakeBuilderLifecyclePanel } from '../../../components/admin/IntakeBuilderLifecyclePanel'
import { TRPCProvider } from '../../../lib/trpc'

function one(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

export default async function ConnectedIntakeReaderFixture({
  searchParams,
}: {
  searchParams: Promise<{
    tenantId?: string | string[]
    venueId?: string | string[]
    runId?: string | string[]
  }>
}) {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED !== '1'
  )
    notFound()

  const query = await searchParams
  const tenantId = one(query.tenantId)
  const venueId = one(query.venueId)
  const runId = one(query.runId)
  if (!tenantId || !venueId || !runId) notFound()

  return (
    <main className="min-h-screen bg-pf-surface p-4 sm:p-8" data-fixture="connected-intake-reader">
      <div className="mx-auto max-w-5xl rounded-2xl border border-pf-light bg-white p-4 sm:p-6">
        <p className="text-sm font-medium text-pf-deep">Synthetic connected source review</p>
        <p className="mt-1 text-sm text-pf-deep/70">
          This development fixture reads retained disposable evidence through the authenticated
          application router.
        </p>
        <TRPCProvider scopeKey={`connected-reader:${tenantId}:${venueId}:${runId}`}>
          <IntakeBuilderLifecyclePanel tenantId={tenantId} venueId={venueId} runId={runId} />
        </TRPCProvider>
      </div>
    </main>
  )
}
