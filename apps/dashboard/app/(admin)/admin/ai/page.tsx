export const dynamic = 'force-dynamic'

import { AdminAiSystemsView } from '../../../../components/admin/AdminAiSystemsView'
import { createAdminCaller } from '../../../../lib/admin-caller'

export default async function AdminAiSystemsPage() {
  const caller = await createAdminCaller()

  try {
    const [systems, credentials] = await Promise.all([
      caller.admin.getAdminAiSystems(),
      caller.admin.listPlatformWorkerPolicyCredentials(),
    ])
    return <AdminAiSystemsView systems={systems} credentials={credentials} />
  } catch {
    return (
      <section className="max-w-2xl border-l-2 border-rose-500 py-3 pl-4" role="alert">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
          AI systems unavailable
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          No routing or platform-worker policy was changed. Refresh this page after the admin read
          service is available.
        </p>
      </section>
    )
  }
}
