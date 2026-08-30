import { z } from 'zod'

import { MachineActorContext } from '@pathfinder/contracts/actor'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type AgentImprovementProposalActionClient = Pick<typeof db, '$transaction'>

const improvementAgentActor = MachineActorContext.superRefine((actor, context) => {
  if (actor.capability !== 'agent-improvements:propose') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capability'],
      message: 'The exact agent-improvements:propose capability is required.',
    })
  }
  if (!actor.idempotencyKey) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['idempotencyKey'],
      message: 'Agent improvement proposals require an idempotency key.',
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

const inputSchema = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    agentIdentityId: z.string().trim().min(1).max(191),
    outcomeObservationIds: z.array(z.string().trim().min(1).max(191)).min(1).max(50),
    proposalKey: z
      .string()
      .trim()
      .min(1)
      .max(191)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Proposal key must be lowercase kebab-case.'),
    revision: z.number().int().min(1).max(10_000),
    supersedesProposalId: z.string().trim().min(1).max(191).optional(),
    targetKind: z.enum([
      'INSTRUCTIONS',
      'ROUTING',
      'RETRIEVAL',
      'SKILL',
      'WORKFLOW',
      'TOOLING',
      'MODEL_SELECTION',
    ]),
    title: z.string().trim().min(3).max(191),
    hypothesis: z.string().trim().min(10).max(2000),
    proposedChange: z.string().trim().min(10).max(10000),
    validationPlan: z.string().trim().min(10).max(5000),
    actor: z.union([humanPlatformAdmin, improvementAgentActor]),
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.outcomeObservationIds).size !== input.outcomeObservationIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcomeObservationIds'],
        message: 'Outcome evidence IDs must be unique.',
      })
    }
    if (input.revision === 1 && input.supersedesProposalId !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supersedesProposalId'],
        message: 'The first revision cannot supersede another proposal.',
      })
    }
    if (input.revision > 1 && input.supersedesProposalId === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supersedesProposalId'],
        message: 'A later revision must identify the proposal it supersedes.',
      })
    }
  })

export type PrepareAgentImprovementProposalInput = z.input<typeof inputSchema>

export class AgentImprovementProposalActionError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'AgentImprovementProposalActionError'
  }
}

const proposalSelect = {
  id: true,
  operationId: true,
  tenantId: true,
  venueId: true,
  agentIdentityId: true,
  approvalRequestId: true,
  proposalKey: true,
  revision: true,
  supersedesProposalId: true,
  taskClass: true,
  targetKind: true,
  title: true,
  hypothesis: true,
  proposedChange: true,
  validationPlan: true,
  baselineSnapshot: true,
  createdByType: true,
  createdById: true,
  createdAt: true,
  evidence: {
    orderBy: { outcomeObservationId: 'asc' as const },
    select: { outcomeObservationId: true },
  },
  approvalRequest: {
    select: {
      id: true,
      riskCategory: true,
      decision: { select: { decision: true, createdAt: true } },
    },
  },
} as const

type NormalizedInput = z.output<typeof inputSchema>

function actorId(input: NormalizedInput): string {
  return input.actor.type === 'HUMAN' ? input.actor.id : input.actor.actorId
}

function sortedEvidenceIds(input: NormalizedInput): string[] {
  return [...input.outcomeObservationIds].sort()
}

function sameProposal(
  existing: {
    venueId: string
    agentIdentityId: string
    proposalKey: string
    revision: number
    supersedesProposalId: string | null
    targetKind: string
    title: string
    hypothesis: string
    proposedChange: string
    validationPlan: string
    createdByType: string
    createdById: string
    evidence: { outcomeObservationId: string }[]
  },
  input: NormalizedInput,
): boolean {
  return (
    existing.venueId === input.venueId &&
    existing.agentIdentityId === input.agentIdentityId &&
    existing.proposalKey === input.proposalKey &&
    existing.revision === input.revision &&
    existing.supersedesProposalId === (input.supersedesProposalId ?? null) &&
    existing.targetKind === input.targetKind &&
    existing.title === input.title &&
    existing.hypothesis === input.hypothesis &&
    existing.proposedChange === input.proposedChange &&
    existing.validationPlan === input.validationPlan &&
    existing.createdByType === input.actor.type &&
    existing.createdById === actorId(input) &&
    JSON.stringify(existing.evidence.map((item) => item.outcomeObservationId)) ===
      JSON.stringify(sortedEvidenceIds(input))
  )
}

