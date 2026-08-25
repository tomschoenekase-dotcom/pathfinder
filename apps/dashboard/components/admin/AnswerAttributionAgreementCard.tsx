export type AnswerAttributionAgreementData = {
  reportHash: string
  invalidRecordCount: number
  truncated: boolean
  report: {
    inputRecordCount: number
    selectedRecordCount: number
    turnCount: number
    comparableGroupCount: number
    independentPairCount: number
    distinctReviewerCount: number
    exclusions: {
      repeatedReviewerRecordCount: number
      singleReviewerGroupCount: number
      identityConflictTurnCount: number
    }
    metrics: {
      coverageOverlapRate: number | null
      supportAgreementRate: number | null
      sourceAgreementRate: number | null
    }
  }
}

function rate(value: number | null): string {
  return value === null ? 'Not comparable' : `${Math.round(value * 100)}%`
}

function AgreementMetric({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-2xl border border-pf-light bg-white px-4 py-3">
      <dt className="text-xs font-bold uppercase tracking-[0.12em] text-pf-deep/75">{label}</dt>
      <dd className="mt-1 text-xl font-semibold text-pf-deep">{rate(value)}</dd>
    </div>
  )
}

export function AnswerAttributionAgreementCard({
  data,
}: {
  data: AnswerAttributionAgreementData | null
}) {
  if (!data) {
    return (
      <section className="rounded-3xl border border-amber-200 bg-amber-50 p-5" role="status">
        <h3 className="font-semibold text-amber-950">Claim-review calibration unavailable</h3>
        <p className="mt-1 text-sm leading-6 text-amber-900/80">
          Stored evaluation evidence remains available, but reviewer-agreement evidence could not be
          computed. No quality or release conclusion was inferred.
        </p>
      </section>
    )
  }

  const { report } = data
  const warnings =
    data.invalidRecordCount + report.exclusions.identityConflictTurnCount > 0 || data.truncated
  return (
    <section
      className="rounded-3xl border border-pf-light bg-pf-cream/35 p-5 shadow-sm sm:p-6"
      aria-labelledby="answer-attribution-agreement-heading"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
            Human calibration
          </p>
          <h3
            id="answer-attribution-agreement-heading"
            className="mt-1 text-xl font-semibold text-pf-deep"
          >
            Claim-review agreement
          </h3>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/65">
            Independent reviewers are compared character by character, so different claim
            segmentation does not hide agreement or disagreement. These measurements do not prove
            correctness and no pass threshold is applied.
          </p>
        </div>
        <span className="w-fit rounded-full bg-sky-100 px-3 py-1 text-xs font-semibold text-sky-900">
          Descriptive evidence only
        </span>
      </div>

      {report.independentPairCount === 0 ? (
        <div className="mt-5 rounded-2xl border border-dashed border-pf-light bg-white p-5">
          <p className="font-semibold text-pf-deep">Calibration is not yet comparable</p>
          <p className="mt-1 text-sm leading-6 text-pf-deep/65">
            At least two different human reviewers must annotate the same frozen answer and evidence
            set. No provider call or automatic review was started.
          </p>
        </div>
      ) : (
        <>
          <dl className="mt-5 grid gap-3 sm:grid-cols-3">
            <AgreementMetric
              label="Claim coverage overlap"
              value={report.metrics.coverageOverlapRate}
            />
            <AgreementMetric
              label="Support-label agreement"
              value={report.metrics.supportAgreementRate}
            />
            <AgreementMetric
              label="Supported-source agreement"
              value={report.metrics.sourceAgreementRate}
            />
          </dl>
          <p className="mt-4 text-sm text-pf-deep/65">
            {report.independentPairCount} independent reviewer pair
            {report.independentPairCount === 1 ? '' : 's'} across {report.comparableGroupCount}{' '}
            comparable frozen answer {report.comparableGroupCount === 1 ? 'identity' : 'identities'}
            .
          </p>
        </>
      )}

      {warnings ? (
        <div
          className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3"
          role="alert"
        >
          <p className="font-semibold text-amber-950">Calibration evidence needs inspection</p>
          <p className="mt-1 text-sm leading-6 text-amber-900/80">
            {data.invalidRecordCount} malformed record{data.invalidRecordCount === 1 ? '' : 's'},{' '}
            {report.exclusions.identityConflictTurnCount} answer-identity conflict
            {report.exclusions.identityConflictTurnCount === 1 ? '' : 's'}
            {data.truncated ? ', and the bounded record window was truncated' : ''}. Excluded
            evidence does not contribute to the displayed rates.
          </p>
        </div>
      ) : null}

      <p className="mt-4 break-all font-mono text-xs text-pf-deep/75">Report {data.reportHash}</p>
    </section>
  )
}
