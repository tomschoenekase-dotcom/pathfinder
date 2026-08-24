import { createHash } from 'node:crypto'
import { z } from 'zod'

import {
  OPERATIONAL_UPDATE_DRAFT_POLICY_ACTION,
  OPERATIONAL_UPDATE_DRAFT_POLICY_CAPABILITY,
  OperationalUpdateDraftPolicyConstraints,
  OperationalUpdateDraftPolicyParameters,
} from '@pathfinder/contracts'
import type { MachineActorContext } from '@pathfinder/contracts/actor'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type ApprovalGrantHumanActor = {
  type: 'HUMAN'
  id: string
  role: 'PLATFORM_ADMIN'
}

type ApprovalGrantClient = Pick<typeof db, '$transaction'>

type GrantMode = 'ONE_SHOT' | 'BOUNDED' | 'TEMPORARY' | 'POLICY_BACKED'

const grantOperationId = z.string().uuid()
const grantPolicyKey = z
  .string()
  .trim()
  .min(1)
  .max(191)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
const grantIssueReason = z.string().trim().min(3).max(2000)

export class ApprovalGrantActionError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'INVALID_INPUT'
      | 'CONFLICT'
      | 'FORBIDDEN'
      | 'EXPIRED'
      | 'REVOKED'
      | 'EXHAUSTED'
      | 'PARAMETER_MISMATCH'
      | 'POLICY_UNAVAILABLE',
    message: string,
  ) {
    super(message)
    this.name = 'ApprovalGrantActionError'
  }
}

function canonicalize(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Approval parameters must contain finite numbers')
    return value
  }
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, seen))
  if (typeof value === 'object') {
    if (seen.has(value)) throw new Error('Approval parameters must not contain cycles')
    seen.add(value)
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key]
      if (entry !== undefined) output[key] = canonicalize(entry, seen)
    }
    seen.delete(value)
    return output
  }
  throw new Error('Approval parameters must be JSON-compatible')
}

export function approvalParameterHash(parameters: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(parameters)))
    .digest('hex')
}

function assertHuman(actor: ApprovalGrantHumanActor) {
  if (actor.type !== 'HUMAN' || actor.role !== 'PLATFORM_ADMIN' || !actor.id) {
    throw new ApprovalGrantActionError(
      'FORBIDDEN',
      'Approval grants require a human platform administrator',
    )
  }
}

