'use client'

import { ProspectDirectory } from '../../../components/admin/ProspectDirectory'
import { TRPCProvider } from '../../../lib/trpc'

const fixture = {
  result: {
    items: [
      {
        id: 'synthetic-prospect',
        canonicalName: 'Harbor Museum',
        priority: 'HIGH',
        relationshipTier: 'HIGH_VALUE',
        venues: [{ name: 'Harbor Museum' }],
        territory: { name: 'Chicago' },
        opportunity: {
          stage: 'RESEARCHED',
          priority: 'HIGH',
          nextAction: 'Review contact',
          nextActionAt: new Date('2026-09-01T12:00:00.000Z'),
        },
      },
    ],
    nextCursor: null,
  },
  savedViews: [],
}

export function DialogAccessibilityFixture() {
  return (
    <TRPCProvider scopeKey="dialog-accessibility-fixture">
      <main className="min-h-screen bg-slate-100 p-4 sm:p-8">
        <div className="mx-auto max-w-6xl">
          <p className="mb-4 text-sm font-semibold text-slate-700">
            Provider-dark production dialog fixture
          </p>
          <ProspectDirectory fixture={fixture as never} outreachAvailable />
        </div>
      </main>
    </TRPCProvider>
  )
}
