import { ProspectOutreachCohortWorkspace } from '../../../../../components/admin/ProspectOutreachCohortWorkspace'
import { createAdminCaller } from '../../../../../lib/admin-caller'
export const dynamic = 'force-dynamic'
export default async function ProspectPreparationPage() {
  await createAdminCaller()
  return (
    <div className="space-y-6 p-6">
      <a href="/admin/prospects" className="text-sm underline">
        ← Back to prospects
      </a>
      <header>
        <h1 className="text-2xl font-semibold">Outreach preparation</h1>
        <p className="mt-2 text-slate-600">
          Individual native drafts, recoverable groups and exact human review. No live campaign or
          sending authorization.
        </p>
      </header>
      <ProspectOutreachCohortWorkspace />
    </div>
  )
}
