import { createHash } from 'node:crypto'
import { z } from 'zod'
import { AgentWorkflowPromotionAssessmentDiagnosticsSchema } from '@pathfinder/contracts/agent-workflow-promotion-assessment'
import { canonicalEvaluationJson, EvalCaseManifestSchema } from '@pathfinder/contracts/evaluation'
import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { compareEvaluationRuns } from './evaluation-run-comparison'
import { isAgentWorkflowArtifactIntact } from './agent-workflow-registry-actions'

const inputSchema = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().min(1).max(191),
    venueId: z.string().min(1).max(191),
    workflowVersionId: z.string().uuid(),
    proposalId: z.string().min(1).max(191),
    developmentValidationId: z.string().min(1).max(191),
    heldoutValidationId: z.string().min(1).max(191),
    actor: z
      .object({
        type: z.literal('HUMAN'),
        id: z.string().min(1).max(191),
        role: z.literal('PLATFORM_ADMIN'),
      })
      .strict(),
  })
  .strict()
  .refine((value) => value.developmentValidationId !== value.heldoutValidationId, {
    message: 'Development and heldout validation evidence must be distinct.',
    path: ['heldoutValidationId'],
  })
export type CreateAgentWorkflowPromotionAssessmentInput = z.input<typeof inputSchema>
export class AgentWorkflowPromotionAssessmentError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'AgentWorkflowPromotionAssessmentError'
  }
}
const select = {
  id: true,
  operationId: true,
  tenantId: true,
  venueId: true,
  workflowVersionId: true,
  proposalId: true,
  developmentValidationId: true,
  heldoutValidationId: true,
  assessmentHash: true,
  outcome: true,
  diagnostics: true,
  createdByType: true,
  createdById: true,
  createdAt: true,
} as const
const digest = (value: unknown) =>
  createHash('sha256')
    .update(canonicalEvaluationJson(value as never))
    .digest('hex')
function persistedValidationReceiptDigest(value: unknown) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const restored = structuredClone(value) as Record<string, unknown>
    for (const key of ['baseline', 'candidate']) {
      const run = restored[key]
      if (run && typeof run === 'object' && 'createdAt' in run) {
        const createdAt = (run as { createdAt?: unknown }).createdAt
        if (typeof createdAt === 'string') {
          const parsed = new Date(createdAt)
          if (Number.isNaN(parsed.valueOf())) return null
          ;(run as { createdAt: unknown }).createdAt = parsed
        }
      }
    }
    return digest(restored)
  } catch {
    return null
  }
}
const uniqueConflict = (error: unknown) =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')

export function decideAgentWorkflowPromotionAssessmentOutcome(input: {
  disjointCaseSets: boolean
  hasRegression: boolean
  hasIncompleteEvidence: boolean
  targetImprovementObserved: boolean
}) {
  return !input.disjointCaseSets
    ? ('REJECTED_OVERFIT' as const)
    : input.hasRegression
      ? ('REJECTED_REGRESSION' as const)
      : input.hasIncompleteEvidence || !input.targetImprovementObserved
        ? ('INCOMPLETE_EVIDENCE' as const)
        : ('EVIDENCE_READY_REVIEW_REQUIRED' as const)
}

