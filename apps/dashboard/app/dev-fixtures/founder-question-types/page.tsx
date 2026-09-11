import { notFound } from 'next/navigation'

import { AgentQuestionAnswerForm } from '../../../components/admin/AgentQuestionAnswerForm'
import { TRPCProvider } from '../../../lib/trpc'

export const metadata = { title: 'Founder question type fixture' }

const fixtureEnabled =
  process.env.NODE_ENV === 'development' && process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED === '1'

export default function FounderQuestionTypesFixture() {
  if (!fixtureEnabled) notFound()
  const common = {
    tenantId: 'fixture-tenant',
    venueId: 'fixture-venue',
    expectedUpdatedAt: new Date('2026-09-08T12:00:00.000Z'),
    recipients: [],
    canRouteToClient: false,
  }
  return (
    <TRPCProvider scopeKey="founder-question-types-fixture">
      <main
        data-fixture="founder-question-types"
        className="min-h-screen bg-slate-100 px-3 py-6 text-slate-950 sm:px-6 lg:px-10"
      >
        <section className="mx-auto max-w-5xl rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-sky-800">
            Founder input · deterministic fixture
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Compact question controls</h1>
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <article className="rounded-2xl border border-sky-100 bg-sky-50/40 p-4">
              <h2 className="font-semibold">Which access features are confirmed?</h2>
              <AgentQuestionAnswerForm
                {...common}
                questionId="fixture-multi-select"
                questionType="MULTI_SELECT"
                choices={[
                  'Step-free greenhouse entrance',
                  'Large-print visitor guide',
                  'Quiet seating area',
                ]}
              />
            </article>
            <article className="rounded-2xl border border-amber-100 bg-amber-50/40 p-4">
              <h2 className="font-semibold">Recommend this proposed interpretation?</h2>
              <AgentQuestionAnswerForm
                {...common}
                questionId="fixture-approval-reject"
                questionType="APPROVAL_REJECT"
                choices={['Recommend approval', 'Recommend rejection']}
              />
            </article>
          </div>
        </section>
      </main>
    </TRPCProvider>
  )
}
