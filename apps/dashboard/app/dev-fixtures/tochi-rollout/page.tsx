import { notFound } from 'next/navigation'

import { TOCHI_ROLLOUT_FLAGS } from '@pathfinder/config'

import { AdminTochiRolloutForm } from '../../../components/admin/AdminTochiRolloutForm'
import { TRPCProvider } from '../../../lib/trpc'

export default function TochiRolloutFixture() {
  if (process.env.NODE_ENV !== 'development') notFound()

  const flags = TOCHI_ROLLOUT_FLAGS.map((flag, index) => ({
    tenantFlagKey: flag.tenantFlagKey,
    label: flag.label,
    description: flag.description,
    globalEnabled: index !== 3,
    tenantEnabled: index === 0 || index === 2,
    effective: index === 0 || index === 2,
  }))

  return (
    <main className="min-h-screen bg-pf-surface px-4 py-8 text-pf-deep sm:px-8 sm:py-12">
      <div className="mx-auto max-w-4xl bg-white px-5 py-8 shadow-sm sm:px-10 sm:py-10">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pf-primary">
          Development fixture
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Private Tochi rollout</h1>
        <p className="mb-8 mt-3 max-w-2xl text-sm leading-6 text-pf-deep/70">
          Founder-only controls require both a server kill switch and a client allowlist. These
          fixture controls do not alter real client data.
        </p>
        <TRPCProvider scopeKey="fixture:tochi-rollout">
          <AdminTochiRolloutForm tenantId="fixture-tenant" flags={flags} />
        </TRPCProvider>
      </div>
    </main>
  )
}
