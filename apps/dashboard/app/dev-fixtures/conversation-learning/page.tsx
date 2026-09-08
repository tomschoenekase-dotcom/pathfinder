'use client'

import {
  ConversationLearningReview,
  type ConversationLearningCandidate,
} from '../../../components/admin/ConversationLearningReview'
import { TRPCProvider } from '../../../lib/trpc'

const fixtureEnabled =
  process.env.NODE_ENV === 'development' && process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED === '1'

const candidates: ConversationLearningCandidate[] = [
  {
    id: 'fixture-location',
    summary: 'A conversation message may contain a location or wayfinding fact.',
    sourceHref: '/admin/clients/fixture-tenant/venues/fixture-venue/chatlogs/fixture-session',
    reviewStatus: 'UNREVIEWED',
    candidateRevision: 4,
    reviewerFeedback: null,
    candidateProvenance: {
      source: 'PUBLIC',
      kind: 'LOCATION',
      verification: 'UNVERIFIED',
      hedged: false,
    },
  },
  {
    id: 'fixture-alias',
    summary: 'A conversation message may provide an alternate name for a venue item.',
    reviewStatus: 'ACKNOWLEDGED',
    candidateRevision: 2,
    reviewerFeedback: 'Needs a second source before proposal.',
    candidateProvenance: {
      source: 'SECOND_LAYER',
      kind: 'ALIAS',
      verification: 'UNVERIFIED',
      hedged: true,
    },
  },
  {
    id: 'fixture-temporary',
    summary: 'A conversation message may contain a temporary venue status update.',
    reviewStatus: 'UNREVIEWED',
    candidateRevision: 1,
    reviewerFeedback: null,
    candidateProvenance: {
      source: 'PUBLIC',
      kind: 'TEMPORARY_UPDATE',
      verification: 'UNVERIFIED',
      hedged: true,
    },
  },
]

export default function ConversationLearningFixture() {
  if (!fixtureEnabled) return null
  return (
    <TRPCProvider scopeKey="conversation-learning-fixture">
      <main
        data-fixture="conversation-learning"
        className="min-h-screen bg-slate-100 px-3 py-6 text-slate-950 sm:px-6 lg:px-10"
      >
        <div className="mx-auto max-w-6xl">
          <ConversationLearningReview
            policy="VISITOR_AND_EMPLOYEE"
            candidates={candidates}
            onPolicyChange={async () => undefined}
            onReview={async () => undefined}
          />
        </div>
      </main>
    </TRPCProvider>
  )
}
