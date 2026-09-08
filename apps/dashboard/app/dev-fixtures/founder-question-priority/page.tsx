import { notFound } from 'next/navigation'
import type { ComponentProps } from 'react'

import { FounderQuestionTriageBoard } from '../../../components/admin/FounderQuestionTriageBoard'
import { TRPCProvider } from '../../../lib/trpc'

export const metadata = { title: 'Founder question priority fixture' }

const fixtureEnabled =
  process.env.NODE_ENV === 'development' && process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED === '1'

const generatedAt = new Date('2026-09-08T12:00:00.000Z')

const common = {
  tenantId: 'fixture-priority-tenant',
  venueId: 'fixture-priority-venue',
  venue: { name: 'Priority fixture venue' },
  questionType: 'YES_NO' as const,
  category: 'operational-clarification',
  choices: ['Confirm', 'Keep pending'],
  evidence: [],
  proposedAnswer: null,
  expiresAt: null,
  updatedAt: generatedAt,
  agentIdentity: { name: 'Operations analyst' },
}

const questions: ComponentProps<typeof FounderQuestionTriageBoard>['questions'] = {
  items: [
    {
      ...common,
      id: 'fixture-urgent-local',
      agentRunId: 'fixture-urgent-run',
      agentRun: {
        id: 'fixture-urgent-run',
        status: 'AWAITING_INPUT',
        requestedOperation: 'venue-operations-review',
      },
      question: 'Urgent: confirm whether the east arrival route is safe for visitors today.',
      context:
        'This is an unverified operational clarification. It is visible for founder review and remains answerable; it has no automated operational effect.',
      urgency: 'URGENT',
      blocking: false,
      dueAt: generatedAt,
      createdAt: new Date('2026-09-08T08:30:00.000Z'),
    },
    {
      ...common,
      id: 'fixture-high-blocking-a',
      agentRunId: 'fixture-high-a-run',
      agentRun: {
        id: 'fixture-high-a-run',
        status: 'AWAITING_INPUT',
        requestedOperation: 'venue-operations-review',
      },
      question: 'Which named gallery does the reviewed brochure describe?',
      context: 'This blocks one source-reconciliation workflow only.',
      urgency: 'HIGH',
      blocking: true,
      dueAt: new Date('2026-09-08T11:59:59.999Z'),
      createdAt: new Date('2026-09-08T08:00:00.000Z'),
    },
    {
      ...common,
      id: 'fixture-normal-blocking',
      agentRunId: 'fixture-normal-run',
      agentRun: {
        id: 'fixture-normal-run',
        status: 'AWAITING_INPUT',
        requestedOperation: 'venue-operations-review',
      },
      question: 'Should the temporary café notice remain in the draft?',
      context: 'This blocks a draft review but does not change public information.',
      urgency: 'NORMAL',
      blocking: true,
      dueAt: new Date('2026-09-08T13:00:00.000Z'),
      createdAt: new Date('2026-09-08T07:45:00.000Z'),
    },
    {
      ...common,
      id: 'fixture-low-blocking',
      agentRunId: 'fixture-low-run',
      agentRun: {
        id: 'fixture-low-run',
        status: 'AWAITING_INPUT',
        requestedOperation: 'venue-operations-review',
      },
      question: 'Is the historical room alias still useful for internal search?',
      context: 'This blocks an optional alias-reconciliation workflow only.',
      urgency: 'LOW',
      blocking: true,
      dueAt: null,
      createdAt: new Date('2026-09-08T07:30:00.000Z'),
    },
  ],
  nextCursor: null,
}

export default function FounderQuestionPriorityFixture() {
  if (!fixtureEnabled) notFound()
  return (
    <TRPCProvider scopeKey="founder-question-priority-fixture">
      <main
        data-fixture="founder-question-priority"
        className="min-h-screen bg-slate-100 px-3 py-6 text-slate-950 sm:px-6 lg:px-10"
      >
        <section className="mx-auto max-w-6xl rounded-2xl border border-amber-200 bg-amber-50/70 p-4 shadow-sm sm:p-6">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-800">
            Founder decisions · deterministic fixture
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Priority questions</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            Urgent questions lead this review queue. A due date marks a requested decision time; it
            does not expire the question or change its authority.
          </p>
          <FounderQuestionTriageBoard questions={questions} generatedAt={generatedAt} />
        </section>
      </main>
    </TRPCProvider>
  )
}
