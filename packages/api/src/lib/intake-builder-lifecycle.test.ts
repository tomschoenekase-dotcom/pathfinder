import { describe, expect, it } from 'vitest'

import { INTAKE_BUILDER_STAGES, projectIntakeBuilderLifecycle } from './intake-builder-lifecycle'

const base = {
  runId: 'run-a',
  sourceKind: 'INTERVIEW',
  runStatus: 'AWAITING_REVIEW',
  evidenceCount: 2,
  candidate: {
    ready: true,
    candidateHash: 'a'.repeat(64),
    candidateCount: 2,
    issues: [],
  },
  packageDraft: null,
} as const

describe('intake Builder lifecycle projection', () => {
  it('exposes the full ordered lifecycle and stops at durable package construction', () => {
    const result = projectIntakeBuilderLifecycle(base)
    expect(result.stages.map(({ stage }) => stage)).toEqual(INTAKE_BUILDER_STAGES)
    expect(result).toMatchObject({
      currentStage: 'CONSTRUCT',
      currentState: 'CURRENT',
      nextAction: 'CREATE_PACKAGE_DRAFT',
      requiresHumanApproval: false,
      autoPublish: false,
    })
    expect(result.stages.find(({ stage }) => stage === 'RESEARCH')).toMatchObject({
      state: 'SKIPPED',
    })
  })

  it('turns candidate discrepancies into a visible clarification blocker', () => {
    const result = projectIntakeBuilderLifecycle({
      ...base,
      candidate: {
        ...base.candidate,
        ready: false,
        issues: [{ code: 'INTERVIEW_DISCREPANCY', path: 'hours', message: 'Hours conflict.' }],
      },
    })
    expect(result).toMatchObject({
      currentStage: 'RECONCILE',
      currentState: 'BLOCKED',
      nextAction: 'RESOLVE_CLARIFICATION',
    })
    expect(result.stages.find(({ stage }) => stage === 'CLARIFY')).toMatchObject({
      state: 'BLOCKED',
      blockers: [expect.objectContaining({ code: 'INTERVIEW_DISCREPANCY' })],
    })
  })

  it('fails a not-ready candidate closed when upstream omitted issue details', () => {
    const result = projectIntakeBuilderLifecycle({
      ...base,
      candidate: { ...base.candidate, ready: false, issues: [] },
    })
    expect(result.stages.find(({ stage }) => stage === 'RECONCILE')).toMatchObject({
      state: 'BLOCKED',
      blockers: [expect.objectContaining({ code: 'CANDIDATE_NOT_READY' })],
    })
  })

  it('fails website research closed instead of implying extraction occurred', () => {
    const result = projectIntakeBuilderLifecycle({
      ...base,
      sourceKind: 'WEBSITE',
      candidate: null,
    })
    expect(result).toMatchObject({
      currentStage: 'RESEARCH',
      currentState: 'BLOCKED',
      nextAction: 'CONFIGURE_RESEARCH_ADAPTER',
    })
    expect(result.stages.find(({ stage }) => stage === 'EXTRACT')).toMatchObject({
      state: 'PENDING',
    })
  })

  it('requires semantic QA before review and preserves human publication authority', () => {
    const running = projectIntakeBuilderLifecycle({
      ...base,
      packageDraft: {
        id: 'package-a',
        status: 'DRAFT',
        validationEvidence: 'VALID',
        simulationEvidence: 'VALID',
        semanticQa: 'RUNNING',
      },
    })
    expect(running).toMatchObject({
      currentStage: 'QA',
      currentState: 'CURRENT',
      nextAction: 'WAIT_FOR_SEMANTIC_QA',
    })

    const approved = projectIntakeBuilderLifecycle({
      ...base,
      packageDraft: {
        id: 'package-a',
        status: 'APPROVED',
        validationEvidence: 'VALID',
        simulationEvidence: 'VALID',
        semanticQa: 'COMPLETE',
      },
    })
    expect(approved).toMatchObject({
      currentStage: 'PUBLISH',
      currentState: 'CURRENT',
      nextAction: 'APPLY_PACKAGE',
      requiresHumanApproval: true,
      autoApply: false,
      autoPublish: false,
    })
  })

  it('reports exact invalid stored evidence and reverted package boundaries', () => {
    const invalid = projectIntakeBuilderLifecycle({
      ...base,
      packageDraft: {
        id: 'package-a',
        status: 'DRAFT',
        validationEvidence: 'INVALID',
        simulationEvidence: 'INVALID',
        semanticQa: 'COMPLETE',
      },
    })
    expect(invalid).toMatchObject({
      currentStage: 'VALIDATE',
      currentState: 'BLOCKED',
      nextAction: 'REPAIR_PACKAGE_EVIDENCE',
    })

    const reverted = projectIntakeBuilderLifecycle({
      ...base,
      packageDraft: {
        id: 'package-a',
        status: 'REVERTED',
        validationEvidence: 'VALID',
        simulationEvidence: 'VALID',
        semanticQa: 'COMPLETE',
      },
    })
    expect(reverted).toMatchObject({
      currentStage: 'READY',
      currentState: 'BLOCKED',
      nextAction: 'REVIEW_REVERTED_PACKAGE',
    })
  })
})