function isUniqueConflict(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002',
  )
}

function baselineSnapshot(
  observations: Array<{
    verdict: 'POSITIVE' | 'MIXED' | 'NEGATIVE' | 'INCONCLUSIVE'
    signalKind: string
    modelProvider: string | null
    modelName: string | null
    createdAt: Date
  }>,
) {
  const verdictCounts = { POSITIVE: 0, MIXED: 0, NEGATIVE: 0, INCONCLUSIVE: 0 }
  const signalKinds = new Set<string>()
  const modelConfigurations = new Set<string>()
  for (const observation of observations) {
    verdictCounts[observation.verdict] += 1
    signalKinds.add(observation.signalKind)
    modelConfigurations.add(
      observation.modelProvider && observation.modelName
        ? `${observation.modelProvider}/${observation.modelName}`
        : 'unrecorded',
    )
  }
  const timestamps = observations.map((item) => item.createdAt.getTime())
  return {
    contractVersion: 1,
    observationCount: observations.length,
    verdictCounts,
    signalKinds: [...signalKinds].sort(),
    modelConfigurations: [...modelConfigurations].sort(),
    observedFrom: new Date(Math.min(...timestamps)).toISOString(),
    observedThrough: new Date(Math.max(...timestamps)).toISOString(),
    interpretation: 'descriptive-evidence-only',
  }
}

/**
 * Creates an immutable, evidence-backed improvement hypothesis and a normal
 * human approval request. Approval accepts the proposal for separate work; it
 * never changes instructions, routing, models, tools, policy, or run authority.
 */
