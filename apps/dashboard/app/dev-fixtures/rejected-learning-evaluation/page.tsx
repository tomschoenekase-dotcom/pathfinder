import { notFound } from 'next/navigation'

import { ConversationEvaluationCasePanel } from '../../../components/admin/ConversationEvaluationCasePanel'
import { TRPCProvider } from '../../../lib/trpc'

export default async function RejectedLearningEvaluationFixture({
  searchParams,
}: {
  searchParams: Promise<{ empty?: string }>
}) {
  if (process.env.NODE_ENV !== 'development') notFound()
  const { empty } = await searchParams
  return (
    <main
      className="min-h-screen bg-pf-cream px-4 py-6 sm:px-6"
      data-fixture="rejected-learning-evaluation"
    >
      <div className="mx-auto max-w-5xl">
        <h1 className="mb-2 text-2xl font-semibold text-pf-deep">
          Learning review to regression case
        </h1>
        <p className="mb-6 text-sm text-pf-deep/70">
          Fictional review data. Saving is intercepted in browser proof; no provider runs.
        </p>
        <TRPCProvider scopeKey="fixture:rejected-learning-evaluation">
          <ConversationEvaluationCasePanel
            tenantId="fixture-tenant"
            venueId="fixture-venue"
            insights={[]}
            rejectedCandidates={
              empty
                ? []
                : [
                    {
                      id: '11111111-1111-4111-8111-111111111111',
                      category: 'CONTENT_UPDATE_CANDIDATE',
                      summary:
                        'A visitor suggested that the two displays marked Case 12 are the same exhibit.',
                      reviewerFeedback:
                        'The ground-floor and upstairs displays are distinct. Ask which floor the visitor is on before identifying Case 12. Do not merge their exhibit records.',
                      candidateRevision: 3,
                      reviewedAt: new Date('2026-09-08T16:00:00Z'),
                    },
                  ]
            }
          />
        </TRPCProvider>
      </div>
    </main>
  )
}
