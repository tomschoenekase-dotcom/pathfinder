'use client'

import { SemanticUpdatePreview } from '../../../components/admin/SemanticUpdatePreview'
import { TRPCProvider } from '../../../lib/trpc'

const scope = {
  tenantId: 'fixture-conflict-tenant',
  venueId: 'fixture-conflict-venue',
  proposalId: '11111111-1111-4111-8111-111111111111',
  proposalUpdatedAt: '2026-09-10T12:00:00.000Z',
}

function FixtureBody() {
  return (
    <main
      data-fixture="semantic-conflict-resolution"
      className="min-h-screen bg-pf-cream px-4 py-8 text-pf-deep sm:px-8"
    >
      <div className="mx-auto max-w-4xl">
        <header className="border-b border-pf-light pb-6">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-pf-primary">
            Human conflict review
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Resolve venue guidance</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-pf-deep/70">
            Bind the operator answer to an explicit decision. Replacement wording still returns to
            human review before any visitor-facing draft or publication.
          </p>
        </header>
        <section className="mt-6 border-l-2 border-amber-300 bg-white px-4 py-5 shadow-sm sm:px-6">
          <p className="text-sm font-semibold">Approved proposal · Willow gallery hours</p>
          <p className="mt-1 text-xs text-slate-600">
            Current guidance has stronger reviewed authority than the proposed change.
          </p>
          <SemanticUpdatePreview {...scope} hasTarget />
        </section>
      </div>
    </main>
  )
}

export function SemanticConflictResolutionFixtureClient() {
  return (
    <TRPCProvider scopeKey="semantic-conflict-resolution-fixture">
      <FixtureBody />
    </TRPCProvider>
  )
}
