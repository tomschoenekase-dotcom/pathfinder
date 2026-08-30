import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

import { NativeReleaseEvaluationPanel } from './NativeReleaseEvaluationPanel'
import { NativeContentShadowComparisonPanel } from './NativeContentShadowComparisonPanel'
import { NativeVenueDeploymentLifecycleControls } from './NativeVenueDeploymentLifecycleControls'

type NativeRelease = inferRouterOutputs<AppRouter>['admin']['getNativeVenueDeployment']

function label(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function NativeVenueDeploymentDetail({
  tenantId,
  venueId,
  release,
}: {
  tenantId: string
  venueId: string
  release: NativeRelease
}) {
  return (
    <div className="space-y-4">
      <dl className="grid gap-3 rounded-2xl border border-pf-light bg-white p-5 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wider text-pf-deep/70">Status</dt>
          <dd className="mt-1 font-semibold text-pf-deep">{label(release.status)}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wider text-pf-deep/70">
            Materialization profile
          </dt>
          <dd className="mt-1 font-semibold text-pf-deep">{release.profile}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wider text-pf-deep/70">
            Updated
          </dt>
          <dd className="mt-1 text-sm text-pf-deep">
            {new Date(release.updatedAt).toLocaleString()}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wider text-pf-deep/70">
            Commands recorded
          </dt>
          <dd className="mt-1 text-sm text-pf-deep">{release.commandCount}</dd>
        </div>
      </dl>

      <section
        aria-labelledby="native-coverage-heading"
        className="rounded-2xl border border-pf-light bg-white p-5"
      >
        <h4 id="native-coverage-heading" className="font-semibold text-pf-deep">
          Native coverage
        </h4>
        <p className="mt-1 text-sm text-pf-deep/70">
          Empty-only sections are supported only when the manifest declares no entries.
        </p>
        <dl className="mt-4 grid gap-2 sm:grid-cols-2">
          {release.coverage.map((entry) => (
            <div key={entry.section} className="rounded-xl bg-pf-surface p-3">
              <dt className="text-xs font-semibold uppercase tracking-wide text-pf-deep/70">
                {label(entry.section)}
              </dt>
              <dd className="mt-1 text-sm font-semibold text-pf-deep">
                {label(entry.disposition)}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section
        aria-labelledby="native-impact-heading"
        className="rounded-2xl border border-pf-light bg-white p-5"
      >
        <h4 id="native-impact-heading" className="font-semibold text-pf-deep">
          Planned impact and recorded effects
        </h4>
        <p className="mt-2 text-sm text-pf-deep/75">
          {release.effectSummary.expected} expected effects · {release.effectSummary.recorded}{' '}
          recorded effects
        </p>
        {release.impactSummary.length ? (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {release.impactSummary.map((item) => (
              <li key={item.kind} className="rounded-xl bg-pf-surface p-3 text-sm text-pf-deep">
                <span className="font-semibold">{label(item.kind)}</span>: {item.count}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-pf-deep/70">No state changes are planned.</p>
        )}
      </section>

      <section
        aria-labelledby="native-issues-heading"
        className="rounded-2xl border border-pf-light bg-white p-5"
      >
        <h4 id="native-issues-heading" className="font-semibold text-pf-deep">
          Review issues
        </h4>
        <p className="mt-2 text-sm text-pf-deep/75">
          {release.issueCount === 0
            ? 'No native release issues were recorded.'
            : `${release.issueCount} bounded review issue${release.issueCount === 1 ? '' : 's'} recorded.`}
        </p>
      </section>

      <NativeReleaseEvaluationPanel
        tenantId={tenantId}
        venueId={venueId}
        releaseId={release.id}
        releaseVersion={release.version}
        releaseStatus={release.status}
        runner={release.evaluationRunner}
        initialEvidence={release.evaluationEvidence}
      />

      <NativeContentShadowComparisonPanel
        tenantId={tenantId}
        venueId={venueId}
        releaseId={release.id}
      />

      {!release.materializable || release.unsupported ? (
        <div role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <h4 className="font-semibold text-amber-950">Native release is not actionable</h4>
          <p className="mt-1 text-sm text-amber-900">
            This release contains unsupported materialization evidence. Approval, apply, and revert
            remain unavailable.
          </p>
        </div>
      ) : (
        <NativeVenueDeploymentLifecycleControls
          tenantId={tenantId}
          venueId={venueId}
          initialRelease={release}
        />
      )}
    </div>
  )
}