function modeRules(input: {
  mode: GrantMode
  approvalDecisionId?: string
  policyKey?: string
  parameters?: unknown
  constraints?: Record<string, unknown>
  maxUses?: number
  expiresAt?: Date
}) {
  if ((input.approvalDecisionId === undefined) === (input.policyKey === undefined)) {
    throw new ApprovalGrantActionError(
      'CONFLICT',
      'A grant requires exactly one approval decision or reviewed policy',
    )
  }
  if (input.mode === 'POLICY_BACKED' && !input.policyKey) {
    throw new ApprovalGrantActionError('CONFLICT', 'Policy-backed grants require a policy key')
  }
  if (input.mode !== 'POLICY_BACKED' && input.policyKey) {
    throw new ApprovalGrantActionError('CONFLICT', 'Only policy-backed grants may use a policy key')
  }
  if (input.mode === 'ONE_SHOT' && (input.maxUses ?? 1) !== 1) {
    throw new ApprovalGrantActionError('CONFLICT', 'One-shot grants allow exactly one use')
  }
  if (input.mode === 'TEMPORARY' && !input.expiresAt) {
    throw new ApprovalGrantActionError('CONFLICT', 'Temporary grants require an expiration')
  }
  if (input.maxUses !== undefined && (!Number.isInteger(input.maxUses) || input.maxUses < 1)) {
    throw new ApprovalGrantActionError('CONFLICT', 'Grant max uses must be a positive integer')
  }
  if (input.parameters === undefined && !Object.keys(input.constraints ?? {}).length) {
    throw new ApprovalGrantActionError(
      'CONFLICT',
      'A grant requires exact parameters or explicit constraints',
    )
  }
  if (input.mode === 'POLICY_BACKED' && input.parameters !== undefined) {
    throw new ApprovalGrantActionError(
      'CONFLICT',
      'Policy-backed grants require reviewed constraints, not exact parameters',
    )
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function validatePolicyConstraints(
  actionName: string,
  capability: string,
  constraints: Record<string, unknown>,
) {
  if (
    actionName === OPERATIONAL_UPDATE_DRAFT_POLICY_ACTION &&
    capability === OPERATIONAL_UPDATE_DRAFT_POLICY_CAPABILITY
  ) {
    const parsed = OperationalUpdateDraftPolicyConstraints.safeParse(constraints)
    if (!parsed.success) {
      throw new ApprovalGrantActionError(
        'INVALID_INPUT',
        parsed.error.issues[0]?.message ?? 'Operational-update draft policy is invalid',
      )
    }
    return parsed.data
  }
  throw new ApprovalGrantActionError(
    'POLICY_UNAVAILABLE',
    `No reviewed constraint evaluator is registered for ${actionName}`,
  )
}

function assertPolicyParameters(
  input: {
    tenantId: string
    venueId: string
    actionName: string
    capability: string
    parameters: unknown
  },
  constraints: unknown,
) {
  if (
    input.actionName !== OPERATIONAL_UPDATE_DRAFT_POLICY_ACTION ||
    input.capability !== OPERATIONAL_UPDATE_DRAFT_POLICY_CAPABILITY
  ) {
    throw new ApprovalGrantActionError(
      'POLICY_UNAVAILABLE',
      `No reviewed constraint evaluator is registered for ${input.actionName}`,
    )
  }
  const policy = OperationalUpdateDraftPolicyConstraints.safeParse(constraints)
  if (!policy.success) {
    throw new ApprovalGrantActionError(
      'POLICY_UNAVAILABLE',
      'The stored operational-update draft policy is invalid or uses an unsupported version',
    )
  }
  const parameters = OperationalUpdateDraftPolicyParameters.safeParse(input.parameters)
  if (
    !parameters.success ||
    parameters.data.clientId !== input.tenantId ||
    parameters.data.venueId !== input.venueId ||
    !policy.data.allowedUpdateTypes.includes(parameters.data.updateType) ||
    !policy.data.allowedSeverities.includes(parameters.data.severity) ||
    !policy.data.allowedPriorities.includes(parameters.data.priority) ||
    parameters.data.title.length > policy.data.maxTitleChars ||
    parameters.data.body.length > policy.data.maxBodyChars
  ) {
    throw new ApprovalGrantActionError(
      'PARAMETER_MISMATCH',
      'Action parameters are outside the reviewed operational-update draft policy',
    )
  }
}

const grantSelect = {
  id: true,
  operationId: true,
  tenantId: true,
  venueId: true,
  approvalDecisionId: true,
  policyKey: true,
  agentIdentityId: true,
  actionName: true,
  capability: true,
  mode: true,
  scope: true,
  parameterHash: true,
  constraints: true,
  issueReason: true,
  maxUses: true,
  useCount: true,
  notBefore: true,
  expiresAt: true,
  revokedAt: true,
  createdByType: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} as const

type IssueInput = {
  operationId: string
  tenantId: string
  venueId: string
  agentIdentityId: string
  actionName: string
  capability: string
  mode: GrantMode
  scope: Record<string, unknown>
  approvalDecisionId?: string
  policyKey?: string
  parameters?: unknown
  constraints?: Record<string, unknown>
  issueReason: string
  maxUses?: number
  notBefore?: Date
  expiresAt?: Date
  actor: ApprovalGrantHumanActor
}

function sameGrantIssue(
  existing: {
    approvalDecisionId: string | null
    policyKey: string | null
    venueId: string
    agentIdentityId: string
    actionName: string
    capability: string
    mode: GrantMode
    scope: unknown
    parameterHash: string | null
    constraints: unknown
    issueReason: string | null
    maxUses: number | null
    notBefore: Date
    expiresAt: Date | null
    createdByType: string
    createdById: string
  },
  input: IssueInput,
  normalized: {
    parameterHash: string | null
    constraints: Record<string, unknown>
    issueReason: string
  },
) {
  return (
    existing.approvalDecisionId === (input.approvalDecisionId ?? null) &&
    existing.policyKey === (input.policyKey ?? null) &&
    existing.venueId === input.venueId &&
    existing.agentIdentityId === input.agentIdentityId &&
    existing.actionName === input.actionName &&
    existing.capability === input.capability &&
    existing.mode === input.mode &&
    canonicalJson(existing.scope) === canonicalJson(input.scope) &&
    existing.parameterHash === normalized.parameterHash &&
    canonicalJson(existing.constraints) === canonicalJson(normalized.constraints) &&
    existing.issueReason === normalized.issueReason &&
    existing.maxUses === (input.mode === 'ONE_SHOT' ? 1 : (input.maxUses ?? null)) &&
    (input.notBefore === undefined || existing.notBefore.getTime() === input.notBefore.getTime()) &&
    existing.expiresAt?.getTime() === input.expiresAt?.getTime() &&
    existing.createdByType === 'HUMAN' &&
    existing.createdById === input.actor.id
  )
}

export async function issueApprovalGrantAction(
  input: IssueInput,
  client: ApprovalGrantClient = db,
) {
  assertHuman(input.actor)
  modeRules(input)
  const parsedOperationId = grantOperationId.safeParse(input.operationId)
  const parsedIssueReason = grantIssueReason.safeParse(input.issueReason)
  if (!parsedOperationId.success) {
    throw new ApprovalGrantActionError(
      'INVALID_INPUT',
      parsedOperationId.error.issues[0]?.message ?? 'Operation ID is invalid',
    )
  }
  if (!parsedIssueReason.success) {
    throw new ApprovalGrantActionError(
      'INVALID_INPUT',
      parsedIssueReason.error.issues[0]?.message ?? 'Issue reason is invalid',
    )
  }
  const parsedPolicyKey = input.policyKey ? grantPolicyKey.safeParse(input.policyKey) : null
  if (parsedPolicyKey && !parsedPolicyKey.success) {
    throw new ApprovalGrantActionError(
      'INVALID_INPUT',
      parsedPolicyKey.error.issues[0]?.message ?? 'Policy key is invalid',
    )
  }
  const operationId = parsedOperationId.data
  const issueReason = parsedIssueReason.data
  const policyKey = parsedPolicyKey?.success ? parsedPolicyKey.data : null
  const constraints =
    input.mode === 'POLICY_BACKED'
      ? validatePolicyConstraints(input.actionName, input.capability, input.constraints ?? {})
      : (input.constraints ?? {})
  const notBefore = input.notBefore ?? new Date()
  if (input.expiresAt && input.expiresAt <= notBefore) {
    throw new ApprovalGrantActionError('CONFLICT', 'Grant expiration must follow its start')
  }
  const parameterHash =
    input.parameters === undefined ? null : approvalParameterHash(input.parameters)
  const normalized = { parameterHash, constraints, issueReason }

  const attempt = () =>
    client.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof db
      const replay = await tx.approvalGrant.findFirst({
        where: { tenantId: input.tenantId, operationId },
        select: grantSelect,
      })
      if (replay) {
        if (!sameGrantIssue(replay, input, normalized)) {
          throw new ApprovalGrantActionError(
            'CONFLICT',
            'Approval-grant operation ID was already used for different authority',
          )
        }
        return { ...replay, replayed: true as const }
      }
      if (policyKey) {
        const activePolicy = await tx.approvalGrant.findFirst({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            agentIdentityId: input.agentIdentityId,
            actionName: input.actionName,
            policyKey,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          select: { id: true },
        })
        if (activePolicy) {
          throw new ApprovalGrantActionError(
            'CONFLICT',
            'An active policy grant already uses this policy key in the same scope',
          )
        }
      }
      if (input.approvalDecisionId) {
        const decision = await tx.approvalDecision.findFirst({
          where: {
            id: input.approvalDecisionId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            decision: 'APPROVED',
          },
          select: {
            id: true,
            grant: { select: { id: true } },
            approvalRequest: { select: { proposedAction: true, agentIdentityId: true } },
          },
        })
        if (!decision) {
          throw new ApprovalGrantActionError('NOT_FOUND', 'Approved decision not found in scope')
        }
        if (decision.grant) {
          throw new ApprovalGrantActionError('CONFLICT', 'Approval decision already has a grant')
        }
        if (
          decision.approvalRequest.proposedAction !== input.actionName ||
          decision.approvalRequest.agentIdentityId !== input.agentIdentityId
        ) {
          throw new ApprovalGrantActionError(
            'FORBIDDEN',
            'Approval decision does not authorize this action and agent',
          )
        }
      }

      const identity = await tx.agentIdentity.findFirst({
        where: {
          id: input.agentIdentityId,
          tenantId: input.tenantId,
          enabled: true,
          OR: [{ venueId: null }, { venueId: input.venueId }],
          accessCapabilities: { has: input.capability },
        },
        select: { id: true },
      })
      if (!identity) {
        throw new ApprovalGrantActionError(
          'FORBIDDEN',
          'Enabled agent identity does not hold the granted capability',
        )
      }

      const grant = await tx.approvalGrant.create({
        data: {
          operationId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          approvalDecisionId: input.approvalDecisionId ?? null,
          policyKey,
          agentIdentityId: input.agentIdentityId,
          actionName: input.actionName,
          capability: input.capability,
          mode: input.mode,
          scope: input.scope,
          parameterHash,
          constraints,
          issueReason,
          maxUses: input.mode === 'ONE_SHOT' ? 1 : (input.maxUses ?? null),
          notBefore,
          expiresAt: input.expiresAt ?? null,
          createdByType: 'HUMAN',
          createdById: input.actor.id,
        },
        select: grantSelect,
      })
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          actorType: 'HUMAN',
          action: 'approval-grant.issued',
          targetType: 'ApprovalGrant',
          targetId: grant.id,
          afterState: {
            venueId: grant.venueId,
            agentIdentityId: grant.agentIdentityId,
            actionName: grant.actionName,
            capability: grant.capability,
            mode: grant.mode,
            maxUses: grant.maxUses,
            notBefore: grant.notBefore.toISOString(),
            expiresAt: grant.expiresAt?.toISOString() ?? null,
            parameterHash: grant.parameterHash,
            constraints: grant.constraints,
            issueReason: grant.issueReason,
            operationId: grant.operationId,
          },
        },
        tx,
      )
      return { ...grant, replayed: false as const }
    })

  try {
    return await attempt()
  } catch (error) {
    if (
      error instanceof ApprovalGrantActionError ||
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'P2002'
    ) {
      throw error
    }
    return client.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof db
      const replay = await tx.approvalGrant.findFirst({
        where: { tenantId: input.tenantId, operationId },
        select: grantSelect,
      })
      if (replay && sameGrantIssue(replay, input, normalized)) {
        return { ...replay, replayed: true as const }
      }
      throw new ApprovalGrantActionError(
        'CONFLICT',
        'Approval-grant authority changed concurrently; refresh before retrying',
      )
    })
  }
}

