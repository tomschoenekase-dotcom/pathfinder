import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  AgentWorkflowActivationRequestSchema,
  AgentWorkflowCanaryPolicySchema,
} from '@pathfinder/contracts/agent-workflow-activation'
import { AgentWorkflowPromotionAssessmentDiagnosticsSchema } from '@pathfinder/contracts/agent-workflow-promotion-assessment'
import { canonicalEvaluationJson } from '@pathfinder/contracts/evaluation'
import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { isAgentWorkflowArtifactIntact } from './agent-workflow-registry-actions'
import { agentWorkflowActivationEventHash } from './agent-workflow-run-lease'
import { revalidateAgentWorkflowPromotionAssessment } from './agent-workflow-promotion-assessment-actions'

const human = z
  .object({
    type: z.literal('HUMAN'),
    id: z.string().min(1).max(191),
    role: z.literal('PLATFORM_ADMIN'),
  })
  .strict()
const transitionSchema = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().min(1).max(191),
    venueId: z.string().min(1).max(191),
    registryKey: z.string().min(1).max(191),
    approvalDecisionId: z.string().min(1).max(191),
    expectedHeadRevision: z.number().int().min(1),
    reason: z.string().trim().min(1).max(2000),
    actor: human,
    kind: z.enum(['ROLLBACK', 'REVOKE']),
    workflowVersionId: z.string().uuid().optional(),
    canaryPolicy: AgentWorkflowCanaryPolicySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.kind === 'ROLLBACK' && (!value.workflowVersionId || !value.canaryPolicy)) ||
      (value.kind === 'REVOKE' && (value.workflowVersionId || value.canaryPolicy))
    )
      context.addIssue({
        code: 'custom',
        message: 'Rollback requires an exact version and canary; revoke permits neither.',
      })
  })
const hash = (value: unknown) =>
  createHash('sha256')
    .update(canonicalEvaluationJson(value as never))
    .digest('hex')

export const agentWorkflowActivationApprovalReceipt = (
  input: {
    registryKey: string
    workflowVersionId: string
    promotionAssessmentId: string
    expectedHeadRevision: number
    canaryPolicy: z.infer<typeof AgentWorkflowCanaryPolicySchema>
  },
  evidenceDigest: string,
) => ({
  registryKey: input.registryKey,
  workflowVersionId: input.workflowVersionId,
  promotionAssessmentId: input.promotionAssessmentId,
  expectedHeadRevision: input.expectedHeadRevision,
  canaryPolicy: input.canaryPolicy,
  evidenceDigest,
})

export const agentWorkflowTransitionApprovalReceipt = (
  input: {
    kind: 'ROLLBACK' | 'REVOKE'
    registryKey: string
    workflowVersionId?: string | null | undefined
    expectedHeadRevision: number
    canaryPolicy?: z.infer<typeof AgentWorkflowCanaryPolicySchema> | undefined
  },
  evidenceDigest: string,
) => ({
  kind: input.kind,
  registryKey: input.registryKey,
  workflowVersionId: input.workflowVersionId ?? null,
  expectedHeadRevision: input.expectedHeadRevision,
  canaryPolicy: input.canaryPolicy ?? null,
  evidenceDigest,
})

export const agentWorkflowTransitionEvidenceDigest = (
  transition: Omit<ReturnType<typeof agentWorkflowTransitionApprovalReceipt>, 'evidenceDigest'>,
  priorActivationEventId: string | null,
  rollbackLineageEventHash: string | null,
) =>
  hash({
    transition,
    priorActivationEventHash: priorActivationEventId,
    rollbackLineageEventHash,
  })

export class AgentWorkflowActivationError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN',
    message: string,
  ) {
    super(message)
    this.name = 'AgentWorkflowActivationError'
  }
}
type Client = Pick<typeof db, '$transaction'>
type Tx = Parameters<Parameters<Client['$transaction']>[0]>[0]

