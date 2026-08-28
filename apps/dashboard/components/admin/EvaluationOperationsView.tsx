import Link from 'next/link'
import { EvaluationRunRequestPanel, type EvaluationCaseListItem } from './EvaluationRunRequestPanel'
import { EvaluationRunLifecycleControl } from './EvaluationRunLifecycleControl'
import { EvaluationComparisonPanel } from './EvaluationComparisonPanel'
import { EvaluationRuntimeGateControl } from './EvaluationRuntimeGateControl'
import { OnboardingEvaluationSuitePanel } from './OnboardingEvaluationSuitePanel'
import { OnboardingMilestoneMetricsPanel } from './OnboardingMilestoneMetricsPanel'
import {
  ConversationEvaluationCasePanel,
  type EvaluationSourceInsight,
} from './ConversationEvaluationCasePanel'
import type { OnboardingMilestoneRollup } from '@pathfinder/contracts'
import {
  AnswerAttributionAgreementCard,
  type AnswerAttributionAgreementData,
} from './AnswerAttributionAgreementCard'
import {
  GuestAnswerEvaluationPanel,
  type GuestAnswerEvaluationRequest,
} from './GuestAnswerEvaluationPanel'

type EvaluationSummary = {
  resultCount: number
  quality: { scored: number; passed: number; failed: number }
  operational: { failures: number; deferred: number; budgetBlocked: number; cancelled: number }
}

type EvaluationRun = {
  id: string
  identityHash: string
  corpusHash: string
  promptContractVersion: string
  promptContractHash: string
  packageSnapshotRef: string | null
  packageSnapshotHash: string | null
  contentSnapshotVersion: bigint
  contentSnapshotHash: string
  modelProvider: string
  modelName: string
  modelSnapshotHash: string
  triggerType: string
  status:
    | 'LEGACY'
    | 'STAGED'
    | 'QUEUED'
    | 'RETRY_SCHEDULED'
    | 'RUNNING'
    | 'COMPLETED'
    | 'FAILED'
    | 'CANCELLED'
  attemptNumber: number
  maxAttempts: number | null
  startedAt: Date | null
  completedAt: Date | null
  cancellationRequestedAt: Date | null
  lastErrorCode: string | null
  createdAt: Date
  summary: EvaluationSummary
}

type HumanConclusion = {
  id: string
  reviewerId: string
  conclusion: string
  decision: string
  rubricVersion: string
  revision: number
  createdAt: Date
  result: {
    runId: string
    caseRevision: number
    evalCase: { caseKey: string; category: string }
  }
}

type FailedCase = {
  id: string
  runId: string
  caseId: string
  caseKey: string
  category: string
  caseRevision: number
  passedChecks: number | null
  totalChecks: number | null
  checks: { checkId: string; passed: boolean; detail: string }[]
}

type EvaluationOperationsViewProps = {
  tenantId: string
  venueId: string
  runs: EvaluationRun[]
  humanConclusions: HumanConclusion[]
  nextCursor: { createdAt: string; id: string } | null
  cases?: EvaluationCaseListItem[]
  caseNextCursor?: { createdAt: string; id: string } | null
  runnerEnabled?: boolean
  runnerReadiness?: {
    apiProcessEnabled: boolean
    durableGlobalEnabled: boolean
    tenantEnabled: boolean
  }
  regressionAlerts?: {
    configured: boolean
    minimumPassRateDrop: number | null
    errorPassRateDrop: number | null
  }
  maximumCases?: number
  maximumBudgetE8Usd?: string
  evaluationModelBudgetCeilingsE8Usd?: Record<'guest-chat' | 'guest-chat-openai', string>
  requestPanelEnabled?: boolean
  reviewablePackages?: {
    id: string
    status: 'DRAFT' | 'APPROVED'
    payloadHash: string
    baseDigest: string
    createdAt: Date
    approvedAt: Date | null
    supportHandoffs: { supportRequestId: string; requestVersion: number }[]
  }[]
  failedCases?: FailedCase[]
  onboardingMetrics?: OnboardingMilestoneRollup
  sourceInsights?: EvaluationSourceInsight[]
  attributionAgreement?: AnswerAttributionAgreementData | null
  answerEvaluationRequests?: GuestAnswerEvaluationRequest[]
  answerEvaluationReadiness?: {
    processEnabled: boolean
    durableGlobalEnabled: boolean
    tenantEnabled: boolean
  }
  answerEvaluationExecutionEnabled?: boolean
}

