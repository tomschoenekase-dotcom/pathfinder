import { notFound } from 'next/navigation'

import { AgentQuestionDiscussion } from '../../../components/admin/AgentQuestionDiscussion'
import { TRPCProvider } from '../../../lib/trpc'

export const metadata = { title: 'Founder question discussion fixture' }

const fixtureEnabled =
  process.env.NODE_ENV === 'development' && process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED === '1'

export default function FounderQuestionDiscussionFixture() {
  if (!fixtureEnabled) notFound()
  return (
    <TRPCProvider scopeKey="founder-question-discussion-fixture">
      <main
        data-fixture="founder-question-discussion"
        className="min-h-screen bg-slate-100 px-3 py-6 text-slate-950 sm:px-6 lg:px-10"
      >
        <section className="mx-auto max-w-3xl rounded-2xl border border-amber-200 bg-amber-50/70 p-4 shadow-sm sm:p-6">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-800">
            Founder discussion · deterministic fixture
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Question notes</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            This browser fixture uses a clearly labeled mocked transport. It demonstrates note
            review only; it does not prove database persistence, authentication, answer approval, or
            work resumption.
          </p>
          <AgentQuestionDiscussion
            tenantId="fixture-discussion-tenant"
            venueId="fixture-discussion-venue"
            questionId="fixture-discussion-question"
          />
        </section>
      </main>
    </TRPCProvider>
  )
}
