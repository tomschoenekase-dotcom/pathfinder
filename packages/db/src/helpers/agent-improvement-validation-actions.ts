import { createHash } from 'node:crypto'

import { z } from 'zod'

import { MachineActorContext } from '@pathfinder/contracts/actor'
import { canonicalEvaluationJson } from '@pathfinder/contracts/evaluation'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { compareEvaluationRuns } from './evaluation-run-comparison'

export type AgentImprovementValidationActionClient = Pick<typeof db, '$transaction'>

const validatingAgentActor = MachineActorContext.superRefine((actor, context) => {
  if (actor.capability !== 'agent-improvements:validate') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capability'],
      message: 'The exact agent-improvements:validate capability is required.',
    })
  }
  if (!actor.idempotencyKey) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['idempotencyKey'],
      message: 'Agent improvement validation evidence requires an idempotency key.',
    })
  }
  if ((actor.modelProvider === undefined) !== (actor.modelName === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['modelProvider'],
      message: 'Model provider and model name must be supplied together.',
    })
  }
})

const humanPlatformAdmin = z
  .object({
    type: z.literal('HUMAN'),
    id: z.string().trim().min(1).max(191),
    role: z.literal('PLATFORM_ADMIN'),
  })
  .strict()

const changeDimension = z.enum(['CONTENT', 'MODEL', 'CONFIG'])
const inputSchema = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    proposalId: z.string().trim().min(1).max(191),
    baselineEvalRunId: z.string().uuid(),
    candidateEvalRunId: z.string().uuid(),
    implementationKind: z.enum([
      'CODE_COMMIT',
      'CONFIG_VERSION',
      'PROMPT_VERSION',
      'SKILL_VERSION',
      'WORKFLOW_VERSION',
      'TOOL_VERSION',
      'MODEL_POLICY_VERSION',
    ]),
    implementationRef: z.string().trim().min(1).max(500),
    implementationVersion: z.string().trim().min(1).max(191).optional(),
    implementationHash: z.string().regex(/^[0-9a-f]{64}$/),
    changeDimensions: z.array(changeDimension).min(1).max(3),
    actor: z.union([humanPlatformAdmin, validatingAgentActor]),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.baselineEvalRunId === input.candidateEvalRunId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['candidateEvalRunId'],
        message: 'Baseline and candidate evaluation runs must be different.',
      })
    }
    if (new Set(input.changeDimensions).size !== input.changeDimensions.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['changeDimensions'],
        message: 'Declared change dimensions must be unique.',
      })
    }
  })

export type RecordAgentImprovementValidationInput = z.input<typeof inputSchema>

export class AgentImprovementValidationActionError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'AgentImprovementValidationActionError'
  }
}

const validationSelect = {
  id: true,
  operationId: true,
  tenantId: true,
  venueId: true,
  proposalId: true,
  approvalDecisionId: true,
  baselineEvalRunId: true,
  candidateEvalRunId: true,
  implementationKind: true,
  implementationRef: true,
  implementationVersion: true,
  implementationHash: true,
  changeDimensions: true,
  comparisonSnapshot: true,
  comparisonHash: true,
  recordedByType: true,
  recordedById: true,
  createdAt: true,
} as const

type NormalizedInput = z.output<typeof inputSchema>

function actorId(input: NormalizedInput) {
  return input.actor.type === 'HUMAN' ? input.actor.id : input.actor.actorId
}

function dimensions(input: NormalizedInput) {
  return [...input.changeDimensions].sort()
}

function sameValidation(existing: Record<string, unknown>, input: NormalizedInput) {
  return (
    existing.venueId === input.venueId &&
    existing.proposalId === input.proposalId &&
    existing.baselineEvalRunId === input.baselineEvalRunId &&
    existing.candidateEvalRunId === input.candidateEvalRunId &&
    existing.implementationKind === input.implementationKind &&
    existing.implementationRef === input.implementationRef &&
    existing.implementationVersion === (input.implementationVersion ?? null) &&
    existing.implementationHash === input.implementationHash &&
    JSON.stringify(existing.changeDimensions) === JSON.stringify(dimensions(input)) &&
    existing.recordedByType === input.actor.type &&
    existing.recordedById === actorId(input)
  )
}

function isUniqueConflict(error: unknown) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002',
  )
}