/**
 * Atomically verifies and consumes exact authority. Bounded grants without an
 * exact parameter hash fail closed until their action registers a reviewed
 * constraint evaluator; callers cannot self-assert that arbitrary parameters fit.
 */
export async function consumeApprovalGrantAction(
  input: {
    tenantId: string
    venueId: string
    approvalGrantId: string
    operationId: string
    actionName: string
    capability: string
    parameters: unknown
    actor: MachineActorContext
    now?: Date
    resultReference?: string
  },
  client: ApprovalGrantClient = db,
) {
  const parsedOperationId = z.string().uuid().parse(input.operationId)
  const now = input.now ?? new Date()
  const parameterHash = approvalParameterHash(input.parameters)
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const replay = await tx.approvalGrantConsumption.findFirst({
      where: { tenantId: input.tenantId, operationId: parsedOperationId },
      select: {
        id: true,
        approvalGrantId: true,
        agentIdentityId: true,
        agentRunId: true,
        workerId: true,
        credentialId: true,
        actionName: true,
        capability: true,
        parameterHash: true,
        resultReference: true,
        consumedAt: true,
      },
    })
    if (replay) {
      if (
        replay.approvalGrantId !== input.approvalGrantId ||
        replay.agentIdentityId !== input.actor.agentIdentityId ||
        replay.agentRunId !== input.actor.agentRunId ||
        replay.workerId !== input.actor.workerId ||
        replay.credentialId !== input.actor.credentialId ||
        replay.actionName !== input.actionName ||
        replay.capability !== input.capability ||
        replay.parameterHash !== parameterHash
      ) {
        throw new ApprovalGrantActionError(
          'CONFLICT',
          'Operation ID was already used for different approval evidence',
        )
      }
      return { consumption: replay, replayed: true as const }
    }

    const grant = await tx.approvalGrant.findFirst({
      where: {
        id: input.approvalGrantId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentIdentityId: input.actor.agentIdentityId,
        actionName: input.actionName,
        capability: input.capability,
      },
      select: {
        id: true,
        mode: true,
        constraints: true,
        parameterHash: true,
        useCount: true,
        maxUses: true,
        notBefore: true,
        expiresAt: true,
        revokedAt: true,
      },
    })
    if (!grant) throw new ApprovalGrantActionError('NOT_FOUND', 'Approval grant not found in scope')
    if (grant.revokedAt) throw new ApprovalGrantActionError('REVOKED', 'Approval grant is revoked')
    if (grant.notBefore > now) {
      throw new ApprovalGrantActionError('FORBIDDEN', 'Approval grant is not active yet')
    }
    if (grant.expiresAt && grant.expiresAt <= now) {
      throw new ApprovalGrantActionError('EXPIRED', 'Approval grant has expired')
    }
    if (grant.maxUses !== null && grant.useCount >= grant.maxUses) {
      throw new ApprovalGrantActionError('EXHAUSTED', 'Approval grant has no remaining uses')
    }
    if (grant.parameterHash === null) {
      assertPolicyParameters(input, grant.constraints)
    } else if (grant.parameterHash !== parameterHash) {
      throw new ApprovalGrantActionError(
        'PARAMETER_MISMATCH',
        'Action parameters do not match the approved parameters',
      )
    }

    const updated = await tx.approvalGrant.updateMany({
      where: {
        id: grant.id,
        tenantId: input.tenantId,
        useCount: grant.useCount,
        revokedAt: null,
        notBefore: { lte: now },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      data: { useCount: { increment: 1 } },
    })
    if (updated.count !== 1) {
      throw new ApprovalGrantActionError(
        'CONFLICT',
        'Approval grant changed while it was being consumed',
      )
    }
    const consumption = await tx.approvalGrantConsumption.create({
      data: {
        operationId: parsedOperationId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        approvalGrantId: grant.id,
        agentIdentityId: input.actor.agentIdentityId,
        agentRunId: input.actor.agentRunId,
        workerId: input.actor.workerId,
        credentialId: input.actor.credentialId,
        actionName: input.actionName,
        capability: input.capability,
        parameterHash,
        resultReference: input.resultReference ?? null,
        consumedAt: now,
      },
      select: {
        id: true,
        approvalGrantId: true,
        agentIdentityId: true,
        agentRunId: true,
        workerId: true,
        credentialId: true,
        actionName: true,
        capability: true,
        parameterHash: true,
        resultReference: true,
        consumedAt: true,
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actor: { ...input.actor, approvalGrantId: grant.id, idempotencyKey: parsedOperationId },
        action: 'approval-grant.consumed',
        targetType: 'ApprovalGrant',
        targetId: grant.id,
        afterState: {
          consumptionId: consumption.id,
          actionName: input.actionName,
          capability: input.capability,
          parameterHash,
          useCount: grant.useCount + 1,
        },
      },
      tx,
    )
    return { consumption, replayed: false as const }
  })
}