function summary(
  validationId: string,
  comparison: Awaited<ReturnType<typeof compareEvaluationRuns>>,
  manifest: z.output<typeof EvalCaseManifestSchema>,
) {
  if (comparison.status === 'INCOMPARABLE') return null
  const missingResults = comparison.cases.filter((item) =>
    item.classification.includes('MISSING'),
  ).length
  const latencyPairs = comparison.cases.filter(
    (item) => item.baseline?.latencyMs != null && item.candidate?.latencyMs != null,
  )
  const latencyDeltaMs =
    latencyPairs.length === comparison.cases.length
      ? latencyPairs.reduce(
          (sum, item) => sum + item.candidate!.latencyMs! - item.baseline!.latencyMs!,
          0,
        )
      : null
  const costDeltaE8Usd = comparison.cases.every((item) => item.baseline && item.candidate)
    ? comparison.cases
        .reduce(
          (sum, item) => sum + BigInt(item.candidate!.costE8Usd) - BigInt(item.baseline!.costE8Usd),
          0n,
        )
        .toString()
    : null
  return {
    validationId,
    caseCount: manifest.length,
    resolvedFailures: comparison.cases.filter((item) => item.classification === 'RESOLVED_FAILURE')
      .length,
    newFailures: comparison.cases.filter((item) => item.classification === 'NEW_FAILURE').length,
    missingResults,
    caseIdentityHash: digest(
      manifest
        .map(({ caseId, revision, caseHash }) => ({ caseId, revision, caseHash }))
        .sort((a, b) => a.caseId.localeCompare(b.caseId)),
    ),
    latencyDeltaMs,
    costDeltaE8Usd,
  }
}

type PromotionEvidenceInput = Pick<
  CreateAgentWorkflowPromotionAssessmentInput,
  | 'tenantId'
  | 'venueId'
  | 'workflowVersionId'
  | 'proposalId'
  | 'developmentValidationId'
  | 'heldoutValidationId'
>
type PromotionEvidenceClient = Pick<
  typeof db,
  'agentWorkflowVersion' | 'agentImprovementProposal' | 'agentImprovementValidationEvidence'
> &
  NonNullable<Parameters<typeof compareEvaluationRuns>[1]>

