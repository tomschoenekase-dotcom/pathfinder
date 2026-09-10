'use client'

import { SupportCompletionApprovalContext } from '../../../components/admin/SupportCompletionApprovalContext'
import { SupportCompletionOutcome } from '../../../components/SupportCompletionOutcome'
import { SupportManualLoopActions } from '../../../components/admin/SupportManualLoopActions'
import { TRPCProvider } from '../../../lib/trpc'

const outcomes = [
  ['UPDATED', 'The reviewed visitor hours were applied. The retained explanation remains exact.'],
  ['NO_CHANGE', 'The reviewed guidance already matched the request. No wording was changed.'],
  ['MIXED', 'One update was applied and one reviewed item required no change.'],
  ['RESOLVED', 'The question was answered without a content or package update.'],
] as const

export function SupportCompletionOutcomeFixtureClient() {
  return (
    <TRPCProvider scopeKey="support-completion-outcome-fixture">
      <main className="min-h-screen bg-pf-cream px-4 py-8 text-pf-deep sm:px-8">
        <div className="mx-auto max-w-5xl space-y-8">
          <header className="border-b border-pf-light pb-5">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
              Support completion
            </p>
            <h1 className="mt-2 text-3xl font-semibold">Review the recorded outcome</h1>
          </header>
          <section aria-labelledby="completion-review-heading">
            <h2 id="completion-review-heading" className="mb-4 text-xl font-semibold">
              Review and complete
            </h2>
            <SupportManualLoopActions
              tenantId="fixture-completion-tenant"
              venueId="fixture-completion-venue"
              requestId="11111111-1111-4111-8111-111111111111"
              expectedVersion={7}
              currentStatus="IN_REVIEW"
              missingInformation={[]}
            />
          </section>
          <section aria-labelledby="founder-outcome-heading">
            <h2 id="founder-outcome-heading" className="text-xl font-semibold">
              Founder approval context
            </h2>
            <SupportCompletionApprovalContext
              proposal={{
                completionOutcome: 'NO_CHANGE',
                body:
                  'The existing gallery guidance already matches the reviewed request. Keep the approved explanation intact.\nReference: ' +
                  'gallery-reference-'.repeat(14),
              }}
            />
          </section>
          <section aria-labelledby="outcome-message-heading" className="space-y-4">
            <h2 id="outcome-message-heading" className="text-xl font-semibold">
              Client-visible completion messages
            </h2>
            {outcomes.map(([outcome, body]) => (
              <article key={outcome} className="border-t border-pf-light pt-4">
                <SupportCompletionOutcome outcome={outcome} className="text-pf-primary" />
                <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{body}</p>
              </article>
            ))}
          </section>
        </div>
      </main>
    </TRPCProvider>
  )
}