export async function prepareAgentImprovementProposalAction(
  rawInput: PrepareAgentImprovementProposalInput,
  client: AgentImprovementProposalActionClient = db,
) {
  const parsed = inputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new AgentImprovementProposalActionError(
      'INVALID_INPUT',
      parsed.error.issues[0]?.message ?? 'Agent improvement proposal input is invalid.',
    )
  }
  const input = parsed.data

  const attempt = () =>
    client.$transaction(async (transaction) => {
      const existing = await transaction.agentImprovementProposal.findFirst({
        where: { tenantId: input.tenantId, operationId: input.operationId },
        select: proposalSelect,
      })
      if (existing) {
        if (!sameProposal(existing, input)) {
          throw new AgentImprovementProposalActionError(
            'CONFLICT',
            'Improvement proposal operation ID was already used for different content or evidence.',
          )
        }
        return { ...existing, replayed: true as const }
      }

      const [identity, observations] = await Promise.all([
        transaction.agentIdentity.findFirst({
          where: { id: input.agentIdentityId, tenantId: input.tenantId },
          select: { id: true },
        }),
        transaction.agentOutcomeObservation.findMany({
          where: {
            id: { in: input.outcomeObservationIds },
            tenantId: input.tenantId,
            venueId: input.venueId,
            agentIdentityId: input.agentIdentityId,
          },
          orderBy: { id: 'asc' },
          select: {
            id: true,
            taskClass: true,
            verdict: true,
            signalKind: true,
            modelProvider: true,
            modelName: true,
            createdAt: true,
          },
        }),
      ])
      if (!identity) {
        throw new AgentImprovementProposalActionError(
          'NOT_FOUND',
          'The target agent identity was not found in this tenant.',
        )
      }
      if (observations.length !== input.outcomeObservationIds.length) {
        throw new AgentImprovementProposalActionError(
          'NOT_FOUND',
          'One or more outcome observations were not found in the exact target scope.',
        )
      }
      const taskClasses = new Set(observations.map((observation) => observation.taskClass))
      if (taskClasses.size !== 1) {
        throw new AgentImprovementProposalActionError(
          'INVALID_INPUT',
          'One proposal must target exactly one task class.',
        )
      }
      if (!observations.some((item) => item.verdict === 'MIXED' || item.verdict === 'NEGATIVE')) {
        throw new AgentImprovementProposalActionError(
          'INVALID_INPUT',
          'An improvement proposal requires at least one mixed or negative observation.',
        )
      }
      const taskClass = observations[0]!.taskClass

      let requesterAgentRunId: string | null = null
      let requesterAgentIdentityId = input.agentIdentityId
      if (input.actor.type === 'AGENT') {
        const requester = await transaction.agentIdentity.findFirst({
          where: {
            id: input.actor.agentIdentityId,
            tenantId: input.tenantId,
            enabled: true,
            accessCapabilities: { has: 'agent-improvements:propose' },
            OR: [
              { accessScope: { in: ['CLIENT', 'PLATFORM'] } },
              { accessScope: 'VENUE', venueId: input.venueId },
            ],
          },
          select: { id: true },
        })
        const run = requester
          ? await transaction.agentRun.findFirst({
              where: {
                id: input.actor.agentRunId,
                tenantId: input.tenantId,
                venueId: input.venueId,
                agentIdentityId: requester.id,
                status: 'RUNNING',
              },
              select: { id: true, requestedOperation: true },
            })
          : null
        if (!requester || !run) {
          throw new AgentImprovementProposalActionError(
            'NOT_FOUND',
            'The proposing agent identity or running task was not found in the exact authorized scope.',
          )
        }
        requesterAgentIdentityId = requester.id
        requesterAgentRunId = run.id
      }

      let supersedesProposalId: string | null = null
      if (input.supersedesProposalId) {
        const predecessor = await transaction.agentImprovementProposal.findFirst({
          where: {
            id: input.supersedesProposalId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            agentIdentityId: input.agentIdentityId,
            proposalKey: input.proposalKey,
            revision: input.revision - 1,
            taskClass,
          },
          select: { id: true },
        })
        if (!predecessor) {
          throw new AgentImprovementProposalActionError(
            'NOT_FOUND',
            'The immediately preceding proposal revision was not found in the exact target scope.',
          )
        }
        supersedesProposalId = predecessor.id
      }

      const approvalRequest = await transaction.approvalRequest.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentIdentityId: requesterAgentIdentityId,
          agentRunId: requesterAgentRunId,
          requestedByType: input.actor.type,
          requestedById: actorId(input),
          proposedAction: 'torchiko.agent-improvement.review-proposal',
          scopeSnapshot: {
            contractVersion: 1,
            proposalKey: input.proposalKey,
            revision: input.revision,
            targetKind: input.targetKind,
            taskClass,
            outcomeEvidenceCount: observations.length,
            executionTriggeredByDecision: false,
          },
          reason: input.hypothesis,
          riskCategory: 'MEDIUM',
          artifacts: observations.map((observation) => ({
            type: 'AgentOutcomeObservation',
            id: observation.id,
          })),
        },
        select: { id: true },
      })

      const proposal = await transaction.agentImprovementProposal.create({
        data: {
          operationId: input.operationId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentIdentityId: input.agentIdentityId,
          approvalRequestId: approvalRequest.id,
          proposalKey: input.proposalKey,
          revision: input.revision,
          supersedesProposalId,
          taskClass,
          targetKind: input.targetKind,
          title: input.title,
          hypothesis: input.hypothesis,
          proposedChange: input.proposedChange,
          validationPlan: input.validationPlan,
          baselineSnapshot: baselineSnapshot(observations),
          createdByType: input.actor.type,
          createdById: actorId(input),
          evidence: {
            create: observations.map((observation) => ({
              outcomeObservationId: observation.id,
            })),
          },
        },
        select: proposalSelect,
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
            requestedOperation: 'agent-improvement.propose',
            actionName: 'torchiko.agent_improvements.propose',
            inputSummary: `Prepare ${input.proposalKey} revision ${input.revision} for human review.`,
            inputReference: `AgentImprovementProposal:${proposal.id}`,
            output: {
              proposalId: proposal.id,
              approvalRequestId: approvalRequest.id,
              executionTriggered: false,
            },
            modelProvider: input.actor.modelProvider ?? null,
            modelName: input.actor.modelName ?? null,
            status: 'SUCCEEDED',
            afterVersionRef: `AgentImprovementProposal:${proposal.id}:PENDING_REVIEW`,
          },
          select: { id: true },
        })
        const transitioned = await transaction.agentRun.updateMany({
          where: {
            id: input.actor.agentRunId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            status: 'RUNNING',
          },
          data: { status: 'AWAITING_APPROVAL' },
        })
        if (transitioned.count !== 1) {
          throw new AgentImprovementProposalActionError(
            'CONFLICT',
            'The proposing agent run changed before review evidence was recorded.',
          )
        }
        await transaction.agentTimelineEvent.create({
          data: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            agentRunId: input.actor.agentRunId,
            agentActionId: action.id,
            actorType: 'AGENT',
            actorId: input.actor.actorId,
            eventType: 'agent-improvement.awaiting-approval',
            message: 'An evidence-backed improvement proposal is waiting for human review.',
            data: {
              proposalId: proposal.id,
              approvalRequestId: approvalRequest.id,
              executionTriggered: false,
            },
          },
        })
      }

      await writeAuditLogStrict(
        input.actor.type === 'AGENT'
          ? {
              tenantId: input.tenantId,
              actor: input.actor,
              action: 'agent-improvement.proposal-prepared',
              targetType: 'AgentImprovementProposal',
              targetId: proposal.id,
              sourceReferences: observations.map((observation) => ({
                type: 'AgentOutcomeObservation',
                id: observation.id,
              })),
              afterState: {
                venueId: input.venueId,
                agentIdentityId: input.agentIdentityId,
                taskClass,
                proposalKey: input.proposalKey,
                revision: input.revision,
                targetKind: input.targetKind,
                approvalRequestId: approvalRequest.id,
                executionTriggered: false,
              },
            }
          : {
              tenantId: input.tenantId,
              actorId: input.actor.id,
              actorRole: input.actor.role,
              action: 'agent-improvement.proposal-prepared',
              targetType: 'AgentImprovementProposal',
              targetId: proposal.id,
              sourceReferences: observations.map((observation) => ({
                type: 'AgentOutcomeObservation',
                id: observation.id,
              })),
              afterState: {
                venueId: input.venueId,
                agentIdentityId: input.agentIdentityId,
                taskClass,
                proposalKey: input.proposalKey,
                revision: input.revision,
                targetKind: input.targetKind,
                approvalRequestId: approvalRequest.id,
                executionTriggered: false,
              },
            },
        transaction,
      )

      return { ...proposal, replayed: false as const }
    })

  try {
    return await attempt()
  } catch (error) {
    if (error instanceof AgentImprovementProposalActionError || !isUniqueConflict(error)) {
      throw error
    }
    return client.$transaction(async (transaction) => {
      const existing = await transaction.agentImprovementProposal.findFirst({
        where: { tenantId: input.tenantId, operationId: input.operationId },
        select: proposalSelect,
      })
      if (existing && sameProposal(existing, input)) {
        return { ...existing, replayed: true as const }
      }
      throw new AgentImprovementProposalActionError(
        'CONFLICT',
        'Improvement proposal changed concurrently; refresh before retrying.',
      )
    })
  }
}
