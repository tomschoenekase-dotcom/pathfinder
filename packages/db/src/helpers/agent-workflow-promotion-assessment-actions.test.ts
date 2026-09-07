import { createHash, randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentWorkflowPromotionAssessmentDiagnosticsSchema } from '@pathfinder/contracts/agent-workflow-promotion-assessment'
import { canonicalEvaluationJson } from '@pathfinder/contracts/evaluation'

const mocks = vi.hoisted(() => ({ compare: vi.fn(), audit: vi.fn() }))
vi.mock('./evaluation-run-comparison', () => ({ compareEvaluationRuns: mocks.compare }))
vi.mock('./audit', () => ({ writeAuditLogStrict: mocks.audit }))
vi.mock('./agent-workflow-registry-actions', () => ({ isAgentWorkflowArtifactIntact: () => true }))

import {
  AgentWorkflowPromotionAssessmentError,
  createAgentWorkflowPromotionAssessment,
  revalidateAgentWorkflowPromotionAssessment,
} from './agent-workflow-promotion-assessment-actions'

const hash = (value: unknown) =>
  createHash('sha256')
    .update(canonicalEvaluationJson(value as never))
    .digest('hex')
const workflowId = randomUUID()
const proposalId = 'proposal-1'
const actor = { type: 'HUMAN' as const, id: 'admin-1', role: 'PLATFORM_ADMIN' as const }
const caseManifest = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => ({
    caseId: `${prefix}${String(index).padStart(12, '0')}`,
    revision: 1,
    caseHash: 'a'.repeat(64),
  }))

function comparison(status = 'COMPLETED', missing = false) {
  const createdAt = new Date('2026-09-07T12:00:00.000Z')
  return {
    status: 'COMPARABLE' as const,
    baseline: { id: 'base', status, createdAt },
    candidate: { id: 'candidate', status, createdAt },
    mismatchReasons: [],
    declaredChangeReasons: [],
    cases: [
      {
        caseKey: 'case',
        caseRevision: 1,
        category: 'fixture',
        classification: missing ? 'CANDIDATE_RESULT_MISSING' : 'RESOLVED_FAILURE',
        baseline: { latencyMs: 10, costE8Usd: '5' },
        candidate: missing ? null : { latencyMs: 8, costE8Usd: '4' },
      },
    ],
    totals: {},
  }
}

function fixture(
  options: {
    manifests?: [unknown[], unknown[]]
    comparisons?: [any, any]
    malformed?: boolean
    tampered?: boolean
  } = {},
) {
  const comparisons = options.comparisons ?? [comparison(), comparison()]
  const manifests = options.manifests ?? [
    caseManifest(1, '00000000-0000-4000-8000-'),
    caseManifest(1, '10000000-0000-4000-8000-'),
  ]
  const validations = comparisons.map((value, index) => {
    const snapshot = {
      contractVersion: 1,
      interpretation: 'evidence-only-no-promotion-threshold',
      ...value,
    }
    return {
      id: `validation-${index}`,
      proposalId,
      implementationKind: 'WORKFLOW_VERSION',
      implementationRef: `AgentWorkflowVersion:${workflowId}`,
      implementationVersion: '1',
      implementationHash: 'b'.repeat(64),
      comparisonSnapshot: options.malformed ? 'invalid' : JSON.parse(JSON.stringify(snapshot)),
      comparisonHash: options.tampered ? '0'.repeat(64) : hash(snapshot),
      candidateEvalRun: { caseManifestSnapshot: manifests[index] },
      baselineEvalRunId: `baseline-${index}`,
      candidateEvalRunId: `candidate-${index}`,
      changeDimensions: [],
    }
  })
  const create = vi.fn(async ({ data }: any) => ({ id: 'assessment-1', ...data }))
  const tx = {
    $queryRaw: vi.fn(async () => [] as { id: string }[]),
    agentWorkflowPromotionAssessment: { findFirst: vi.fn(async () => null), create },
    agentWorkflowVersion: {
      findFirst: vi.fn(async () => ({
        id: workflowId,
        version: 1,
        kind: 'WORKFLOW',
        contentHash: 'b'.repeat(64),
      })),
    },
    agentImprovementProposal: {
      findFirst: vi.fn(async () => ({
        id: proposalId,
        approvalRequest: { decision: { decision: 'APPROVED' } },
      })),
    },
    agentImprovementValidationEvidence: { findMany: vi.fn(async () => validations) },
  }
  mocks.compare.mockReset()
  mocks.compare.mockResolvedValueOnce(comparisons[0]).mockResolvedValueOnce(comparisons[1])
  return { tx, comparisons, validations, client: { $transaction: (callback: any) => callback(tx) } }
}

const request = () => ({
  operationId: randomUUID(),
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  workflowVersionId: workflowId,
  proposalId,
  developmentValidationId: 'validation-0',
  heldoutValidationId: 'validation-1',
  actor,
})

