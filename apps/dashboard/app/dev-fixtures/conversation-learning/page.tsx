'use client'

import { useEffect, useRef, useState } from 'react'

import { ConversationLearningProposalDraft } from '../../../components/admin/ConversationLearningProposalDraft'
import {
  ConversationLearningReview,
  type ConversationLearningCandidate,
} from '../../../components/admin/ConversationLearningReview'
import { TRPCProvider } from '../../../lib/trpc'

const fixtureEnabled = process.env.NODE_ENV === 'development'

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

const scopedMessages = [
  {
    id: 'fixture-message-visitor',
    scope: 'fixture-tenant / fixture-venue',
    body: 'Visitors sometimes call the model railway “the train over the river.”',
  },
  {
    id: 'fixture-message-guide',
    scope: 'fixture-tenant / fixture-venue',
    body: 'The alternate name still needs confirmation against a reviewed venue source.',
  },
]

export default function ConversationLearningFixture() {
  const attempts = useRef(0)
  const [hydrated, setHydrated] = useState(false)
  const [recordedDraft, setRecordedDraft] = useState<{
    status: 'DRAFT'
    proposedChange: string
    reason: string
  } | null>(null)
  useEffect(() => setHydrated(true), [])
  if (!fixtureEnabled) return null

  async function createDraft(input: { proposedChange: string; reason: string }) {
    attempts.current += 1
    await new Promise((resolve) => window.setTimeout(resolve, 200))
    if (attempts.current === 1) throw new Error('Synthetic first-attempt failure')
    setRecordedDraft({ status: 'DRAFT', ...input })
  }

  return (
    <TRPCProvider scopeKey="conversation-learning-fixture">
      <main
        data-fixture="conversation-learning"
        data-hydrated={hydrated}
        className="min-h-screen bg-slate-100 px-3 py-6 text-slate-950 sm:px-6 lg:px-10"
      >
        <div className="mx-auto max-w-6xl">
          <ConversationLearningReview
            policy="VISITOR_AND_EMPLOYEE"
            candidates={candidates}
            onPolicyChange={async () => undefined}
            onReview={async () => undefined}
          />
          <section
            aria-labelledby="proposal-draft-fixture-heading"
            className="mt-8 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"
          >
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-sky-800">
              Accepted, still unverified
            </p>
            <h2
              id="proposal-draft-fixture-heading"
              className="mt-2 text-xl font-semibold text-slate-950"
            >
              Scoped proposal handoff
            </h2>
            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
              <h3 className="text-sm font-semibold text-slate-900">Scoped source messages</h3>
              <ul className="mt-2 space-y-2 text-sm leading-6 text-slate-700">
                {scopedMessages.map((message) => (
                  <li key={message.id}>
                    <span className="font-semibold text-slate-900">{message.scope}:</span>{' '}
                    {message.body}
                  </li>
                ))}
              </ul>
            </div>
            <ConversationLearningProposalDraft candidate={candidates[1]!} onCreate={createDraft} />
            {recordedDraft ? (
              <div
                data-testid="recorded-proposal-draft"
                className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm leading-6 text-emerald-950"
              >
                <p className="font-semibold">Recorded status: {recordedDraft.status}</p>
                <p>Proposed change: {recordedDraft.proposedChange}</p>
                <p>Reason: {recordedDraft.reason}</p>
                <p>No approval or guide publication occurred.</p>
              </div>
            ) : null}
          </section>
        </div>
      </main>
    </TRPCProvider>
  )
}