export async function revokeApprovalGrantAction(
  input: {
    tenantId: string
    venueId: string
    approvalGrantId: string
    reason: string
    actor: ApprovalGrantHumanActor
    now?: Date
  },
  client: ApprovalGrantClient = db,
) {
  assertHuman(input.actor)
  const now = input.now ?? new Date()
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const grant = await tx.approvalGrant.findFirst({
      where: { id: input.approvalGrantId, tenantId: input.tenantId, venueId: input.venueId },
      select: { id: true, revokedAt: true },
    })
    if (!grant) throw new ApprovalGrantActionError('NOT_FOUND', 'Approval grant not found')
    if (grant.revokedAt) return { id: grant.id, revokedAt: grant.revokedAt, replayed: true }
    const updated = await tx.approvalGrant.updateMany({
      where: { id: grant.id, tenantId: input.tenantId, revokedAt: null },
      data: {
        revokedAt: now,
        revokedByType: 'HUMAN',
        revokedById: input.actor.id,
        revokeReason: input.reason,
      },
    })
    if (updated.count !== 1) {
      throw new ApprovalGrantActionError('CONFLICT', 'Approval grant changed before revocation')
    }
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        actorType: 'HUMAN',
        action: 'approval-grant.revoked',
        targetType: 'ApprovalGrant',
        targetId: grant.id,
        beforeState: { revokedAt: null },
        afterState: { revokedAt: now.toISOString(), reason: input.reason },
      },
      tx,
    )
    return { id: grant.id, revokedAt: now, replayed: false }
  })
}
