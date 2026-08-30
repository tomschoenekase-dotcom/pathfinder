'use client'

import {
  SemanticConflictQuestionAction,
  SemanticOperationalUpdateDraftAction,
  SemanticUpdatePreview,
  SemanticUpdateDraftAction,
  SemanticUpdatePreviewResult,
} from '../../../components/admin/SemanticUpdatePreview'
import { TRPCProvider } from '../../../lib/trpc'

export default function SemanticUpdatePreviewFixture() {
  return (
    <main className="min-h-screen bg-slate-100 p-4 sm:p-8">
      <div className="mx-auto max-w-4xl space-y-5">
        <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <p className="text-xs font-bold uppercase tracking-wider text-amber-800">Approved</p>
          <div className="mt-4 rounded-xl bg-sky-50 p-4">
            <p className="text-xs font-bold uppercase tracking-wider text-sky-900">
              Proposed change
            </p>
            <p className="mt-1 text-sm leading-6 text-slate-800">
              Correct the museum hours using reviewed venue evidence.
            </p>
          </div>
          <TRPCProvider scopeKey="semantic-update-preview-fixture">
            <SemanticUpdatePreview
              tenantId="fixture-tenant"
              venueId="fixture-venue"
              proposalId="11111111-1111-4111-8111-111111111111"
              proposalUpdatedAt="2026-08-25T13:00:00.000Z"
              hasTarget
            />
          </TRPCProvider>
        </article>
        <SemanticUpdatePreviewResult
          preview={{
            classification: 'CONFLICT',
            operationCount: 0,
            authority: 'PUBLIC_SECONDARY',
            confidence: 0.78,
            blockers: [
              {
                code: 'LOWER_AUTHORITY_CONFLICT',
                path: 'evidence',
                message:
                  'Lower-authority evidence cannot replace the current venue fact without clarification.',
              },
            ],
            questions: [
              {
                owner: 'VENUE_OPERATOR',
                prompt: 'Which hours information should visitors receive for “Museum hours”?',
                blockerCodes: ['LOWER_AUTHORITY_CONFLICT'],
              },
            ],
          }}
        />
        <section className="grid gap-5 lg:grid-cols-2" aria-label="Conflict question states">
          <article>
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Operator clarification required
            </p>
            <SemanticConflictQuestionAction
              creating={false}
              questionStatus={null}
              identities={[
                {
                  id: 'content-steward',
                  identityKey: 'content-steward',
                  name: 'Content Steward',
                },
              ]}
              selectedIdentityId="content-steward"
              onSelectIdentity={() => undefined}
              onCreate={() => undefined}
            />
          </article>
          <article>
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Guidance received
            </p>
            <SemanticConflictQuestionAction
              creating={false}
              questionStatus="ANSWERED"
              identities={[]}
              selectedIdentityId=""
              onSelectIdentity={() => undefined}
              onCreate={() => undefined}
            />
          </article>
        </section>
        <section className="grid gap-5 lg:grid-cols-2" aria-label="Approved draft handoff states">
          <article>
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Approved preview
            </p>
            <SemanticUpdatePreviewResult
              preview={{
                classification: 'CORRECTION',
                operationCount: 1,
                authority: 'OFFICIAL_VENUE_SOURCE',
                confidence: 0.96,
                blockers: [],
                questions: [],
              }}
            />
            <SemanticUpdateDraftAction
              tenantId="fixture-tenant"
              venueId="fixture-venue"
              creating={false}
              draft={null}
              onCreate={() => undefined}
            />
          </article>
          <article>
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Durable handoff complete
            </p>
            <SemanticUpdatePreviewResult
              preview={{
                classification: 'CORRECTION',
                operationCount: 1,
                authority: 'OFFICIAL_VENUE_SOURCE',
                confidence: 0.96,
                blockers: [],
                questions: [],
              }}
            />
            <SemanticUpdateDraftAction
              tenantId="fixture-tenant"
              venueId="fixture-venue"
              creating={false}
              draft={{ packageId: 'fixture-package', packageStatus: 'DRAFT', replayed: false }}
              onCreate={() => undefined}
            />
          </article>
          <article className="lg:col-span-2">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Temporal handoff complete
            </p>
            <SemanticUpdatePreviewResult
              preview={{
                classification: 'TEMPORAL',
                operationCount: 1,
                authority: 'VENUE_CONFIRMED',
                confidence: 0.98,
                blockers: [],
                questions: [],
              }}
            />
            <SemanticOperationalUpdateDraftAction
              creating={false}
              draft={{
                operationalUpdateId: 'fixture-operational-update',
                operationalUpdateStatus: 'DRAFT',
                replayed: false,
              }}
              onCreate={() => undefined}
            />
          </article>
        </section>
      </div>
    </main>
  )
}
