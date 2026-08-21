import { createHash } from 'node:crypto'
import { z } from 'zod'

import type { MachineActorContext } from '@pathfinder/contracts/actor'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type ApprovalGrantHumanActor = {
  type: 'HUMAN'
  id: string
  role: 'PLATFORM_ADMIN'
}

type ApprovalGrantClient = Pick<typeof db, '$transaction'>

export class ApprovalGrantActionError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
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
  mode: 'ONE_SHOT' | 'BOUNDED' | 'TEMPORARY' | 'POLICY_BACKED'
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
}

export async function issueApprovalGrantAction(
  input: {
    tenantId: string
    venueId: string
    agentIdentityId: string
    actionName: string
    capability: string
    mode: 'ONE_SHOT' | 'BOUNDED' | 'TEMPORARY' | 'POLICY_BACKED'
    scope: Record<string, unknown>
    approvalDecisionId?: string
    policyKey?: string
    parameters?: unknown
    constraints?: Record<string, unknown>
    maxUses?: number
    notBefore?: Date
    expiresAt?: Date
    actor: ApprovalGrantHumanActor
  },
  client: ApprovalGrantClient = db,
) {
  assertHuman(input.actor)
  modeRules(input)
  const notBefore = input.notBefore ?? new Date()
  if (input.expiresAt && input.expiresAt <= notBefore) {
    throw new ApprovalGrantActionError('CONFLICT', 'Grant expiration must follow its start')
  }
  const parameterHash =
    input.parameters === undefined ? null : approvalParameterHash(input.parameters)

  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
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
        tenantId: input.tenantId,
        venueId: input.venueId,
        approvalDecisionId: input.approvalDecisionId ?? null,
        policyKey: input.policyKey ?? null,
        agentIdentityId: input.agentIdentityId,
        actionName: input.actionName,
        capability: input.capability,
        mode: input.mode,
        scope: input.scope,
        parameterHash,
        constraints: input.constraints ?? {},
        maxUses: input.mode === 'ONE_SHOT' ? 1 : (input.maxUses ?? null),
        notBefore,
        expiresAt: input.expiresAt ?? null,
        createdByType: 'HUMAN',
        createdById: input.actor.id,
      },
      select: {
        id: true,
        tenantId: true,
        venueId: true,
        agentIdentityId: true,
        actionName: true,
        capability: true,
        mode: true,
        scope: true,
        parameterHash: true,
        constraints: true,
        maxUses: true,
        useCount: true,
        notBefore: true,
        expiresAt: true,
        createdAt: true,
      },
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
        },
      },
      tx,
    )
    return grant
  })
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
      throw new ApprovalGrantActionError(
        'POLICY_UNAVAILABLE',
        `No reviewed parameter evaluator is registered for ${grant.mode.toLowerCase()} grant`,
      )
    }
    if (grant.parameterHash !== parameterHash) {
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
