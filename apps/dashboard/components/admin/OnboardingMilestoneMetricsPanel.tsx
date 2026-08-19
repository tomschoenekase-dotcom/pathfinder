import React from 'react'
import type { OnboardingMilestoneRollup } from '@pathfinder/contracts'

function duration(value: number | null) {
  if (value === null) return 'Not observed'
  if (value < 60_000) return `${Math.round(value / 1000)} sec`
  if (value < 3_600_000) return `${Math.round(value / 60_000)} min`
  return `${(value / 3_600_000).toFixed(1)} hr`
}

function percentage(value: number | null) {
  return value === null ? 'Not observed' : `${Math.round(value * 100)}%`
}

export function OnboardingMilestoneMetricsPanel({ rollup }: { rollup: OnboardingMilestoneRollup }) {
  return (
    <section
      className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm sm:p-6"
      aria-labelledby="onboarding-milestone-metrics-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
            Durable onboarding metrics
          </p>
          <h3
            id="onboarding-milestone-metrics-title"
            className="mt-2 text-lg font-semibold text-pf-deep"
          >
            Last 90 days
          </h3>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-pf-deep/65">
            Derived only from append-only workflow events. “Not observed” means the denominator is
            missing; it is never displayed as a zero.
          </p>
        </div>
        {rollup.window.truncated ? (
          <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900">
            Latest {rollup.window.eventLimit} events only
          </span>
        ) : null}
      </div>

      <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['First useful material', duration(rollup.timeToFirstUsefulMaterial.valueMs)],
          ['Reviewable package', duration(rollup.timeToReviewablePackage.valueMs)],
          ['Question response', duration(rollup.clientQuestionResponse.averageMs)],
          ['Upload failure rate', percentage(rollup.uploadFailureRate.rate)],
          ['Processing failure rate', percentage(rollup.processingFailureRate.rate)],
          ['Human interventions', String(rollup.humanInterventions.value)],
          ['Post-launch gaps', String(rollup.postLaunchMissingKnowledge.value)],
          ['Observed events', String(rollup.window.observedEvents)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-pf-light bg-pf-cream/30 px-3 py-3">
            <dt className="text-[0.65rem] font-bold uppercase tracking-[0.12em] text-pf-deep/55">
              {label}
            </dt>
            <dd className="mt-1 text-xl font-semibold text-pf-deep">{value}</dd>
          </div>
        ))}
      </dl>

      <details className="mt-4 rounded-xl border border-pf-light px-4 py-3 text-sm text-pf-deep/70">
        <summary className="cursor-pointer font-semibold text-pf-deep">Metric definitions</summary>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <li>{rollup.timeToFirstUsefulMaterial.denominatorDefinition}</li>
          <li>{rollup.clientQuestionResponse.responseRate.denominatorDefinition}</li>
          <li>{rollup.uploadFailureRate.denominatorDefinition}</li>
          <li>{rollup.processingFailureRate.denominatorDefinition}</li>
        </ul>
      </details>
    </section>
  )
}