function comparisonHash(snapshot: unknown) {
  return createHash('sha256')
    .update(canonicalEvaluationJson(snapshot as never))
    .digest('hex')
}

/**
 * Records immutable proof for an already human-approved improvement proposal.
 * This action never applies the referenced implementation, changes policy, or
 * grants authority; it only binds an immutable reference to comparable evidence.
 */
export async function recordAgentImprovementValidationAction(
  rawInput: RecordAgentImprovementValidationInput,
  client: AgentImprovementValidationActionClient = db,
) {
  const parsed = inputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new AgentImprovementValidationActionError(
      'INVALID_INPUT',
      parsed.error.issues[0]?.message ?? 'Agent improvement validation input is invalid.',
    )
  }
  const input = parsed.data

  const attempt = () =>
    client.$transaction(async (transaction) => {
      const replay = await transaction.agentImprovementValidationEvidence.findFirst({
        where: { tenantId: input.tenantId, operationId: input.operationId },
        select: validationSelect,
      })
      if (replay) {
        if (!sameValidation(replay as unknown as Record<string, unknown>, input)) {
          throw new AgentImprovementValidationActionError(
            'CONFLICT',
            'The operation ID already belongs to different validation evidence.',
          )
        }
        return { ...replay, replayed: true }
      }

      const proposal = await transaction.agentImprovementProposal.findFirst({
        where: { id: input.proposalId, tenantId: input.tenantId, venueId: input.venueId },
        select: {
          id: true,
          agentIdentityId: true,
          taskClass: true,
          approvalRequest: {
            select: {
              decision: { select: { id: true, decision: true } },
            },
          },
        },
      })
      if (!proposal) {
        throw new AgentImprovementValidationActionError(
          'NOT_FOUND',
          'Improvement proposal not found in the exact tenant and venue scope.',
        )
      }
      if (proposal.approvalRequest.decision?.decision !== 'APPROVED') {
        throw new AgentImprovementValidationActionError(
          'CONFLICT',
          'Validation evidence requires an explicitly approved proposal.',
        )
      }

      if (input.actor.type === 'AGENT') {
        const now = new Date()
        const identity = await transaction.agentIdentity.findFirst({
          where: {
            id: input.actor.agentIdentityId,
            tenantId: input.tenantId,
            enabled: true,
            accessCapabilities: { has: 'agent-improvements:validate' },
            OR: [
              { accessScope: { in: ['CLIENT', 'PLATFORM'] } },
              { accessScope: 'VENUE', venueId: input.venueId },
            ],
          },
          select: { id: true },
        })
        const run = await transaction.agentRun.findFirst({
          where: {
            id: input.actor.agentRunId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            agentIdentityId: input.actor.agentIdentityId,
            executionWorkerId: input.actor.workerId,
            status: 'RUNNING',
            executionLeaseExpiresAt: { gt: now },
            requestedOperation: 'agent-improvement.validate',
          },
          select: { id: true },
        })
        if (!identity || !run) {
          throw new AgentImprovementValidationActionError(
            'NOT_FOUND',
            'Authorized validation agent identity or live run was not found.',
          )
        }
      }

      const runs = await transaction.evalRun.findMany({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          id: { in: [input.baselineEvalRunId, input.candidateEvalRunId] },
        },
        select: { id: true, status: true },
      })
      if (runs.length !== 2 || runs.some((run) => run.status !== 'COMPLETED')) {
        throw new AgentImprovementValidationActionError(
          'NOT_FOUND',
          'Two completed evaluation runs are required in the exact tenant and venue scope.',
        )
      }

      const comparison = await compareEvaluationRuns(
        {
          tenantId: input.tenantId,
          venueId: input.venueId,
          baselineRunId: input.baselineEvalRunId,
          candidateRunId: input.candidateEvalRunId,
          allowedMismatchReasons: dimensions(input),
        },
        transaction,
      )
      if (comparison.status === 'INCOMPARABLE') {
        throw new AgentImprovementValidationActionError(
          'CONFLICT',
          `Evaluation evidence is incomparable: ${comparison.mismatchReasons.join(', ')}.`,
        )
      }
      const snapshot = {
        contractVersion: 1,
        interpretation: 'evidence-only-no-promotion-threshold',
        ...comparison,
      }

      const saved = await transaction.agentImprovementValidationEvidence.create({
        data: {
          operationId: input.operationId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          proposalId: proposal.id,
          approvalDecisionId: proposal.approvalRequest.decision.id,
          baselineEvalRunId: input.baselineEvalRunId,
          candidateEvalRunId: input.candidateEvalRunId,
          implementationKind: input.implementationKind,
          implementationRef: input.implementationRef,
          ...(input.implementationVersion
            ? { implementationVersion: input.implementationVersion }
            : {}),
          implementationHash: input.implementationHash,
          changeDimensions: dimensions(input),
          comparisonSnapshot: snapshot,
          comparisonHash: comparisonHash(snapshot),
          recordedByType: input.actor.type,
          recordedById: actorId(input),
        },
        select: validationSelect,
      })

      if (input.actor.type === 'AGENT') {
        const action = await transaction.agentAction.create({
          data: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            agentRunId: input.actor.agentRunId,
            agentIdentityId: input.actor.agentIdentityId,
            actorType: 'AGENT',
            actorId: input.actor.actorId,
            requestedOperation: 'agent-improvement.validate',
            actionName: 'torchiko.agent_improvements.record_validation',
            inputSummary: `Record validation evidence for proposal ${proposal.id}.`,
            inputReference: `AgentImprovementProposal:${proposal.id}`,
            output: {
              validationEvidenceId: saved.id,
              comparisonHash: saved.comparisonHash,
              behaviorChanged: false,
              authorityChanged: false,
            },
            ...(input.actor.modelProvider && input.actor.modelName
              ? { modelProvider: input.actor.modelProvider, modelName: input.actor.modelName }
              : {}),
            costE8Usd: 0,
            status: 'SUCCEEDED',
            beforeVersionRef: `EvalRun:${input.baselineEvalRunId}`,
            afterVersionRef: `EvalRun:${input.candidateEvalRunId}`,
          },
          select: { id: true },
        })
        await transaction.agentTimelineEvent.create({
          data: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            agentRunId: input.actor.agentRunId,
            agentActionId: action.id,
            actorType: 'AGENT',
            actorId: input.actor.actorId,
            eventType: 'agent-improvement.validation-recorded',
            message: 'Immutable before/after validation evidence was recorded without promotion.',
            data: { validationEvidenceId: saved.id, behaviorChanged: false },
          },
        })
      }

      await writeAuditLogStrict(
        input.actor.type === 'AGENT'
          ? {
              tenantId: input.tenantId,
              actor: input.actor,
              action: 'agent-improvement.validation-recorded',
              targetType: 'AgentImprovementValidationEvidence',
              targetId: saved.id,
              sourceReferences: [
                { type: 'AgentImprovementProposal', id: proposal.id },
                { type: 'EvalRun', id: input.baselineEvalRunId },
                { type: 'EvalRun', id: input.candidateEvalRunId },
              ],
              afterState: {
                comparisonHash: saved.comparisonHash,
                behaviorChanged: false,
                authorityChanged: false,
              },
            }
          : {
              tenantId: input.tenantId,
              actorId: input.actor.id,
              actorRole: input.actor.role,
              action: 'agent-improvement.validation-recorded',
              targetType: 'AgentImprovementValidationEvidence',
              targetId: saved.id,
              sourceReferences: [
                { type: 'AgentImprovementProposal', id: proposal.id },
                { type: 'EvalRun', id: input.baselineEvalRunId },
                { type: 'EvalRun', id: input.candidateEvalRunId },
              ],
              afterState: {
                comparisonHash: saved.comparisonHash,
                behaviorChanged: false,
                authorityChanged: false,
              },
            },
        transaction,
      )

      return { ...saved, replayed: false }
    })

  try {
    return await attempt()
  } catch (error) {
    if (!isUniqueConflict(error)) throw error
    const replay = await client.$transaction((transaction) =>
      transaction.agentImprovementValidationEvidence.findFirst({
        where: { tenantId: input.tenantId, operationId: input.operationId },
        select: validationSelect,
      }),
    )
    if (replay && sameValidation(replay as unknown as Record<string, unknown>, input)) {
      return { ...replay, replayed: true }
    }
    throw new AgentImprovementValidationActionError(
      'CONFLICT',
      'Validation evidence changed concurrently; refresh before retrying.',
    )
  }
}