function shortHash(value: string | null) {
  return value ? value.slice(0, 12) : 'Not captured'
}

function operationalTotal(summary: EvaluationSummary) {
  return (
    summary.operational.failures +
    summary.operational.deferred +
    summary.operational.budgetBlocked +
    summary.operational.cancelled
  )
}

function RunStatus({ summary }: { summary: EvaluationSummary }) {
  const operations = operationalTotal(summary)
  if (summary.resultCount === 0) {
    return (
      <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
        No terminal results
      </span>
    )
  }
  if (operations > 0) {
    return (
      <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900">
        Operationally incomplete
      </span>
    )
  }
  if (summary.quality.failed > 0) {
    return (
      <span className="rounded-full bg-rose-100 px-3 py-1 text-xs font-semibold text-rose-900">
        Quality needs attention
      </span>
    )
  }
  return (
    <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-900">
      Quality checks passed
    </span>
  )
}

function Metric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: number
  tone?: 'neutral' | 'good' | 'bad'
}) {
  const color =
    tone === 'good' ? 'text-emerald-800' : tone === 'bad' ? 'text-rose-800' : 'text-pf-deep'
  return (
    <div className="rounded-xl border border-pf-light bg-white px-3 py-2">
      <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] text-pf-deep/55">
        {label}
      </p>
      <p className={`mt-1 text-xl font-semibold ${color}`}>{value}</p>
    </div>
  )
}

