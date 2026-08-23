import { notFound } from 'next/navigation'

import { buildCustomerStatePreservationContext } from '@pathfinder/contracts/customer-state-preservation'

import { CustomerStatePreservationPanel } from '../../../components/admin/CustomerStatePreservationPanel'

export default function CustomerStatePreservationFixture() {
  if (process.env.NODE_ENV !== 'development') notFound()

  const context = buildCustomerStatePreservationContext({
    tenantId: 'tenant-fixture',
    tenantStatus: 'ACTIVE',
    billingStatus: 'ENDED',
    evidenceBounded: false,
    now: new Date('2026-08-23T12:00:00.000Z'),
    venues: [
      {
        id: 'venue-fixture',
        name: 'Museum of Returning Fixtures',
        isActive: false,
        placeRecordCount: 24,
        knowledgeRecordCount: 11,
        packageRecordCount: 3,
        manifestRecordCount: 2,
        hasBotConfigurationRecord: true,
        latestPlan: {
          id: 'plan-fixture',
          status: 'COMPLETED',
          updatedAt: new Date('2026-08-22T18:00:00.000Z'),
          revocationEvidenceCount: 3,
          completedRevocationCount: 2,
          exportArtifactCount: 4,
        },
      },
    ],
  })

  return (
    <main className="min-h-screen bg-pf-surface px-4 py-8 text-pf-deep sm:px-6 lg:px-10">
      <div className="mx-auto max-w-5xl space-y-5">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Development-only visual fixture
        </p>
        <CustomerStatePreservationPanel context={context} />
      </div>
    </main>
  )
}