async function lockHead(tx: Tx, scope: { tenantId: string; venueId: string; registryKey: string }) {
  const where = {
    tenantId: scope.tenantId,
    venueId: scope.venueId,
    registryKey: scope.registryKey,
  }
  await tx.$queryRaw`SELECT id FROM agent_workflow_activation_heads WHERE tenant_id=${where.tenantId} AND venue_id=${where.venueId} AND registry_key=${where.registryKey} FOR UPDATE`
  return tx.agentWorkflowActivationHead.findFirst({ where })
}
async function exactApproval(
  tx: Tx,
  input: {
    tenantId: string
    venueId: string
    approvalDecisionId: string
    actorId: string
    action: string
    receipt: unknown
  },
) {
  const decision = await tx.approvalDecision.findFirst({
    where: {
      id: input.approvalDecisionId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      decision: 'APPROVED',
      decidedByType: 'HUMAN',
    },
    include: { approvalRequest: true },
  })
  if (!decision || decision.approvalRequest.proposedAction !== input.action)
    throw new AgentWorkflowActivationError(
      'FORBIDDEN',
      'A dedicated scoped human approval is required',
    )
  if (decision.approvalRequest.expiresAt && decision.approvalRequest.expiresAt <= new Date())
    throw new AgentWorkflowActivationError('CONFLICT', 'Activation approval has expired')
  if (hash(decision.approvalRequest.scopeSnapshot) !== hash(input.receipt))
    throw new AgentWorkflowActivationError(
      'CONFLICT',
      'Approval scope does not match the exact transition',
    )
  return decision
}

function assertSupportedEffectPolicy(policy: z.infer<typeof AgentWorkflowCanaryPolicySchema>) {
  if (
    policy.supportedActionClasses.some((action) =>
      ['AGENT_DELEGATION', 'OPERATOR_QUESTION', 'BILLING_PROPOSAL'].includes(action),
    )
  )
    throw new AgentWorkflowActivationError(
      'FORBIDDEN',
      'Activation includes an action class without a complete canonical effect fence',
    )
}

export async function activateAgentWorkflowVersion(
  raw: z.input<typeof AgentWorkflowActivationRequestSchema> & { actor: z.input<typeof human> },
  availableCapabilities: ReadonlySet<string>,
  client: Client = db,
) {
  const parsed = AgentWorkflowActivationRequestSchema.extend({ actor: human }).safeParse(raw)
  if (!parsed.success)
    throw new AgentWorkflowActivationError(
      'INVALID_INPUT',
      parsed.error.issues[0]?.message ?? 'Invalid activation',
    )
  const input = parsed.data
  assertSupportedEffectPolicy(input.canaryPolicy)
  return client.$transaction(async (rawTx) => {
    const tx = rawTx
    const head = await lockHead(tx, input)
    const replay = await tx.agentWorkflowActivationEvent.findFirst({
      where: { tenantId: input.tenantId, operationId: input.operationId },
    })
    if (replay) {
      if (
        replay.registryKey !== input.registryKey ||
        replay.venueId !== input.venueId ||
        replay.kind !== 'ACTIVATE' ||
        replay.resultingVersionId !== input.workflowVersionId ||
        replay.promotionAssessmentId !== input.promotionAssessmentId ||
        replay.approvalDecisionId !== input.approvalDecisionId ||
        replay.priorRevision !== input.expectedHeadRevision ||
        replay.createdBy !== input.actor.id ||
        replay.reason !== input.reason ||
        hash(replay.canaryPolicy) !== hash(input.canaryPolicy)
      )
        throw new AgentWorkflowActivationError(
          'CONFLICT',
          'Operation belongs to another activation',
        )
      return { event: replay, replayed: true as const }
    }
    if ((head?.revision ?? 0) !== input.expectedHeadRevision)
      throw new AgentWorkflowActivationError('CONFLICT', 'Activation head revision changed')
    const version = await tx.agentWorkflowVersion.findFirst({
      where: {
        id: input.workflowVersionId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        registryKey: input.registryKey,
      },
    })
    if (!version || !isAgentWorkflowArtifactIntact(version))
      throw new AgentWorkflowActivationError('CONFLICT', 'Workflow or assessment integrity failed')
    const { assessment, evidenceDigest } = await revalidateAgentWorkflowPromotionAssessment(tx, {
      tenantId: input.tenantId,
      venueId: input.venueId,
      workflowVersionId: input.workflowVersionId,
      assessmentId: input.promotionAssessmentId,
    })
    const diagnostics = AgentWorkflowPromotionAssessmentDiagnosticsSchema.safeParse(
      assessment.diagnostics,
    )
    if (
      !diagnostics.success ||
      assessment.outcome !== 'EVIDENCE_READY_REVIEW_REQUIRED' ||
      diagnostics.data.autonomousPromotionEligible
    )
      throw new AgentWorkflowActivationError(
        'CONFLICT',
        'Assessment is not eligible for explicit review',
      )
    await exactApproval(tx, {
      ...input,
      actorId: input.actor.id,
      action: 'agent-workflow.activate',
      receipt: agentWorkflowActivationApprovalReceipt(input, evidenceDigest),
    })
    const required = [...version.requiredToolCapabilities].sort()
    if (required.some((capability) => !availableCapabilities.has(capability)))
      throw new AgentWorkflowActivationError('FORBIDDEN', 'Required callable tool is unavailable')
    const eventHash = agentWorkflowActivationEventHash({
      tenantId: input.tenantId,
      venueId: input.venueId,
      registryKey: input.registryKey,
      kind: 'ACTIVATE',
      priorVersionId: head?.activeVersionId ?? null,
      resultingVersionId: version.id,
      promotionAssessmentId: assessment.id,
      approvalDecisionId: input.approvalDecisionId,
      priorRevision: input.expectedHeadRevision,
      resultingRevision: input.expectedHeadRevision + 1,
      evidenceDigest,
      canaryPolicy: input.canaryPolicy,
      requiredCapabilities: required,
      reason: input.reason,
      createdBy: input.actor.id,
    })
    const event = await tx.agentWorkflowActivationEvent.create({
      data: {
        operationId: input.operationId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        registryKey: input.registryKey,
        kind: 'ACTIVATE',
        priorVersionId: head?.activeVersionId ?? null,
        resultingVersionId: version.id,
        promotionAssessmentId: assessment.id,
        approvalDecisionId: input.approvalDecisionId,
        priorRevision: input.expectedHeadRevision,
        resultingRevision: input.expectedHeadRevision + 1,
        evidenceDigest,
        canaryPolicy: input.canaryPolicy,
        requiredCapabilities: required,
        eventHash,
        reason: input.reason,
        createdBy: input.actor.id,
      },
    })
    const changed = head
      ? await tx.agentWorkflowActivationHead.updateMany({
          where: { id: head.id, revision: input.expectedHeadRevision },
          data: {
            activeVersionId: version.id,
            activationEventId: event.id,
            revision: { increment: 1 },
            selectedRunCount: 0,
          },
        })
      : await tx.agentWorkflowActivationHead
          .create({
            data: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              registryKey: input.registryKey,
              activeVersionId: version.id,
              activationEventId: event.id,
              revision: 1,
            },
          })
          .then(() => ({ count: 1 }))
    if (changed.count !== 1)
      throw new AgentWorkflowActivationError('CONFLICT', 'Activation CAS lost')
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: 'PLATFORM_ADMIN',
        action: 'agent-workflow.activated',
        targetType: 'AgentWorkflowActivationEvent',
        targetId: event.id,
        afterState: {
          venueId: input.venueId,
          registryKey: input.registryKey,
          workflowVersionId: version.id,
          authorityChanged: false,
        },
      },
      tx,
    )
    return { event, replayed: false as const }
  })
}