/** Shared read path for initial assessment and activation-time evidence revalidation. */
async function evaluateCurrentPromotionEvidence(
  tx: PromotionEvidenceClient,
  input: PromotionEvidenceInput,
) {
  const workflow = await tx.agentWorkflowVersion.findFirst({
    where: { id: input.workflowVersionId, tenantId: input.tenantId, venueId: input.venueId },
  })
  const proposal = await tx.agentImprovementProposal.findFirst({
    where: { id: input.proposalId, tenantId: input.tenantId, venueId: input.venueId },
    select: {
      id: true,
      approvalRequest: { select: { decision: { select: { decision: true } } } },
    },
  })
  const validations = await tx.agentImprovementValidationEvidence.findMany({
    where: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      id: { in: [input.developmentValidationId, input.heldoutValidationId] },
    },
    include: { candidateEvalRun: { select: { caseManifestSnapshot: true } } },
  })
  if (!workflow || !proposal || validations.length !== 2)
    throw new AgentWorkflowPromotionAssessmentError(
      'NOT_FOUND',
      'Scoped workflow, proposal, or validation evidence was not found',
    )
  if (
    !isAgentWorkflowArtifactIntact(workflow) ||
    proposal.approvalRequest.decision?.decision !== 'APPROVED'
  )
    throw new AgentWorkflowPromotionAssessmentError(
      'CONFLICT',
      'Workflow integrity and approved proposal are required',
    )
  const expectedKind = workflow.kind === 'SKILL' ? 'SKILL_VERSION' : 'WORKFLOW_VERSION'
  const ordered = [input.developmentValidationId, input.heldoutValidationId].map(
    (id) => validations.find((item) => item.id === id)!,
  )
  for (const validation of ordered)
    if (
      validation.proposalId !== proposal.id ||
      validation.implementationKind !== expectedKind ||
      validation.implementationRef !== `AgentWorkflowVersion:${workflow.id}` ||
      validation.implementationVersion !== String(workflow.version) ||
      validation.implementationHash !== workflow.contentHash
    )
      throw new AgentWorkflowPromotionAssessmentError(
        'CONFLICT',
        'Validation identity or immutable comparison receipt does not match the workflow',
      )
  const manifests = ordered.map((item) =>
    EvalCaseManifestSchema.safeParse(item.candidateEvalRun.caseManifestSnapshot),
  )
  if (manifests.some((item) => !item.success))
    throw new AgentWorkflowPromotionAssessmentError(
      'CONFLICT',
      'Validation case manifest integrity is invalid',
    )
  const comparisons = await Promise.all(
    ordered.map((item) =>
      compareEvaluationRuns(
        {
          tenantId: input.tenantId,
          venueId: input.venueId,
          baselineRunId: item.baselineEvalRunId,
          candidateRunId: item.candidateEvalRunId,
          allowedMismatchReasons: item.changeDimensions,
        },
        tx,
      ),
    ),
  )
  for (const [index, validation] of ordered.entries()) {
    const currentSnapshot = {
      contractVersion: 1,
      interpretation: 'evidence-only-no-promotion-threshold',
      ...comparisons[index]!,
    }
    const persistedCurrentSnapshot = JSON.parse(JSON.stringify(currentSnapshot))
    const oversized = manifests[index]!.data!.length > 50
    const receiptHash = persistedValidationReceiptDigest(validation.comparisonSnapshot)
    if (
      receiptHash !== validation.comparisonHash ||
      (!oversized &&
        (digest(currentSnapshot) !== validation.comparisonHash ||
          canonicalEvaluationJson(persistedCurrentSnapshot) !==
            canonicalEvaluationJson(validation.comparisonSnapshot as never)))
    )
      throw new AgentWorkflowPromotionAssessmentError(
        'CONFLICT',
        'Immutable validation comparison evidence no longer matches its current result set',
      )
  }
  const development = summary(ordered[0]!.id, comparisons[0]!, manifests[0]!.data!)
  const heldout = summary(ordered[1]!.id, comparisons[1]!, manifests[1]!.data!)
  const developmentIds = new Set(manifests[0]!.data!.map((item) => item.caseId))
  const disjointCaseSets = manifests[1]!.data!.every((item) => !developmentIds.has(item.caseId))
  const targetImprovementObserved = Boolean(development && development.resolvedFailures > 0)
  const allRunsCompleted = comparisons.every(
    (comparison) =>
      comparison.baseline.status === 'COMPLETED' && comparison.candidate.status === 'COMPLETED',
  )
  const oversizedEvidence = manifests.some((manifest) => manifest.data!.length > 50)
  const incomplete =
    !development ||
    !heldout ||
    development.missingResults > 0 ||
    heldout.missingResults > 0 ||
    !allRunsCompleted ||
    oversizedEvidence
  const regression = Boolean((development?.newFailures ?? 0) > 0 || (heldout?.newFailures ?? 0) > 0)
  const outcome = decideAgentWorkflowPromotionAssessmentOutcome({
    disjointCaseSets,
    hasRegression: regression,
    hasIncompleteEvidence: incomplete,
    targetImprovementObserved,
  })
  const diagnostics = AgentWorkflowPromotionAssessmentDiagnosticsSchema.parse({
    contractVersion: 1,
    interpretation: 'evidence-only-no-activation',
    development: development ?? {
      validationId: ordered[0]!.id,
      caseCount: manifests[0]!.data!.length,
      resolvedFailures: 0,
      newFailures: 0,
      missingResults: manifests[0]!.data!.length,
      caseIdentityHash: digest(manifests[0]!.data),
      latencyDeltaMs: null,
      costDeltaE8Usd: null,
    },
    heldout: heldout ?? {
      validationId: ordered[1]!.id,
      caseCount: manifests[1]!.data!.length,
      resolvedFailures: 0,
      newFailures: 0,
      missingResults: manifests[1]!.data!.length,
      caseIdentityHash: digest(manifests[1]!.data),
      latencyDeltaMs: null,
      costDeltaE8Usd: null,
    },
    disjointCaseSets,
    targetImprovementObserved,
    thresholdResolution: 'UNRESOLVED',
    autonomousPromotionEligible: false,
    limitations: [
      'Resolved development failures show fixture-level improvement only; target-task relevance still requires human review.',
      'No reviewed latency or cost threshold is bound, so autonomous promotion is ineligible.',
      ...(!allRunsCompleted
        ? ['Only COMPLETED evaluation runs can support promotion review readiness.']
        : []),
      ...(oversizedEvidence
        ? [
            'At least one evaluation manifest exceeds the 50-case comparison boundary; its full case count is retained but it is not treated as compared evidence.',
          ]
        : []),
    ],
  })
  return { workflow, proposal, ordered, outcome, diagnostics }
}

