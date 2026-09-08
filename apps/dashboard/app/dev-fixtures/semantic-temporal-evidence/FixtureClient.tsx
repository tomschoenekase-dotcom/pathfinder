'use client'

import { SemanticUpdatePreview } from '../../../components/admin/SemanticUpdatePreview'
import { TRPCProvider } from '../../../lib/trpc'

const scope = {
  tenantId: 'fixture-tenant',
  venueId: 'fixture-venue',
  proposalId: '11111111-1111-4111-8111-111111111111',
  proposalUpdatedAt: '2026-08-25T13:00:00.000Z',
  hasTarget: false,
}

function EvidenceFixtureBody() {
  return (
    <main
      data-fixture="semantic-temporal-evidence"
      className="min-h-screen bg-pf-cream px-4 py-8 text-pf-deep sm:px-8"
    >
      <div className="mx-auto max-w-4xl">
        <header className="border-b border-pf-light pb-6">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-pf-primary">
            Reviewed temporal evidence
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Dated source handoff</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-pf-deep/70">
            Use reviewed evidence to prepare a dated update. Inspect its text and dates before
            creating an inactive draft. Scheduling and publication remain separate.
          </p>
        </header>
        <section className="mt-6 rounded-2xl border border-pf-light bg-white p-4 shadow-sm sm:p-6">
          <p className="text-sm font-semibold">Approved proposal · North entrance closure</p>
          <p className="mt-1 text-xs text-slate-600">
            Fixture scope: {scope.tenantId} / {scope.venueId}
          </p>
          <SemanticUpdatePreview
            tenantId={scope.tenantId}
            venueId={scope.venueId}
            proposalId={scope.proposalId}
            proposalUpdatedAt={scope.proposalUpdatedAt}
            hasTarget={scope.hasTarget}
          />
        </section>
      </div>
    </main>
  )
}

export function SemanticTemporalEvidenceFixtureClient() {
  return (
    <TRPCProvider scopeKey="semantic-temporal-evidence-fixture">
      <EvidenceFixtureBody />
    </TRPCProvider>
  )
}
