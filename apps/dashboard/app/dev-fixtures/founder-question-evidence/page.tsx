import { AgentQuestionEvidence } from '../../../components/admin/AgentQuestionEvidence'

export default function FounderQuestionEvidenceFixture() {
  return (
    <main
      data-fixture="founder-question-evidence"
      className="min-h-screen bg-slate-100 px-4 py-8 text-slate-950 sm:px-8"
    >
      <article className="mx-auto max-w-3xl rounded-2xl border border-amber-200 bg-white p-4 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-500">
          <span>Content reviewer</span>
          <span aria-hidden="true">·</span>
          <span>Blocking</span>
          <span aria-hidden="true">·</span>
          <span>High priority</span>
        </div>
        <h1 className="mt-3 text-xl font-semibold leading-7">
          Which operating hours should the venue guide use?
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          The public website and reviewed staff interview disagree. Confirm the intended public
          wording after reviewing the exact source references below.
        </p>
        <AgentQuestionEvidence
          evidence={[
            {
              label: 'Official hours page',
              reference: 'https://example.com/visit/hours',
              summary: 'The public page lists a 9 AM opening.',
            },
            {
              label: 'Reviewed staff answer',
              reference: 'intake-review:fixture-interview:venue.operations.hours',
              summary: 'Operations reported a 10 AM opening during the current season.',
            },
          ]}
          proposedAnswer={{ draft: 'Use 10 AM after amending the venue source', confidence: 0.72 }}
        />
        <label className="mt-4 block text-sm font-semibold text-slate-800">
          Founder answer
          <textarea
            className="mt-1 min-h-28 w-full rounded-xl border border-slate-300 p-3 font-normal outline-none focus:border-sky-600 focus:ring-2 focus:ring-sky-200"
            placeholder="Answer with the intended public wording"
          />
        </label>
        <button
          type="button"
          className="mt-3 min-h-11 rounded-xl bg-slate-950 px-5 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2"
        >
          Submit guidance
        </button>
      </article>
    </main>
  )
}
