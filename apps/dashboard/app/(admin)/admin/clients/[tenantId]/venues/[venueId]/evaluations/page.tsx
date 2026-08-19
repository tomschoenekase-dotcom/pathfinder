export const dynamic = 'force-dynamic'

import { EvaluationOperationsView } from '../../../../../../../../components/admin/EvaluationOperationsView'
import { createAdminCaller } from '../../../../../../../../lib/admin-caller'

type EvaluationOperationsPageProps = {
  params: Promise<{ tenantId: string; venueId: string }>
  searchParams: Promise<{ cursorCreatedAt?: string; cursorId?: string }>
}

export default async function EvaluationOperationsPage({
  params,
  searchParams,
}: EvaluationOperationsPageProps) {
  const { tenantId, venueId } = await params
  const { cursorCreatedAt, cursorId } = await searchParams
  const caller = await createAdminCaller()

  try {
    const metricsTo = new Date()
    const metricsFrom = new Date(metricsTo.getTime() - 90 * 24 * 60 * 60 * 1000)
    const [data, cases, approvedPackages, onboardingMetrics] = await Promise.all([
      caller.admin.listEvaluationRuns({
        tenantId,
        venueId,
        ...(cursorCreatedAt && cursorId
          ? { cursor: { createdAt: cursorCreatedAt, id: cursorId } }
          : {}),
      }),
      caller.admin.listEvaluationCases({ tenantId, venueId }),
      caller.admin.listOnboardingEvaluationPackages({ tenantId, venueId }),
      caller.admin.getOnboardingMilestoneRollup({
        tenantId,
        venueId,
        from: metricsFrom.toISOString(),
        to: metricsTo.toISOString(),
      }),
    ])
    return (
      <EvaluationOperationsView
        tenantId={tenantId}
        venueId={venueId}
        runs={data.items}
        humanConclusions={data.humanConclusions}
        failedCases={data.failedCases}
        nextCursor={data.nextCursor}
        cases={cases.items}
        caseNextCursor={cases.nextCursor}
        runnerEnabled={cases.runnerEnabled}
        maximumCases={cases.maximumCases}
        requestPanelEnabled
        approvedPackages={approvedPackages}
        onboardingMetrics={onboardingMetrics}
      />
    )
  } catch {
    return (
      <section className="rounded-3xl border border-rose-200 bg-white p-8 shadow-sm" role="alert">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-rose-700">
          Evaluation operations
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
          Evidence could not be loaded
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-pf-deep/65">
          The stored evaluation evidence is unavailable right now. Refresh the page or return later.
          No evaluation was started and no data was changed.
        </p>
      </section>
    )
  }
}
