import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { InputJsonValue } from '@prisma/client/runtime/library'
import { AgentWorkflowCanaryPolicySchema } from '@pathfinder/contracts/agent-workflow-activation'
import { AgentWorkflowPromotionAssessmentDiagnosticsSchema } from '@pathfinder/contracts/agent-workflow-promotion-assessment'
import { db } from '../client'
import { isAgentWorkflowArtifactIntact } from './agent-workflow-registry-actions'
import { revalidateAgentWorkflowPromotionAssessment } from './agent-workflow-promotion-assessment-actions'
import {
  AgentWorkflowActivationError,
  agentWorkflowActivationApprovalReceipt,
  agentWorkflowTransitionApprovalReceipt,
  agentWorkflowTransitionEvidenceDigest,
} from './agent-workflow-activation-actions'

const actor = z
  .object({
    type: z.literal('HUMAN'),
    id: z.string().min(1).max(191),
    role: z.literal('PLATFORM_ADMIN'),
  })
  .strict()
const base = z
  .object({
    requestOperationId: z.string().uuid(),
    tenantId: z.string().min(1).max(191),
    venueId: z.string().min(1).max(191),
    agentIdentityId: z.string().min(1).max(191),
    registryKey: z.string().min(1).max(191),
    expectedHeadRevision: z.number().int().min(0),
    reason: z.string().trim().min(1).max(2000),
    actor,
  })
  .strict()
const activation = base
  .extend({
    workflowVersionId: z.string().uuid(),
    promotionAssessmentId: z.string().min(1).max(191),
    canaryPolicy: AgentWorkflowCanaryPolicySchema,
  })
  .strict()
const transition = base
  .extend({
    kind: z.enum(['ROLLBACK', 'REVOKE']),
    workflowVersionId: z.string().uuid().optional(),
    canaryPolicy: AgentWorkflowCanaryPolicySchema.optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      (v.kind === 'ROLLBACK' && (!v.workflowVersionId || !v.canaryPolicy)) ||
      (v.kind === 'REVOKE' && (v.workflowVersionId || v.canaryPolicy))
    )
      c.addIssue({ code: 'custom', message: 'Invalid transition receipt.' })
  })
const stable = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const requestId = (tenantId: string, operationId: string) =>
  `workflow-approval-${stable([tenantId, operationId]).slice(0, 40)}`
type Client = Pick<typeof db, '$transaction'>
type Tx = Parameters<Parameters<Client['$transaction']>[0]>[0]
type ApprovalInput = z.output<typeof activation> | z.output<typeof transition>

async function persist(
  tx: Tx,
  input: ApprovalInput,
  action: string,
  scopeSnapshot: InputJsonValue,
) {
  const id = requestId(input.tenantId, input.requestOperationId)
  const fingerprint = stable({
    input: { ...input, actor: undefined },
    actorId: input.actor.id,
    action,
  })
  const identity = await tx.agentIdentity.findFirst({
    where: {
      id: input.agentIdentityId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      enabled: true,
    },
    select: { id: true },
  })
  if (!identity)
    throw new AgentWorkflowActivationError('NOT_FOUND', 'Scoped agent identity was not found')
  const request = await tx.approvalRequest.create({
    data: {
      id,
      tenantId: input.tenantId,
      venueId: input.venueId,
      agentIdentityId: identity.id,
      requestedByType: 'HUMAN',
      requestedById: input.actor.id,
      proposedAction: action,
      scopeSnapshot,
      reason: input.reason,
      riskCategory: 'HIGH',
      artifacts: [{ kind: 'WORKFLOW_APPROVAL_REQUEST', fingerprint }],
    },
  })
  return { request, replayed: false as const }
}

