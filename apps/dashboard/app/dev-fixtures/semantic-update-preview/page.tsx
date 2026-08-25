import {
  SemanticUpdatePreview,
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
      </div>
    </main>
  )
}
