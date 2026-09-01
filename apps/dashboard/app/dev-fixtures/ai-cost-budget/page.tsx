import { notFound } from 'next/navigation'

import { AdminAiCostBudgetForm } from '../../../components/admin/AdminAiCostBudgetForm'
import { TRPCProvider } from '../../../lib/trpc'

export default function AiCostBudgetVisualFixturePage() {
  if (process.env.NODE_ENV !== 'development') notFound()

  return (
    <TRPCProvider scopeKey="ai-cost-budget-fixture">
      <main className="min-h-screen bg-pf-cream px-4 py-8 sm:px-8">
        <div className="mx-auto max-w-4xl">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-pf-deep/70">
            Founder Control Room fixture · provider-dark
          </p>
          <AdminAiCostBudgetForm
            tenantId="fixture-tenant"
            initialState={{
              configured: true,
              enabled: true,
              startsAt: '2026-09-01T00:00:00.000Z',
              endsAt: '2027-09-01T00:00:00.000Z',
              hardLimitUsd: '100.00000000',
              remainingUsd: '83.75000000',
              reservedUsd: '1.25000000',
              committedUsd: '15.00000000',
              revision: 4,
              breachedAt: null,
              reason: 'Synthetic operator fixture; no provider call is available.',
              updatedAt: '2026-09-01T00:00:00.000Z',
              updatedBy: 'fixture-admin',
            }}
          />
        </div>
      </main>
    </TRPCProvider>
  )
}
