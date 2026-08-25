import {
  IntakeBuilderLifecycleView,
  type IntakeBuilderLifecycle,
} from '../../../components/admin/IntakeBuilderLifecyclePanel'

const stages = [
  'INGEST',
  'NORMALIZE',
  'ANALYZE',
  'RESEARCH',
  'EXTRACT',
  'CONSTRUCT',
  'RECONCILE',
  'CLARIFY',
  'VALIDATE',
  'SIMULATE',
  'QA',
  'REVIEW',
  'READY',
  'PUBLISH',
] as const

const lifecycle: IntakeBuilderLifecycle = {
  schemaVersion: 1,
  runId: 'fixture-run',
  runStatus: 'AWAITING_REVIEW',
  currentStage: 'RESEARCH',
  currentState: 'BLOCKED',
  nextAction: 'CONFIGURE_RESEARCH_ADAPTER',
  requiresHumanApproval: false,
  autoApprove: false,
  autoApply: false,
  autoPublish: false,
  stages: stages.map((stage, index) => ({
    stage,
    state:
      index < 3
        ? ('COMPLETE' as const)
        : stage === 'RESEARCH'
          ? ('BLOCKED' as const)
          : ('PENDING' as const),
    evidenceRefs: index < 3 ? ['intake-run:fixture-run'] : [],
    blockers:
      stage === 'RESEARCH'
        ? [
            {
              code: 'RESEARCH_ADAPTER_REQUIRED',
              path: 'sourceKind',
              message: 'No reviewed website research result is linked to this intake run.',
            },
          ]
        : [],
  })),
}

export default function IntakeBuilderLifecycleFixture() {
  return (
    <main className="min-h-screen bg-pf-surface p-4 sm:p-8">
      <div className="mx-auto max-w-5xl rounded-2xl border border-pf-light bg-white p-4 sm:p-6">
        <p className="text-sm font-medium text-pf-deep">Website proposal · awaiting review</p>
        <p className="mt-1 text-sm text-pf-deep/70">1 evidence record · no package draft</p>
        <IntakeBuilderLifecycleView lifecycle={lifecycle} />
      </div>
    </main>
  )
}
