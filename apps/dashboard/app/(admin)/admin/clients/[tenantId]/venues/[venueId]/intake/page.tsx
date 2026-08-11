export const dynamic = 'force-dynamic'

import { IntakeProposalWorkspace } from '../../../../../../../../components/IntakeProposalWorkspace'
import { createAdminCaller } from '../../../../../../../../lib/admin-caller'

type PageProps = { params: Promise<{ tenantId: string; venueId: string }> }

export default async function AdminIntakePage({ params }: PageProps) {
  const { tenantId, venueId } = await params
  const caller = await createAdminCaller()
  let proposals
  try {
    proposals = await caller.admin.listIntakeProposals({ tenantId, venueId, limit: 50 })
  } catch {
    return (
      <section className="rounded-2xl border border-rose-200 bg-rose-50 p-6" role="alert">
        <h2 className="text-lg font-semibold text-rose-950">Intake workspace unavailable</h2>
        <p className="mt-2 text-sm text-rose-900">
          The exact client and venue scope could not be loaded. No proposal was created.
        </p>
      </section>
    )
  }

  return (
    <div className="space-y-7">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Operator-assisted onboarding
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-pf-deep">
          Guided intake proposals
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
          Record a website address without fetching it, or collect consented structured staff
          answers. Every result remains an append-only draft awaiting package review; nothing is
          approved, applied, or published here.
        </p>
      </header>
      <IntakeProposalWorkspace adminTenantId={tenantId} venueId={venueId} proposals={proposals} />
    </div>
  )
}