describe('workflow promotion assessment persistence decisions', () => {
  beforeEach(() => {
    mocks.audit.mockReset()
  })

  it('persists non-completed comparisons as incomplete', async () => {
    const scoped = fixture({ comparisons: [comparison('RUNNING'), comparison()] })
    const result = await createAgentWorkflowPromotionAssessment(request(), scoped.client as never)
    expect(result.assessment).toMatchObject({ outcome: 'INCOMPLETE_EVIDENCE' })
    const diagnostics = AgentWorkflowPromotionAssessmentDiagnosticsSchema.parse(
      result.assessment.diagnostics,
    )
    expect(diagnostics.limitations).toContain(
      'Only COMPLETED evaluation runs can support promotion review readiness.',
    )
  })

  it('retains oversized manifests without treating them as compared', async () => {
    const scoped = fixture({
      manifests: [
        caseManifest(51, '00000000-0000-4000-8000-'),
        caseManifest(51, '10000000-0000-4000-8000-'),
      ],
    })
    const result = await createAgentWorkflowPromotionAssessment(request(), scoped.client as never)
    expect(result.assessment).toMatchObject({ outcome: 'INCOMPLETE_EVIDENCE' })
    expect(
      AgentWorkflowPromotionAssessmentDiagnosticsSchema.parse(result.assessment.diagnostics)
        .development.caseCount,
    ).toBe(51)
  })

  it('persists null cost when a result is missing', async () => {
    const scoped = fixture({ comparisons: [comparison('COMPLETED', true), comparison()] })
    const result = await createAgentWorkflowPromotionAssessment(request(), scoped.client as never)
    expect(
      AgentWorkflowPromotionAssessmentDiagnosticsSchema.parse(result.assessment.diagnostics)
        .development,
    ).toMatchObject({
      missingResults: 1,
      costDeltaE8Usd: null,
    })
  })

  it('returns a typed conflict for malformed stored receipt JSON', async () => {
    const scoped = fixture({ malformed: true })
    await expect(
      createAgentWorkflowPromotionAssessment(request(), scoped.client as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      createAgentWorkflowPromotionAssessment(request(), scoped.client as never),
    ).rejects.toBeInstanceOf(AgentWorkflowPromotionAssessmentError)
  })

  it('rejects a stale validation receipt hash', async () => {
    const scoped = fixture({ tampered: true })
    await expect(
      createAgentWorkflowPromotionAssessment(request(), scoped.client as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('activation-time promotion evidence revalidation', () => {
  it('re-reads comparisons and binds their immutable receipts in the approval digest', async () => {
    const scoped = fixture()
    const created = await createAgentWorkflowPromotionAssessment(request(), scoped.client as never)
    scoped.tx.agentWorkflowPromotionAssessment.findFirst.mockResolvedValue(
      created.assessment as never,
    )
    mocks.compare
      .mockResolvedValueOnce(scoped.comparisons[0])
      .mockResolvedValueOnce(scoped.comparisons[1])
    const result = await revalidateAgentWorkflowPromotionAssessment(scoped.tx as never, {
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      workflowVersionId: workflowId,
      assessmentId: created.assessment.id,
    })
    expect(mocks.compare).toHaveBeenCalledTimes(4)
    expect(scoped.tx.$queryRaw).toHaveBeenCalledOnce()
    expect(result.evidenceDigest).toBe(
      hash({
        diagnostics: created.assessment.diagnostics,
        developmentValidationId: 'validation-0',
        heldoutValidationId: 'validation-1',
        comparisonHashes: scoped.validations.map((value) => ({
          id: value.id,
          hash: value.comparisonHash,
        })),
      }),
    )
    expect(scoped.tx.agentWorkflowPromotionAssessment.create).toHaveBeenCalledTimes(1)
  })
  it('holds an oversized result set before comparing or activating it', async () => {
    const scoped = fixture()
    const created = await createAgentWorkflowPromotionAssessment(request(), scoped.client as never)
    scoped.tx.agentWorkflowPromotionAssessment.findFirst.mockResolvedValue(
      created.assessment as never,
    )
    scoped.tx.$queryRaw.mockResolvedValue(
      Array.from({ length: 201 }, (_, index) => ({ id: String(index) })),
    )
    await expect(
      revalidateAgentWorkflowPromotionAssessment(scoped.tx as never, {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        workflowVersionId: workflowId,
        assessmentId: created.assessment.id,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mocks.compare).toHaveBeenCalledTimes(2)
    expect(scoped.tx.agentWorkflowPromotionAssessment.create).toHaveBeenCalledTimes(1)
  })

  it('rejects result drift after assessment even while its stored diagnostics remain unchanged', async () => {
    const scoped = fixture()
    const created = await createAgentWorkflowPromotionAssessment(request(), scoped.client as never)
    scoped.tx.agentWorkflowPromotionAssessment.findFirst.mockResolvedValue(
      created.assessment as never,
    )
    const drifted = structuredClone(scoped.comparisons[0])
    drifted.cases[0].candidate.costE8Usd = '999'
    mocks.compare.mockResolvedValueOnce(drifted).mockResolvedValueOnce(scoped.comparisons[1])
    await expect(
      revalidateAgentWorkflowPromotionAssessment(scoped.tx as never, {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        workflowVersionId: workflowId,
        assessmentId: created.assessment.id,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('rejects changed assessment diagnostics and identity without writing a replacement', async () => {
    for (const tamperIdentity of [false, true]) {
      const scoped = fixture()
      const created = await createAgentWorkflowPromotionAssessment(
        request(),
        scoped.client as never,
      )
      const assessment = structuredClone(created.assessment)
      if (tamperIdentity) assessment.assessmentHash = '0'.repeat(64)
      else (assessment.diagnostics as any).development.resolvedFailures = 999
      scoped.tx.agentWorkflowPromotionAssessment.findFirst.mockResolvedValue(assessment as never)
      mocks.compare
        .mockResolvedValueOnce(scoped.comparisons[0])
        .mockResolvedValueOnce(scoped.comparisons[1])
      await expect(
        revalidateAgentWorkflowPromotionAssessment(scoped.tx as never, {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          workflowVersionId: workflowId,
          assessmentId: assessment.id,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(scoped.tx.agentWorkflowPromotionAssessment.create).toHaveBeenCalledTimes(1)
    }
  })
})
