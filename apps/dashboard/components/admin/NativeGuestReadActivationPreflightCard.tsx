import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

type Preflight = inferRouterOutputs<AppRouter>['admin']['getNativeGuestReadActivationPreflight']

function label(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function state(ok: boolean): string {
  return ok ? 'Pass' : 'Blocked'
}

export function NativeGuestReadActivationPreflightCard({
  preflight,
}: {
  preflight: Preflight | null
}) {
  if (!preflight)
    return (
      <section
        aria-labelledby="native-read-preflight-heading"
        className="rounded-2xl border border-amber-200 bg-amber-50 p-5"
      >
        <h3 id="native-read-preflight-heading" className="font-semibold text-amber-950">
          Guest read activation preflight unavailable
        </h3>
        <p className="mt-1 text-sm leading-6 text-amber-900">
          Exact gate evidence could not be loaded. Compatibility reads remain the safe assumption;
          no state was changed.
        </p>
      </section>
    )

  const { activation, convergence } = preflight
  const technicalSummary = !preflight.alignment.materializedStateInSync
    ? 'Materialized compatibility state does not match the exact native head. Review drift before rollout.'
    : activation.nativeExecutionReady
      ? 'All observed technical gates pass for configured ACTIVE mode.'
      : activation.path === 'DARK'
        ? 'All observed technical gates pass; DARK mode keeps compatibility output.'
        : 'Compatibility reads remain in effect because one or more observed gates are closed.'

  return (
    <section
      aria-labelledby="native-read-preflight-heading"
      className="rounded-2xl border border-pf-light bg-white p-5"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-pf-primary">
            Read-only evidence
          </p>
          <h3 id="native-read-preflight-heading" className="mt-1 font-semibold text-pf-deep">
            Guest read activation preflight
          </h3>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-pf-deep/75">{technicalSummary}</p>
        </div>
        <span className="w-fit rounded-full bg-pf-surface px-3 py-1 text-xs font-semibold text-pf-deep">
          {label(activation.path)} path
        </span>
      </div>

      <dl className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-xl bg-pf-surface p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-pf-deep/70">
            Server gate
          </dt>
          <dd className="mt-1 text-sm font-semibold text-pf-deep">
            {state(activation.runtime.serverGateEnabled)}
          </dd>
        </div>
        <div className="rounded-xl bg-pf-surface p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-pf-deep/70">
            Venue policy
          </dt>
          <dd className="mt-1 text-sm font-semibold text-pf-deep">
            {activation.policy.valid && activation.policy.enabled
              ? `${activation.policy.mode} · Pass`
              : 'Blocked'}
          </dd>
        </div>
        <div className="rounded-xl bg-pf-surface p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-pf-deep/70">
            Exact native head
          </dt>
          <dd className="mt-1 text-sm font-semibold text-pf-deep">
            {state(activation.head.valid && activation.head.targetMatches === true)}
          </dd>
        </div>
        <div className="rounded-xl bg-pf-surface p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-pf-deep/70">
            Passing evaluation
          </dt>
          <dd className="mt-1 text-sm font-semibold text-pf-deep">
            {state(activation.evaluation.valid)}
          </dd>
        </div>
        <div className="rounded-xl bg-pf-surface p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-pf-deep/70">
            Materialized state
          </dt>
          <dd className="mt-1 text-sm font-semibold text-pf-deep">{label(convergence.phase)}</dd>
        </div>
        <div className="rounded-xl bg-pf-surface p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-pf-deep/70">
            Production approval reference
          </dt>
          <dd className="mt-1 text-sm font-semibold text-pf-deep">
            {activation.policy.productionApprovalReferencePresent ? 'Present' : 'Not present'}
          </dd>
        </div>
      </dl>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-pf-light p-3">
          <h4 className="text-sm font-semibold text-pf-deep">Activation blockers</h4>
          {activation.blockers.length ? (
            <ul className="mt-2 space-y-1 text-sm text-pf-deep/75">
              {activation.blockers.map((blocker: string) => (
                <li key={blocker}>• {label(blocker)}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-pf-deep/75">
              No technical activation blocker observed.
            </p>
          )}
        </div>
        <div className="rounded-xl border border-pf-light p-3">
          <h4 className="text-sm font-semibold text-pf-deep">Convergence blockers</h4>
          {convergence.blockers.length ? (
            <ul className="mt-2 space-y-1 text-sm text-pf-deep/75">
              {convergence.blockers.map((blocker: string) => (
                <li key={blocker}>• {label(blocker)}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-pf-deep/75">No convergence blocker observed.</p>
          )}
        </div>
      </div>

      <p className="mt-4 rounded-xl border border-violet-200 bg-violet-50 p-3 text-sm leading-6 text-violet-950">
        This assessment cannot activate a feature, infer a quality threshold, approve production, or
        retire compatibility data. Reference presence is not policy approval.
      </p>
    </section>
  )
}
