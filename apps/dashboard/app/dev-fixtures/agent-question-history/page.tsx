import { notFound } from 'next/navigation'

import { AgentOperationsOverview } from '../../../components/admin/AgentOperationsOverview'
import { TRPCProvider } from '../../../lib/trpc'

export const metadata = { title: 'Agent question history fixture' }

const fixtureEnabled =
  process.env.NODE_ENV === 'development' && process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED === '1'

const answeredAt = new Date('2026-09-08T17:00:00.000Z')

const questions = {
  items: [
    {
      id: 'fixture-answered-question',
      tenantId: 'fixture-history-tenant',
      venueId: 'fixture-history-venue',
      agentIdentityId: 'fixture-history-agent',
      agentRunId: 'fixture-history-run',
      question: 'Which entrance should visitors use after the east lobby opens?',
      context:
        'The reviewed visitor map has two entrances. This retained response documents the selected route for the associated workflow.',
      questionType: 'SHORT_TEXT',
      category: 'visitor-access',
      urgency: 'NORMAL',
      choices: [],
      dueAt: null,
      evidence: [],
      proposedAnswer: null,
      callbackMetadata: null,
      blocking: true,
      status: 'ANSWERED',
      answer: 'Use the east entrance after 9 a.m.; staff will direct accessible arrivals there.',
      answeredAt,
      createdAt: new Date('2026-09-08T16:00:00.000Z'),
      updatedAt: answeredAt,
      agentIdentity: { id: 'fixture-history-agent', name: 'Visitor guide' },
    },
  ],
  nextCursor: { createdAt: '2026-09-08T15:00:00.000Z', id: 'fixture-history-older-question' },
}

export default function AgentQuestionHistoryFixture() {
  if (!fixtureEnabled) notFound()
  return (
    <TRPCProvider scopeKey="agent-question-history-fixture">
      <main
        data-fixture="agent-question-history"
        className="min-h-screen bg-slate-100 px-3 py-6 text-slate-950 sm:px-6 lg:px-10"
      >
        <section className="mx-auto max-w-7xl rounded-2xl border border-amber-200 bg-amber-50/70 p-4 shadow-sm sm:p-6">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-800">
            Agent workspace · deterministic fixture
          </p>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            This browser fixture renders a synthetic saved question through the real workspace
            component. It demonstrates history layout only; it does not prove authentication,
            database persistence, answer approval, or worker execution.
          </p>
          <div className="mt-6">
            <AgentOperationsOverview
              tenantId="fixture-history-tenant"
              venueId="fixture-history-venue"
              identities={{ items: [], nextCursor: null }}
              runs={{ items: [], nextCursor: null }}
              approvals={{ items: [], nextCursor: null }}
              questions={questions as never}
              questionStatus="ANSWERED"
            />
          </div>
        </section>
      </main>
    </TRPCProvider>
  )
}