export function EvaluationOperationsView({
  tenantId,
  venueId,
  runs,
  humanConclusions,
  nextCursor,
  cases = [],
  caseNextCursor = null,
  runnerEnabled = false,
  runnerReadiness,
  regressionAlerts,
  maximumCases = 50,
  maximumBudgetE8Usd = '410000000',
  evaluationModelBudgetCeilingsE8Usd = {
    'guest-chat': '20256000',
    'guest-chat-openai': '5102400',
  },
  requestPanelEnabled = false,
  reviewablePackages = [],
  failedCases = [],
  onboardingMetrics,
  sourceInsights = [],
  attributionAgreement,
  answerEvaluationRequests,
  answerEvaluationReadiness,
  answerEvaluationExecutionEnabled = false,
}: EvaluationOperationsViewProps) {
  return (
    <div className="space-y-8">
      <header className="border-b border-pf-light pb-6">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Evaluation operations
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
          Quality evidence
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/65">
          Evidence from evaluation work. Quality failures describe scored answer behavior;
          operational failures mean a case did not receive a quality judgment.
        </p>
        <div className="mt-4 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950">
          This console can request or safely cancel a bounded run only when execution is explicitly
          enabled. It cannot approve, publish, or change content.
        </div>
      </header>

      {attributionAgreement !== undefined ? (
        <AnswerAttributionAgreementCard data={attributionAgreement} />
      ) : null}

      {answerEvaluationRequests && answerEvaluationReadiness ? (
        <GuestAnswerEvaluationPanel
          tenantId={tenantId}
          venueId={venueId}
          requests={answerEvaluationRequests}
          readiness={answerEvaluationReadiness}
          executionEnabled={answerEvaluationExecutionEnabled}
        />
      ) : null}

      {onboardingMetrics ? <OnboardingMilestoneMetricsPanel rollup={onboardingMetrics} /> : null}

      {requestPanelEnabled && runnerReadiness ? (
        <EvaluationRuntimeGateControl
          tenantId={tenantId}
          venueId={venueId}
          readiness={runnerReadiness}
        />
      ) : null}

      {requestPanelEnabled ? (
        <>
          <OnboardingEvaluationSuitePanel
            tenantId={tenantId}
            venueId={venueId}
            reviewablePackages={reviewablePackages}
          />
          <ConversationEvaluationCasePanel
            tenantId={tenantId}
            venueId={venueId}
            insights={sourceInsights}
          />
          <EvaluationRunRequestPanel
            tenantId={tenantId}
            venueId={venueId}
            initialCases={cases}
            initialNextCursor={caseNextCursor}
            runnerEnabled={runnerEnabled}
            {...(regressionAlerts ? { regressionAlerts } : {})}
            maximumCases={maximumCases}
            maximumBudgetE8Usd={maximumBudgetE8Usd}
            evaluationModelBudgetCeilingsE8Usd={evaluationModelBudgetCeilingsE8Usd}
            reviewablePackages={reviewablePackages}
          />
        </>
      ) : null}

      {runs.length === 0 ? (
        <section className="rounded-3xl border border-dashed border-pf-light bg-white p-10 text-center">
          <h3 className="text-lg font-semibold text-pf-deep">No evaluation runs recorded</h3>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-pf-deep/65">
            There is no persisted evaluation evidence for this venue yet. No evaluation was started
            by opening this page.
          </p>
        </section>
      ) : (
        <section className="space-y-4" aria-label="Evaluation runs">
          {runs.map((run) => {
            const operational = operationalTotal(run.summary)
            const runFailures = failedCases.filter((failure) => failure.runId === run.id)
            return (
              <article
                key={run.id}
                className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm sm:p-6"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="font-mono text-xs text-pf-deep/60">Run {run.id}</p>
                    <h3 className="mt-1 text-lg font-semibold text-pf-deep">
                      {run.modelProvider} / {run.modelName}
                    </h3>
                    <p className="mt-1 text-xs text-pf-deep/55">
                      {run.triggerType.replace(/_/g, ' ')} · {run.createdAt.toLocaleString()}
                    </p>
                  </div>
                  <div className="flex flex-col items-start gap-2 sm:items-end">
                    <RunStatus summary={run.summary} />
                    <EvaluationRunLifecycleControl
                      tenantId={tenantId}
                      venueId={venueId}
                      runId={run.id}
                      status={run.status}
                      cancellationRequestedAt={run.cancellationRequestedAt}
                    />
                  </div>
                </div>

                <div className="mt-5 grid gap-4 lg:grid-cols-2">
                  <section
                    className="rounded-2xl border border-pf-light bg-pf-surface/50 p-4"
                    aria-label="Quality results"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <h4 className="font-semibold text-pf-deep">Scored quality</h4>
                      <span className="text-xs text-pf-deep/60">
                        {run.summary.quality.scored} judged
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <Metric label="Passed" value={run.summary.quality.passed} tone="good" />
                      <Metric label="Failed" value={run.summary.quality.failed} tone="bad" />
                    </div>
                  </section>
                  <section
                    className="rounded-2xl border border-pf-light bg-pf-surface/50 p-4"
                    aria-label="Operational outcomes"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <h4 className="font-semibold text-pf-deep">Operational outcomes</h4>
                      <span className="text-xs text-pf-deep/60">{operational} not scored</span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
                      <Metric label="Failures" value={run.summary.operational.failures} />
                      <Metric label="Deferred" value={run.summary.operational.deferred} />
                      <Metric label="Budget" value={run.summary.operational.budgetBlocked} />
                      <Metric label="Cancelled" value={run.summary.operational.cancelled} />
                    </div>
                  </section>
                </div>

                {runFailures.length > 0 ? (
                  <section
                    className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 p-4"
                    aria-label={`Failed cases for run ${run.id}`}
                  >
                    <h4 className="font-semibold text-rose-950">Exact failed cases</h4>
                    <p className="mt-1 text-sm text-rose-900">
                      Record any repair as a new package revision, approve it separately, prepare
                      its seven-case suite, and retest that exact package. Reviewed packages are
                      never edited in place.
                    </p>
                    <ul className="mt-3 space-y-3">
                      {runFailures.map((failure) => (
                        <li
                          key={failure.id}
                          className="rounded-xl border border-rose-200 bg-white p-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-semibold text-pf-deep">{failure.caseKey}</span>
                            <span className="text-xs text-pf-deep/60">
                              {failure.category} · revision {failure.caseRevision} ·{' '}
                              {failure.passedChecks ?? 0}/{failure.totalChecks ?? 0} checks
                            </span>
                          </div>
                          <ul className="mt-2 space-y-1 text-xs text-pf-deep/70">
                            {failure.checks
                              .filter((check) => !check.passed)
                              .map((check) => (
                                <li key={check.checkId}>
                                  {check.checkId}: {check.detail}
                                </li>
                              ))}
                          </ul>
                        </li>
                      ))}
                    </ul>
                    <Link
                      href={`/admin/clients/${tenantId}/venues/${venueId}/packages`}
                      className="mt-3 inline-flex min-h-11 items-center font-semibold text-pf-primary underline"
                    >
                      Open versioned package repairs
                    </Link>
                  </section>
                ) : null}

                <details className="mt-5 rounded-2xl border border-pf-light px-4 py-3">
                  <summary className="cursor-pointer text-sm font-semibold text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent">
                    Frozen run identity
                  </summary>
                  <dl className="mt-4 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
                    {[
                      ['Run identity', shortHash(run.identityHash)],
                      ['Corpus', shortHash(run.corpusHash)],
                      [
                        'Prompt contract',
                        `${run.promptContractVersion} · ${shortHash(run.promptContractHash)}`,
                      ],
                      [
                        'Content snapshot',
                        `${run.contentSnapshotVersion.toString()} · ${shortHash(run.contentSnapshotHash)}`,
                      ],
                      [
                        'Package snapshot',
                        run.packageSnapshotRef
                          ? `${run.packageSnapshotRef} · ${shortHash(run.packageSnapshotHash)}`
                          : 'Not captured',
                      ],
                      ['Model snapshot', shortHash(run.modelSnapshotHash)],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt className="font-semibold text-pf-deep/60">{label}</dt>
                        <dd className="mt-1 break-all font-mono text-pf-deep">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              </article>
            )
          })}
        </section>
      )}

      <EvaluationComparisonPanel tenantId={tenantId} venueId={venueId} runs={runs} />

      <section
        className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm sm:p-6"
        aria-labelledby="human-conclusions-heading"
      >
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-pf-primary">
            Human layer
          </p>
          <h3 id="human-conclusions-heading" className="mt-1 text-xl font-semibold text-pf-deep">
            Recent conclusions
          </h3>
        </div>
        {humanConclusions.length === 0 ? (
          <p className="mt-4 rounded-2xl bg-pf-surface px-4 py-5 text-sm text-pf-deep/65">
            No human conclusions are recorded for the runs on this page.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-pf-light">
            {humanConclusions.map((review) => (
              <li key={review.id} className="py-4 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-800">
                    {review.decision.replace(/_/g, ' ')}
                  </span>
                  <span className="font-medium text-pf-deep/65">
                    {review.result.evalCase.caseKey} · revision {review.result.caseRevision}
                  </span>
                  <span className="text-pf-deep/55">{review.result.evalCase.category}</span>
                </div>
                <p className="mt-2 text-sm leading-6 text-pf-deep">{review.conclusion}</p>
                <p className="mt-2 text-xs text-pf-deep/55">
                  Rubric {review.rubricVersion} · review revision {review.revision} ·{' '}
                  {review.createdAt.toLocaleString()}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {nextCursor ? (
        <div className="flex justify-end">
          <Link
            href={`/admin/clients/${tenantId}/venues/${venueId}/evaluations?cursorCreatedAt=${encodeURIComponent(nextCursor.createdAt)}&cursorId=${encodeURIComponent(nextCursor.id)}`}
            className="inline-flex min-h-11 items-center rounded-2xl border border-pf-light bg-white px-5 text-sm font-semibold text-pf-primary transition hover:border-pf-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
          >
            Older runs
          </Link>
        </div>
      ) : null}
    </div>
  )
}
