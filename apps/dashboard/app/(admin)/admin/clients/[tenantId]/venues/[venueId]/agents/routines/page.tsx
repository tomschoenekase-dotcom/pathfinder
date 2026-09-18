export const dynamic = 'force-dynamic'

import { AgentRoutinesView } from '../../../../../../../../../components/admin/AgentRoutinesView'
import { createAdminCaller } from '../../../../../../../../../lib/admin-caller'

export default async function AgentRoutinesPage({
  params,
}: {
  params: Promise<{ tenantId: string; venueId: string }>
}) {
  const { tenantId, venueId } = await params

  try {
    const caller = await createAdminCaller()
    const [routines, identities] = await Promise.all([
      caller.admin.listAgentRoutines({ tenantId, venueId }),
      caller.admin.listAgentIdentities({ tenantId, venueId, limit: 100 }),
    ])

    return (
      <AgentRoutinesView
        tenantId={tenantId}
        venueId={venueId}
        routines={routines}
        identities={identities.items}
      />
    )
  } catch {
    return <RoutineErrorState />
  }
}

function RoutineErrorState() {
  return (
    <section className="border border-rose-200 bg-white p-6" role="alert">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-rose-700">
        Recurring monitoring
      </p>
      <h2 className="mt-2 text-2xl font-semibold text-pf-deep">
        Routine definitions could not be loaded
      </h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-pf-deep/65">
        Refresh the page or return later. No routine was enabled, disabled, created, or run.
      </p>
    </section>
  )
}
