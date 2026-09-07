import { ApprovalDecisionForm } from '../../../components/admin/ApprovalDecisionForm'
import {
  AgentWorkflowActivationReviewPanel,
  type AgentWorkflowActivationReviewPage,
} from '../../../components/admin/AgentWorkflowActivationReviewPanel'
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
const reviewedCanaryPolicy = {
  numerator: 1,
  denominator: 10,
  maxSelectedRuns: 25,
  salt: 'fixture-visible-selection-salt-with-a-long-reviewable-value-1234567890',
  startsAt: '2026-09-08T14:00:00.000Z',
  endsAt: '2026-09-15T14:00:00.000Z',
  eligibleRunTypes: ['QUALITY_REVIEW'],
  eligibleOperations: ['operator_task'],
  supportedActionClasses: ['RUN_TERMINAL_WRITE'],
  skippedBaseline: {
    kind: 'PRIOR_VERSION',
    workflowVersionId: '00000000-0000-4000-8000-000000000001',
    contentHash: 'f'.repeat(64),
  },
}
const reviewPage = {
  candidates: [
    {
      version: {
        id: '11111111-1111-4111-8111-111111111111',
        registryKey: 'visitor-arrival',
        version: 4,
        kind: 'WORKFLOW',
        status: 'REGISTERED_UNACTIVATED',
        manifestHash: 'a'.repeat(64),
        contentHash: 'b'.repeat(64),
        requiredToolCapabilities: [],
        createdByType: 'HUMAN',
        createdById: 'fixture-operator',
        createdAt: '2026-09-07T12:00:00Z',
        artifactIntegrity: 'NOT_CHECKED_BODY_ON_APPLY',
      },
      compatibility: { status: 'CURRENTLY_AVAILABLE', missingCapabilities: [] },
      assessment: {
        id: 'assessment-fixture',
        outcome: 'EVIDENCE_READY_REVIEW_REQUIRED',
        assessmentHash: 'c'.repeat(64),
        diagnosticsShapeValid: true,
        diagnostics: {
          contractVersion: 1,
          interpretation: 'evidence-only-no-activation',
          development: {
            validationId: 'dev',
            caseCount: 12,
            resolvedFailures: 3,
            newFailures: 0,
            missingResults: 0,
            caseIdentityHash: 'd'.repeat(64),
            latencyDeltaMs: null,
            costDeltaE8Usd: null,
          },
          heldout: {
            validationId: 'held',
            caseCount: 8,
            resolvedFailures: 2,
            newFailures: 0,
            missingResults: 0,
            caseIdentityHash: 'e'.repeat(64),
            latencyDeltaMs: null,
            costDeltaE8Usd: null,
          },
          disjointCaseSets: true,
          targetImprovementObserved: true,
          thresholdResolution: 'UNRESOLVED',
          autonomousPromotionEligible: false,
          limitations: ['Human review and Apply are required.'],
        },
        createdAt: '2026-09-07T12:00:00Z',
        applicability: 'HISTORICAL_EVIDENCE_APPLY_REVALIDATES',
      },
    },
  ],
  nextCandidateBefore: null,
  enabledIdentities: [
    { id: 'identity-fixture', identityKey: 'quality-review', name: 'Quality reviewer' },
  ],
  identitiesTruncated: false,
  approvalRequests: [
    {
      id: 'approval-ready',
      agentIdentityId: 'identity-fixture',
      requestedByType: 'HUMAN',
      requestedById: 'fixture-requester',
      proposedAction: 'agent-workflow.activate',
      reason: 'Reviewed the bounded visitor-arrival canary and its heldout evidence.',
      riskCategory: 'HIGH',
      expiresAt: null,
      createdAt: '2026-09-07T12:10:00Z',
      receiptShapeValid: true,
      receipt: {
        registryKey: 'visitor-arrival',
        workflowVersionId: '11111111-1111-4111-8111-111111111111',
        promotionAssessmentId: 'assessment-fixture',
        expectedHeadRevision: 7,
        canaryPolicy: reviewedCanaryPolicy,
        evidenceDigest: '9'.repeat(64),
      },
      decision: {
        id: 'decision-ready',
        decision: 'APPROVED',
        decidedByType: 'HUMAN',
        decidedById: 'fixture-reviewer',
        reason: 'Evidence and bounded canary reviewed.',
        createdAt: '2026-09-07T12:20:00Z',
      },
      reviewedApplyInput: {
        approvalDecisionId: 'decision-ready',
        receipt: {
          registryKey: 'visitor-arrival',
          workflowVersionId: '11111111-1111-4111-8111-111111111111',
          promotionAssessmentId: 'assessment-fixture',
          expectedHeadRevision: 7,
          canaryPolicy: reviewedCanaryPolicy,
          evidenceDigest: '9'.repeat(64),
        },
      },
      appliedEventCorrelation: 'NONE',
      appliedEvent: null,
    },
    {
      id: 'approval-applied',
      agentIdentityId: 'identity-fixture',
      requestedByType: 'HUMAN',
      requestedById: 'fixture-requester',
      proposedAction: 'agent-workflow.activate',
      reason: 'Earlier reviewed visitor workflow rollout.',
      riskCategory: 'HIGH',
      expiresAt: null,
      createdAt: '2026-09-06T12:10:00Z',
      receiptShapeValid: true,
      receipt: {
        registryKey: 'visitor-arrival',
        workflowVersionId: '11111111-1111-4111-8111-111111111111',
        promotionAssessmentId: 'assessment-fixture',
        expectedHeadRevision: 6,
        canaryPolicy: reviewedCanaryPolicy,
        evidenceDigest: '8'.repeat(64),
      },
      decision: {
        id: 'decision-applied',
        decision: 'APPROVED',
        decidedByType: 'HUMAN',
        decidedById: 'fixture-reviewer',
        reason: 'Approved.',
        createdAt: '2026-09-06T12:20:00Z',
      },
      reviewedApplyInput: null,
      appliedEventCorrelation: 'APPLIED',
      appliedEvent: { resultingRevision: 7 },
    },
  ],
  nextRequestBefore: null,
  heads: [
    {
      registryKey: 'visitor-arrival',
      revision: 7,
      activeVersionId: '00000000-0000-4000-8000-000000000001',
      activationEventId: 'event-old',
      activeVersion: {
        id: '00000000-0000-4000-8000-000000000001',
        version: 3,
        contentHash: 'f'.repeat(64),
      },
    },
  ],
} as unknown as AgentWorkflowActivationReviewPage

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
          <AgentWorkflowActivationReviewPanel
            tenantId="fixture-tenant"
            venueId="fixture-venue"
            initialPage={reviewPage}
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
