import { FounderQuestionTriageBoard } from '../../../components/admin/FounderQuestionTriageBoard'
import { TRPCProvider } from '../../../lib/trpc'

export const metadata = { title: 'Founder question triage fixture' }

const questions = {
  items: [
    {
      id: 'fixture-foundational-identity',
      tenantId: 'fixture-tenant',
      venueId: 'fixture-venue',
      agentRunId: 'fixture-run-identity',
      question: 'Which building does the uploaded handbook describe?',
      context:
        'The cover page names the North Campus while the footer names the South Campus. Venue identity affects every extracted claim, so this question blocks the linked review.',
      questionType: 'MULTIPLE_CHOICE',
      category: 'builder-file-clarification',
      urgency: 'HIGH',
      choices: ['North Campus', 'South Campus'],
      dueAt: new Date('2026-08-30T17:00:00.000Z'),
      evidence: [
        {
          label: 'Handbook cover',
          reference: 'intake-receipt:fixture:page-1',
          summary: 'The title names North Campus.',
        },
        {
          label: 'Handbook footer',
          reference: 'intake-receipt:fixture:page-14',
          summary: 'The footer names South Campus.',
        },
      ],
      proposedAnswer: { interpretation: 'Treat the document as North Campus', confidence: 0.58 },
      blocking: true,
      createdAt: new Date('2026-08-29T07:00:00.000Z'),
      updatedAt: new Date('2026-08-29T07:00:00.000Z'),
      agentIdentity: { name: 'Source analyst' },
      agentRun: {
        id: 'fixture-run-identity',
        status: 'AWAITING_INPUT',
        requestedOperation: 'document-identity-review',
      },
    },
    {
      id: 'fixture-local-hours',
      tenantId: 'fixture-tenant',
      venueId: 'fixture-venue',
      agentRunId: 'fixture-run-hours',
      question: 'Are the holiday café hours still current?',
      context:
        'A dated holiday notice conflicts with the year-round handbook. Exclude that one claim while unrelated venue knowledge continues.',
      questionType: 'YES_NO',
      category: 'builder-file-clarification',
      urgency: 'NORMAL',
      choices: ['Yes', 'No'],
      dueAt: null,
      evidence: [
        {
          label: 'Holiday notice excerpt',
          reference: 'intake-receipt:fixture:holiday-hours',
          summary: 'Lists a temporary 4 PM café closing time.',
        },
      ],
      proposedAnswer: { interpretation: 'Exclude the temporary closing time until confirmed' },
      blocking: false,
      createdAt: new Date('2026-08-29T08:30:00.000Z'),
      updatedAt: new Date('2026-08-29T08:30:00.000Z'),
      agentIdentity: { name: 'Venue Builder' },
      agentRun: {
        id: 'fixture-run-hours',
        status: 'AWAITING_INPUT',
        requestedOperation: 'visitor-knowledge-build',
      },
    },
    {
      id: 'fixture-local-alias',
      tenantId: 'fixture-tenant',
      venueId: 'fixture-venue',
      agentRunId: 'fixture-run-alias',
      question: 'Should “River Room” be retained as a public alias?',
      context:
        'Two reviewed sources use the older room name. This affects search aliases only and does not block the rest of the venue model.',
      questionType: 'YES_NO',
      category: 'entity-reconciliation',
      urgency: 'LOW',
      choices: ['Retain alias', 'Do not retain'],
      dueAt: null,
      evidence: [],
      proposedAnswer: { interpretation: 'Retain as a historical alias' },
      blocking: false,
      createdAt: new Date('2026-08-27T15:00:00.000Z'),
      updatedAt: new Date('2026-08-27T15:00:00.000Z'),
      agentIdentity: { name: 'Reconciler' },
      agentRun: {
        id: 'fixture-run-alias',
        status: 'AWAITING_INPUT',
        requestedOperation: 'entity-reconciliation',
      },
    },
  ],
  nextCursor: { createdAt: '2026-08-27T15:00:00.000Z', id: 'fixture-local-alias' },
}

export default function FounderQuestionTriageFixture() {
  return (
    <TRPCProvider scopeKey="founder-question-triage-fixture">
      <main
        data-fixture="founder-question-triage"
        className="min-h-screen bg-slate-100 px-3 py-6 text-slate-950 sm:px-6 lg:px-10"
      >
        <section className="mx-auto max-w-6xl rounded-2xl border border-amber-200 bg-amber-50/70 p-4 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-800">
                Founder decisions · deterministic fixture
              </p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight">Needs you</h1>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
                Resolve concise evidence-backed questions without confusing guidance with approval,
                application, or publication.
              </p>
            </div>
            <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-900">
              3 waiting
            </span>
          </div>
          <FounderQuestionTriageBoard
            questions={questions as never}
            generatedAt={new Date('2026-08-29T12:00:00.000Z')}
          />
        </section>
      </main>
    </TRPCProvider>
  )
}
