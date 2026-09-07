import { ApprovalDecisionForm } from '../../../components/admin/ApprovalDecisionForm'
import {
  AgentWorkflowActivationLedger,
  type AgentWorkflowActivationLedgerPage,
} from '../../../components/admin/AgentWorkflowActivationLedger'
import { TRPCProvider } from '../../../lib/trpc'

export const metadata = { title: 'Workflow ledger fixture | Torchiko' }

const initialPage: AgentWorkflowActivationLedgerPage = {
  heads: [
    {
      registryKey: 'visitor-arrival',
      revision: 7,
      selectedRunCount: 42,
      activeVersion: {
        id: '11111111-1111-4111-8111-111111111111',
        version: 3,
        contentHash: 'sha256:1bb965f6404f4b8eb724ef005283a792',
        requiredToolCapabilities: ['venue.read', 'visitor.chat.respond'],
      },
      activationEvent: {
        id: '22222222-2222-4222-8222-222222222222',
        kind: 'ACTIVATE',
        eventHash: 'sha256:activation-fixture',
        reason: 'Reviewed venue arrival flow.',
        createdBy: 'fixture-operator',
        createdAt: '2026-09-07T12:00:00.000Z',
        approvalDecisionId: null,
        promotionAssessmentId: null,
      },
    },
    {
      registryKey: 'legacy-recommendations',
      revision: 5,
      selectedRunCount: 12,
      activeVersion: null,
      activationEvent: {
        id: '33333333-3333-4333-8333-333333333333',
        kind: 'REVOKE',
        eventHash: 'sha256:revoke-fixture',
        reason: 'Superseded after operator review.',
        createdBy: 'fixture-operator',
        createdAt: '2026-09-06T12:00:00.000Z',
        approvalDecisionId: null,
        promotionAssessmentId: null,
      },
    },
  ],
  events: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      registryKey: 'visitor-arrival',
      kind: 'ACTIVATE',
      priorVersionId: '00000000-0000-4000-8000-000000000001',
      resultingVersionId: '11111111-1111-4111-8111-111111111111',
      priorRevision: 6,
      resultingRevision: 7,
      eventHash: 'sha256:activation-fixture',
      reason: 'Reviewed venue arrival flow.',
      createdBy: 'fixture-operator',
      createdAt: '2026-09-07T12:00:00.000Z',
      approvalDecisionId: null,
      promotionAssessmentId: null,
    },
  ],
  nextHeadAfterRegistryKey: null,
  nextEventBefore: null,
}

export default function AgentWorkflowLedgerFixturePage() {
  return (
    <TRPCProvider scopeKey="agent-workflow-ledger-fixture">
      <main className="min-h-screen bg-slate-100 p-4 sm:p-8">
        <div className="mx-auto max-w-5xl space-y-8">
          <AgentWorkflowActivationLedger
            tenantId="fixture-tenant"
            venueId="fixture-venue"
            initialPage={initialPage}
          />
          <section
            className="border-t border-pf-light pt-6"
            aria-labelledby="fixture-approval-heading"
          >
            <h2 id="fixture-approval-heading" className="text-xl font-semibold text-pf-deep">
              Existing approval decision form
            </h2>
            <p className="mt-1 text-sm text-pf-deep/75">
              Fixture-only visual check; submitting is outside this read-only ledger slice.
            </p>
            <div className="mt-4 max-w-xl rounded-2xl border border-pf-light bg-white p-4 sm:p-5">
              <ApprovalDecisionForm
                tenantId="fixture-tenant"
                venueId="fixture-venue"
                approvalRequestId="44444444-4444-4444-8444-444444444444"
                proposedAction="pathfinder.example_approval"
              />
            </div>
          </section>
        </div>
      </main>
    </TRPCProvider>
  )
}
