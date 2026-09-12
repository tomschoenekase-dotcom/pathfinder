import { SUPPORT_PORTABLE_EXPORT_MAX_BYTES, SUPPORT_PORTABLE_EXPORT_SECTIONS } from '@pathfinder/contracts'
import { notFound } from 'next/navigation'

import { SupportPortableExportForm } from '../../../components/admin/SupportPortableExportForm'

export default function SupportPortableExportFixturePage() {
  if (process.env.NODE_ENV !== 'development') notFound()

  return (
    <main className="min-h-screen bg-pf-surface px-3 py-6 text-pf-deep sm:px-8 sm:py-12">
      <div className="mx-auto max-w-5xl">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-pf-primary">
          Development-only visual fixture
        </p>
        <SupportPortableExportForm
          tenantId="fixture-tenant"
          venues={[
            {
              id: 'fixture-riverside',
              name: 'Riverside Aquarium and Watershed Discovery Center',
              isActive: true,
            },
            { id: 'fixture-paused', name: 'Harbor Learning Annex', isActive: false },
          ]}
          recipients={[
            {
              userId: 'fixture-owner',
              fullName: 'Morgan Avery, Riverside Aquarium Operations',
              email: 'morgan.avery@example.test',
              role: 'OWNER',
            },
          ]}
          sections={SUPPORT_PORTABLE_EXPORT_SECTIONS}
          maxExportBytes={SUPPORT_PORTABLE_EXPORT_MAX_BYTES}
        />
      </div>
    </main>
  )
}