export async function transitionAgentWorkflowActivation(
  raw: z.input<typeof transitionSchema>,
  availableCapabilities: ReadonlySet<string>,
  client: Client = db,
) {
  const parsed = transitionSchema.safeParse(raw)
  if (!parsed.success)
    throw new AgentWorkflowActivationError(
      'INVALID_INPUT',
      parsed.error.issues[0]?.message ?? 'Invalid transition',
    )
  const input = parsed.data
  if (input.canaryPolicy) assertSupportedEffectPolicy(input.canaryPolicy)
  return client.$transaction(async (rawTx) => {
    const tx = rawTx
    const head = await lockHead(tx, input)
    const receipt = {
      kind: input.kind,
      registryKey: input.registryKey,
      workflowVersionId: input.workflowVersionId ?? null,
      expectedHeadRevision: input.expectedHeadRevision,
      canaryPolicy: input.canaryPolicy ?? null,
    }
    const replay = await tx.agentWorkflowActivationEvent.findFirst({
      where: { tenantId: input.tenantId, operationId: input.operationId },
    })
    if (replay) {
      if (
        replay.registryKey !== input.registryKey ||
        replay.venueId !== input.venueId ||
        replay.kind !== input.kind ||
        replay.resultingVersionId !== (input.workflowVersionId ?? null) ||
        replay.approvalDecisionId !== input.approvalDecisionId ||
        replay.priorRevision !== input.expectedHeadRevision ||
        replay.createdBy !== input.actor.id ||
        replay.reason !== input.reason ||
        hash(replay.canaryPolicy) !== hash(input.canaryPolicy ?? {})
      )
        throw new AgentWorkflowActivationError(
          'CONFLICT',
          'Operation belongs to another activation transition',
        )
      return { event: replay, replayed: true as const }
    }
    if (!head || head.revision !== input.expectedHeadRevision)
      throw new AgentWorkflowActivationError('CONFLICT', 'Activation head revision changed')
    const version = input.workflowVersionId
      ? await tx.agentWorkflowVersion.findFirst({
          where: {
            id: input.workflowVersionId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            registryKey: input.registryKey,
          },
        })
      : null
    if (input.kind === 'ROLLBACK' && (!version || !isAgentWorkflowArtifactIntact(version)))
      throw new AgentWorkflowActivationError('CONFLICT', 'Rollback target integrity failed')
    const lineage = version
      ? await tx.agentWorkflowActivationEvent.findFirst({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            registryKey: input.registryKey,
            resultingVersionId: version.id,
            kind: { in: ['ACTIVATE', 'ROLLBACK'] },
          },
          orderBy: [{ resultingRevision: 'desc' }, { id: 'desc' }],
        })
      : null
    if (input.kind === 'ROLLBACK' && !lineage)
      throw new AgentWorkflowActivationError(
        'CONFLICT',
        'Rollback target is not in the reviewed activation lineage',
      )
    if (
      version?.requiredToolCapabilities.some((capability) => !availableCapabilities.has(capability))
    )
      throw new AgentWorkflowActivationError('FORBIDDEN', 'Required callable tool is unavailable')
    const evidenceDigest = agentWorkflowTransitionEvidenceDigest(
      receipt,
      head.activationEventId,
      lineage?.eventHash ?? null,
    )
    await exactApproval(tx, {
      ...input,
      actorId: input.actor.id,
      action: input.kind === 'REVOKE' ? 'agent-workflow.revoke' : 'agent-workflow.rollback',
      receipt: agentWorkflowTransitionApprovalReceipt(input, evidenceDigest),
    })
    // Head is locked first. This set-based update then locks every effective dependent run;
    // skipped baseline bindings are deliberately unaffected. A later failure rolls it back.
    await tx.$executeRaw`
      UPDATE agent_runs AS run
      SET status = 'CANCELLED', cancel_requested_at = clock_timestamp(),
          execution_lease_token = NULL, execution_lease_expires_at = NULL,
          updated_at = clock_timestamp()
      WHERE run.tenant_id = ${input.tenantId} AND run.venue_id = ${input.venueId}
        AND run.status IN ('QUEUED', 'RUNNING', 'AWAITING_INPUT', 'AWAITING_APPROVAL')
        AND EXISTS (
          SELECT 1 FROM agent_workflow_run_bindings AS binding
          WHERE binding.agent_run_id = run.id
            AND binding.tenant_id = ${input.tenantId}
            AND binding.venue_id = ${input.venueId}
            AND binding.activation_event_id = ${head.activationEventId}::uuid
            AND binding.outcome IN ('SELECTED', 'CANARY_SKIPPED_PRIOR_VERSION')
        )`
    const eventHash = agentWorkflowActivationEventHash({
      tenantId: input.tenantId,
      venueId: input.venueId,
      registryKey: input.registryKey,
      kind: input.kind,
      priorVersionId: head.activeVersionId,
      resultingVersionId: version?.id ?? null,
      promotionAssessmentId: null,
      approvalDecisionId: input.approvalDecisionId,
      priorRevision: head.revision,
      resultingRevision: head.revision + 1,
      evidenceDigest,
      canaryPolicy: input.canaryPolicy ?? {},
      requiredCapabilities: version?.requiredToolCapabilities ?? [],
      reason: input.reason,
      createdBy: input.actor.id,
    })
    const event = await tx.agentWorkflowActivationEvent.create({
      data: {
        operationId: input.operationId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        registryKey: input.registryKey,
        kind: input.kind,
        priorVersionId: head.activeVersionId,
        resultingVersionId: version?.id ?? null,
        approvalDecisionId: input.approvalDecisionId,
        priorRevision: head.revision,
        resultingRevision: head.revision + 1,
        evidenceDigest,
        canaryPolicy: input.canaryPolicy ?? {},
        requiredCapabilities: version?.requiredToolCapabilities ?? [],
        eventHash,
        reason: input.reason,
        createdBy: input.actor.id,
      },
    })
    const changed = await tx.agentWorkflowActivationHead.updateMany({
      where: { id: head.id, revision: head.revision },
      data: {
        activeVersionId: version?.id ?? null,
        activationEventId: event.id,
        revision: { increment: 1 },
        selectedRunCount: 0,
      },
    })
    if (changed.count !== 1)
      throw new AgentWorkflowActivationError('CONFLICT', 'Transition CAS lost')
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: 'PLATFORM_ADMIN',
        action: input.kind === 'REVOKE' ? 'agent-workflow.revoked' : 'agent-workflow.rolled-back',
        targetType: 'AgentWorkflowActivationEvent',
        targetId: event.id,
        afterState: {
          venueId: input.venueId,
          registryKey: input.registryKey,
          resultingVersionId: version?.id ?? null,
        },
      },
      tx,
    )
    return { event, replayed: false as const }
  })
}