async function lockAndReplay(tx: Tx, input: ApprovalInput, action: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`workflow-approval:${input.tenantId}:${input.requestOperationId}`}, 0))`
  const existing = await tx.approvalRequest.findFirst({
    where: { id: requestId(input.tenantId, input.requestOperationId), tenantId: input.tenantId },
  })
  if (!existing) return null
  const fingerprint = stable({
    input: { ...input, actor: undefined },
    actorId: input.actor.id,
    action,
  })
  if (
    existing.requestedById !== input.actor.id ||
    existing.proposedAction !== action ||
    stable(existing.artifacts) !== stable([{ kind: 'WORKFLOW_APPROVAL_REQUEST', fingerprint }])
  )
    throw new AgentWorkflowActivationError('CONFLICT', 'Workflow approval request replay conflict')
  return { request: existing, replayed: true as const }
}

export async function requestAgentWorkflowActivationApproval(
  raw: z.input<typeof activation>,
  available: ReadonlySet<string>,
  client: Client = db,
) {
  const input = activation.parse(raw)
  return client.$transaction(async (tx) => {
    const replay = await lockAndReplay(tx, input, 'agent-workflow.activate')
    if (replay) return replay
    const head = await tx.agentWorkflowActivationHead.findFirst({
      where: { tenantId: input.tenantId, venueId: input.venueId, registryKey: input.registryKey },
    })
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
    if (
      !version ||
      !isAgentWorkflowArtifactIntact(version) ||
      version.requiredToolCapabilities.some((x) => !available.has(x))
    )
      throw new AgentWorkflowActivationError('FORBIDDEN', 'Workflow is unavailable')
    const checked = await revalidateAgentWorkflowPromotionAssessment(tx, {
      tenantId: input.tenantId,
      venueId: input.venueId,
      workflowVersionId: input.workflowVersionId,
      assessmentId: input.promotionAssessmentId,
    })
    const diagnostics = AgentWorkflowPromotionAssessmentDiagnosticsSchema.safeParse(
      checked.assessment.diagnostics,
    )
    if (
      !diagnostics.success ||
      checked.assessment.outcome !== 'EVIDENCE_READY_REVIEW_REQUIRED' ||
      diagnostics.data.autonomousPromotionEligible ||
      input.canaryPolicy.supportedActionClasses.some((value) =>
        ['AGENT_DELEGATION', 'OPERATOR_QUESTION', 'BILLING_PROPOSAL'].includes(value),
      )
    )
      throw new AgentWorkflowActivationError(
        'CONFLICT',
        'Assessment is not eligible for explicit activation review',
      )
    return persist(
      tx,
      input,
      'agent-workflow.activate',
      agentWorkflowActivationApprovalReceipt(input, checked.evidenceDigest),
    )
  })
}

export async function requestAgentWorkflowTransitionApproval(
  raw: z.input<typeof transition>,
  available: ReadonlySet<string>,
  client: Client = db,
) {
  const input = transition.parse(raw)
  if (
    input.canaryPolicy?.supportedActionClasses.some((value) =>
      ['AGENT_DELEGATION', 'OPERATOR_QUESTION', 'BILLING_PROPOSAL'].includes(value),
    )
  )
    throw new AgentWorkflowActivationError(
      'FORBIDDEN',
      'Transition includes an unsupported effect class',
    )
  return client.$transaction(async (tx) => {
    const action = `agent-workflow.${input.kind.toLowerCase()}`
    const replay = await lockAndReplay(tx, input, action)
    if (replay) return replay
    const head = await tx.agentWorkflowActivationHead.findFirst({
      where: { tenantId: input.tenantId, venueId: input.venueId, registryKey: input.registryKey },
    })
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
    if (
      input.kind === 'ROLLBACK' &&
      (!version ||
        !isAgentWorkflowArtifactIntact(version) ||
        version.requiredToolCapabilities.some((x) => !available.has(x)))
    )
      throw new AgentWorkflowActivationError('FORBIDDEN', 'Rollback workflow is unavailable')
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
      throw new AgentWorkflowActivationError('NOT_FOUND', 'Rollback lineage was not found')
    const receipt0 = {
      kind: input.kind,
      registryKey: input.registryKey,
      workflowVersionId: input.workflowVersionId ?? null,
      expectedHeadRevision: input.expectedHeadRevision,
      canaryPolicy: input.canaryPolicy ?? null,
    }
    const evidenceDigest = agentWorkflowTransitionEvidenceDigest(
      receipt0,
      head.activationEventId,
      lineage?.eventHash ?? null,
    )
    return persist(tx, input, action, agentWorkflowTransitionApprovalReceipt(input, evidenceDigest))
  })
}