/** Re-read current comparison results; an immutable assessment ID is not a freshness check.
 * Call in the activation transaction before comparing its dedicated approval receipt. */
export async function revalidateAgentWorkflowPromotionAssessment(
  tx: PromotionEvidenceClient & Pick<typeof db, 'agentWorkflowPromotionAssessment' | '$queryRaw'>,
  input: { tenantId: string; venueId: string; workflowVersionId: string; assessmentId: string },
) {
  const assessment = await tx.agentWorkflowPromotionAssessment.findFirst({
    where: {
      id: input.assessmentId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      workflowVersionId: input.workflowVersionId,
    },
    select,
  })
  if (!assessment)
    throw new AgentWorkflowPromotionAssessmentError('NOT_FOUND', 'Scoped assessment was not found')
  const expectedIdentityHash = digest({
    tenantId: assessment.tenantId,
    venueId: assessment.venueId,
    workflowVersionId: assessment.workflowVersionId,
    proposalId: assessment.proposalId,
    developmentValidationId: assessment.developmentValidationId,
    heldoutValidationId: assessment.heldoutValidationId,
    actorId: assessment.createdById,
  })
  if (assessment.createdByType !== 'HUMAN' || assessment.assessmentHash !== expectedIdentityHash)
    throw new AgentWorkflowPromotionAssessmentError(
      'CONFLICT',
      'Assessment identity integrity failed',
    )
  const validations = await tx.agentImprovementValidationEvidence.findMany({
    where: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      id: { in: [assessment.developmentValidationId, assessment.heldoutValidationId] },
    },
    select: { baselineEvalRunId: true, candidateEvalRunId: true },
  })
  if (validations.length !== 2)
    throw new AgentWorkflowPromotionAssessmentError(
      'CONFLICT',
      'Exact validation pair is unavailable',
    )
  const runIds = [
    ...new Set(
      validations.flatMap((validation) => [
        validation.baselineEvalRunId,
        validation.candidateEvalRunId,
      ]),
    ),
  ].sort()
  // A review INSERT takes FK KEY SHARE on its result. Locking the exact result
  // rows serializes that canonical write with the activation transaction. READY
  // requires all manifest results already present; each of four runs is <=50 cases.
  const lockedResults = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM eval_results
    WHERE tenant_id = ${input.tenantId} AND venue_id = ${input.venueId}
      AND run_id = ANY(${runIds}::uuid[])
    ORDER BY id LIMIT 201 FOR UPDATE`
  if (lockedResults.length > 200)
    throw new AgentWorkflowPromotionAssessmentError(
      'CONFLICT',
      'Activation comparison result bound exceeded',
    )
  const current = await evaluateCurrentPromotionEvidence(tx, assessment)
  if (
    current.outcome !== 'EVIDENCE_READY_REVIEW_REQUIRED' ||
    assessment.outcome !== current.outcome ||
    canonicalEvaluationJson(assessment.diagnostics as never) !==
      canonicalEvaluationJson(current.diagnostics as never)
  )
    throw new AgentWorkflowPromotionAssessmentError(
      'CONFLICT',
      'Assessment diagnostics no longer match current evidence',
    )
  return {
    assessment,
    evidenceDigest: digest({
      diagnostics: current.diagnostics,
      developmentValidationId: assessment.developmentValidationId,
      heldoutValidationId: assessment.heldoutValidationId,
      comparisonHashes: current.ordered.map((validation) => ({
        id: validation.id,
        hash: validation.comparisonHash,
      })),
    }),
  }
}

export async function createAgentWorkflowPromotionAssessment(
  raw: CreateAgentWorkflowPromotionAssessmentInput,
  client: Pick<typeof db, '$transaction'> = db,
) {
  const parsed = inputSchema.safeParse(raw)
  if (!parsed.success)
    throw new AgentWorkflowPromotionAssessmentError(
      'INVALID_INPUT',
      parsed.error.issues[0]?.message ?? 'Invalid assessment input',
    )
  const input = parsed.data
  const inputHash = digest({
    tenantId: input.tenantId,
    venueId: input.venueId,
    workflowVersionId: input.workflowVersionId,
    proposalId: input.proposalId,
    developmentValidationId: input.developmentValidationId,
    heldoutValidationId: input.heldoutValidationId,
    actorId: input.actor.id,
  })
  const attempt = () =>
    client.$transaction(async (tx) => {
      const replay = await tx.agentWorkflowPromotionAssessment.findFirst({
        where: { tenantId: input.tenantId, operationId: input.operationId },
        select,
      })
      if (replay) {
        if (replay.assessmentHash !== inputHash || replay.createdById !== input.actor.id)
          throw new AgentWorkflowPromotionAssessmentError(
            'CONFLICT',
            'Operation ID belongs to a different assessment',
          )
        return { assessment: replay, replayed: true as const }
      }
      const { workflow, proposal, ordered, outcome, diagnostics } =
        await evaluateCurrentPromotionEvidence(tx, input)
      const created = await tx.agentWorkflowPromotionAssessment.create({
        data: {
          operationId: input.operationId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          workflowVersionId: workflow.id,
          proposalId: proposal.id,
          developmentValidationId: ordered[0]!.id,
          heldoutValidationId: ordered[1]!.id,
          assessmentHash: inputHash,
          outcome,
          diagnostics,
          createdByType: 'HUMAN',
          createdById: input.actor.id,
        },
        select,
      })
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: input.actor.id,
          actorRole: 'PLATFORM_ADMIN',
          action: 'agent-workflow-promotion.assessed',
          targetType: 'AgentWorkflowPromotionAssessment',
          targetId: created.id,
          afterState: {
            venueId: input.venueId,
            outcome,
            autonomousPromotionEligible: false,
            behaviorChanged: false,
            authorityChanged: false,
          },
        },
        tx,
      )
      return { assessment: created, replayed: false as const }
    })
  try {
    return await attempt()
  } catch (error) {
    if (!uniqueConflict(error)) throw error
    const replay = await client.$transaction((tx) =>
      tx.agentWorkflowPromotionAssessment.findFirst({
        where: { tenantId: input.tenantId, operationId: input.operationId },
        select,
      }),
    )
    if (replay?.assessmentHash === inputHash && replay.createdById === input.actor.id)
      return { assessment: replay, replayed: true as const }
    throw new AgentWorkflowPromotionAssessmentError(
      'CONFLICT',
      'Assessment changed concurrently; refresh before retrying',
    )
  }
}

export async function readAgentWorkflowPromotionAssessments(
  input: { tenantId: string; venueId: string; workflowVersionId?: string; limit?: number },
  client: typeof db = db,
) {
  const parsed = z
    .object({
      tenantId: z.string().min(1).max(191),
      venueId: z.string().min(1).max(191),
      workflowVersionId: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(50).default(20),
    })
    .parse(input)
  return client.agentWorkflowPromotionAssessment.findMany({
    where: {
      tenantId: parsed.tenantId,
      venueId: parsed.venueId,
      ...(parsed.workflowVersionId ? { workflowVersionId: parsed.workflowVersionId } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: parsed.limit,
    select,
  })
}
