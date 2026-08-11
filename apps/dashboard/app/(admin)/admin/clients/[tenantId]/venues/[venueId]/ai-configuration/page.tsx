export const dynamic = 'force-dynamic'

import { AiWorkloadConfigurationView } from '../../../../../../../../components/admin/AiWorkloadConfigurationView'
import { createAdminCaller } from '../../../../../../../../lib/admin-caller'

type Props = { params: Promise<{ tenantId: string; venueId: string }> }

export default async function AiConfigurationPage({ params }: Props) {
  const { tenantId, venueId } = await params
  const caller = await createAdminCaller()

  try {
    const data = await caller.admin.getVenueAiWorkloadConfiguration({ tenantId, venueId })
    return <AiWorkloadConfigurationView data={data} />
  } catch {
    return (
      <section className="rounded-3xl border border-rose-200 bg-white p-8 shadow-sm" role="alert">
        <h2 className="text-2xl font-semibold text-pf-deep">
          AI configuration could not be loaded
        </h2>
        <p className="mt-2 text-sm text-pf-deep/75">
          No model, fallback, or budget setting was changed. Refresh the page or return later.
        </p>
      </section>
    )
  }
}
