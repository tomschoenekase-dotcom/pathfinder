import React from 'react'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

export type ActionClassTrustEvidenceResult = NonNullable<
  inferRouterOutputs<AppRouter>['admin']['attentionConsole']['agentTrustEvidence']['actionClassEvidence']
>

type Recommendation = ActionClassTrustEvidenceResult['groups'][number]['recommendation']

const recommendationCopy: Record<Recommendation, { label: string; next: string }> = {
  COLLECT_MORE_EVIDENCE: {
    label: 'Collect more evidence',
    next: 'Link reviewed quality outcomes to successful actions before considering a scoped trial.',
  },
  INSPECT_ADVERSE_EVIDENCE: {
    label: 'Inspect adverse evidence',
    next: 'Review the linked adverse outcomes and resolve their causes before any scoped trial.',
  },
  REVIEW_SCOPED_CANARY_EVIDENCE: {
    label: 'Review scoped canary evidence',
    next: 'A reviewer may inspect this exact action class for a separately authorized scoped trial.',
  },
}

function Identity({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-l-2 border-violet-200 pl-3">
      <dt className="text-[0.68rem] font-bold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 break-all font-mono text-xs font-semibold text-slate-900">{value}</dd>
    </div>
  )
}

export function ActionClassTrustEvidence({
  evidence,
}: {
  evidence?: ActionClassTrustEvidenceResult | null | undefined
}) {
  if (!evidence) return null
  const integrityItems = [
    ['Unlinked outcomes', evidence.unlinkedOutcomeIds],
    ['Scope mismatches', evidence.mismatchedOutcomeIds],
    ['Conflicting outcomes', evidence.conflictingOutcomeIds],
    ['Conflicting approvals', evidence.conflictingApprovalDecisionIds],
    ['Unmatched approvals', evidence.unmatchedApprovalDecisionIds],
  ] as const

  return (
    <section
      aria-labelledby="action-class-trust-heading"
      className="rounded-2xl border border-violet-200 bg-white p-5 shadow-sm"
    >
      <div className="max-w-4xl">
        <p className="text-xs font-bold uppercase tracking-wider text-violet-800">
          Action class evidence
        </p>
        <h2 id="action-class-trust-heading" className="mt-1 text-lg font-semibold text-slate-950">
          Trust evidence stays inside its exact operating scope
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-700">
          Successful execution and reviewed quality are counted separately. These recommendations do
          not change authority or reduce review requirements.
        </p>
      </div>

      {evidence.groups.length ? (
        <div className="mt-5 space-y-3">
          {evidence.groups.map((group) => {
            const recommendation = recommendationCopy[group.recommendation]
            return (
              <details
                key={group.key}
                className="group rounded-xl border border-slate-200 bg-slate-50 open:border-violet-200 open:bg-violet-50/30"
              >
                <summary className="cursor-pointer list-none px-4 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="break-all font-mono text-sm font-semibold text-slate-950">
                        {group.actionName}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-slate-600">
                        {group.evidence.linkedPositiveOutcomeCount} quality-linked positive ·{' '}
                        {group.successfulActionsWithoutQualityCount} execution-only success
                      </p>
                    </div>
                    <span className="shrink-0 text-xs font-bold text-violet-800">
                      Evidence details
                    </span>
                  </div>
                </summary>

                <div className="border-t border-violet-100 px-4 pb-4 pt-4">
                  <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Identity label="Tenant" value={group.tenantId} />
                    <Identity label="Venue" value={group.venueId ?? 'No venue attached'} />
                    <Identity label="Agent" value={group.agentIdentityId} />
                    <Identity label="Action" value={group.actionName} />
                  </dl>

                  <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-y border-slate-200 py-4 text-sm sm:grid-cols-4 lg:grid-cols-6">
                    <div>
                      <dt className="text-xs font-semibold text-slate-500">
                        Successful executions
                      </dt>
                      <dd className="mt-1 text-xl font-semibold text-slate-950">
                        {group.evidence.successfulActionCount}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold text-slate-500">
                        Quality-linked positives
                      </dt>
                      <dd className="mt-1 text-xl font-semibold text-emerald-800">
                        {group.evidence.linkedPositiveOutcomeCount}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold text-slate-500">Execution only</dt>
                      <dd className="mt-1 text-xl font-semibold text-amber-800">
                        {group.successfulActionsWithoutQualityCount}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold text-slate-500">Adverse evidence</dt>
                      <dd className="mt-1 text-xl font-semibold text-rose-800">
                        {group.evidence.linkedAdverseOutcomeCount}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold text-slate-500">Failed / denied</dt>
                      <dd className="mt-1 text-xl font-semibold text-rose-800">
                        {group.evidence.failedActionCount} / {group.evidence.deniedActionCount}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold text-slate-500">Cancelled executions</dt>
                      <dd className="mt-1 text-xl font-semibold text-slate-950">
                        {group.evidence.cancelledActionCount}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold text-slate-500">Uncertain quality</dt>
                      <dd className="mt-1 text-xl font-semibold text-amber-800">
                        {group.evidence.uncertainOutcomeCount}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold text-slate-500">Rejected approvals</dt>
                      <dd className="mt-1 text-xl font-semibold text-rose-800">
                        {group.evidence.rejectedApprovalDecisionCount}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold text-slate-500">
                        Expired / cancelled approvals
                      </dt>
                      <dd className="mt-1 text-xl font-semibold text-amber-800">
                        {group.evidence.uncertainApprovalDecisionCount}
                      </dd>
                    </div>
                  </dl>

                  <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(16rem,0.7fr)]">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-wide text-violet-800">
                        Recommendation
                      </p>
                      <p className="mt-1 font-semibold text-slate-950">{recommendation.label}</p>
                      <p className="mt-1 text-sm leading-6 text-slate-700">{recommendation.next}</p>
                    </div>
                    <div className="border-l-2 border-slate-200 pl-3 text-xs leading-5 text-slate-600">
                      {group.incomplete ? 'This action-class sample is incomplete. ' : ''}
                      {group.linkedAdverseOutcomeIds.length
                        ? `${group.linkedAdverseOutcomeIds.length} linked adverse outcome${group.linkedAdverseOutcomeIds.length === 1 ? ' requires' : 's require'} review. `
                        : 'No linked adverse outcome appears in this bounded sample. '}
                      {group.evidence.approvalDecisionCount} approval decisions are visible;{' '}
                      {group.evidence.approvedApprovalDecisionCount} were approved.
                    </div>
                  </div>

                  <details className="mt-4 border-t border-slate-200 pt-3">
                    <summary className="cursor-pointer text-xs font-bold text-violet-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2">
                      Source record IDs
                    </summary>
                    <div className="mt-2 grid gap-3 sm:grid-cols-3">
                      {[
                        ['Actions', group.actionIds],
                        ['Linked outcomes', group.linkedOutcomeIds],
                        ['Approvals', group.approvalDecisionIds],
                      ].map(([label, ids]) => (
                        <div key={label as string} className="min-w-0">
                          <p className="text-xs font-semibold text-slate-500">{label}</p>
                          <ul className="mt-1 space-y-1">
                            {(ids as string[]).map((id) => (
                              <li key={id} className="break-all font-mono text-xs text-slate-700">
                                {id}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </details>
                </div>
              </details>
            )
          })}
        </div>
      ) : (
        <p className="mt-4 border-l-2 border-slate-300 pl-3 text-sm text-slate-600">
          No action-class evidence is available in this bounded result.
        </p>
      )}

      {integrityItems.some(([, ids]) => ids.length > 0) ? (
        <div className="mt-4 border-t border-slate-200 pt-4">
          <h3 className="text-sm font-semibold text-slate-900">Evidence integrity exceptions</h3>
          <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {integrityItems.map(([label, ids]) => (
              <div key={label} className="min-w-0">
                <p className="text-xs font-semibold text-slate-500">
                  {label}: {ids.length}
                </p>
                {ids.length ? (
                  <ul className="mt-1 space-y-1">
                    {ids.map((id) => (
                      <li key={id} className="break-all font-mono text-xs text-slate-700">
                        {id}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <p className="mt-4 text-xs leading-5 text-slate-600">
        Loaded sample: {evidence.incomplete ? 'incomplete' : 'complete'}. A denied action records
        enforcement and is not itself a policy violation. Recommendation only; no reliability score
        or authority change is inferred.
      </p>
    </section>
  )
}
