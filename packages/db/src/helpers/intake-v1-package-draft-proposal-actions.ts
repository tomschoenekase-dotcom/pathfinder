import { z } from 'zod'

import {
  INTAKE_V1_PACKAGE_DRAFT_APPLY_ACTION,
  INTAKE_V1_PACKAGE_DRAFT_CAPABILITY,
  IntakeV1PackageDraftProposalApprovalSnapshot,
} from '@pathfinder/contracts'
import { MachineActorContext } from '@pathfinder/contracts/actor'

import { db } from '../client'
import { assertIntakeV1PackageMachineAuthority } from './intake-v1-package-machine-authority'
import { writeAuditLogStrict } from './audit'

const actor = MachineActorContext.superRefine((value, context) => {
  if (value.capability !== INTAKE_V1_PACKAGE_DRAFT_CAPABILITY)
    context.addIssue({
      code: 'custom',
      path: ['capability'],
      message: 'packages:draft is required.',
    })
  if (!value.idempotencyKey)
    context.addIssue({
      code: 'custom',
      path: ['idempotencyKey'],
      message: 'Idempotency is required.',
    })
})
const inputSchema = IntakeV1PackageDraftProposalApprovalSnapshot.omit({
  contractVersion: true,
  packageDraftCreated: true,
  packageApproved: true,
  packageApplied: true,
  packagePublished: true,
  executionAuthorized: true,
})
  .extend({
    operationId: z.string().uuid(),
    clientId: z.string().trim().min(1).max(191),
    reason: z.string().trim().min(3).max(2_000),
    actor,
    executionLeaseToken: z.string().uuid(),
  })
  .strict()

export class IntakeV1PackageDraftProposalError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'IntakeV1PackageDraftProposalError'
  }
}

export async function readIntakeV1PackageDraftProposalReplay(
  raw: z.input<typeof inputSchema>,
  client: typeof db = db,
) {
  const parsed = inputSchema.safeParse(raw)
  if (!parsed.success)
    throw new IntakeV1PackageDraftProposalError('INVALID_INPUT', 'Invalid proposal replay.')
  const input = parsed.data
  const snapshot = IntakeV1PackageDraftProposalApprovalSnapshot.parse({
    contractVersion: 1,
    tenantId: input.tenantId,
    venueId: input.venueId,
    submissionId: input.submissionId,
    revision: input.revision,
    manifestHash: input.manifestHash,
    candidateHash: input.candidateHash,
    payloadHash: input.payloadHash,
    selectionHash: input.selectionHash,
    selectedMemberIds: input.selectedMemberIds,
    partialAcknowledged: input.partialAcknowledged,
    draftOperationId: input.draftOperationId,
    packageDraftCreated: false,
    packageApproved: false,
    packageApplied: false,
    packagePublished: false,
    executionAuthorized: false,
  })
  const existing = await client.approvalRequest.findFirst({
    where: { id: input.operationId, tenantId: input.tenantId, venueId: input.venueId },
    select: {
      id: true,
      tenantId: true,
      venueId: true,
      agentIdentityId: true,
      agentRunId: true,
      proposedAction: true,
      scopeSnapshot: true,
      reason: true,
      createdAt: true,
    },
  })
  if (!existing) return null
  if (
    existing.agentIdentityId !== input.actor.agentIdentityId ||
    existing.agentRunId !== input.actor.agentRunId ||
    existing.proposedAction !== INTAKE_V1_PACKAGE_DRAFT_APPLY_ACTION ||
    existing.reason !== input.reason ||
    !exact(existing.scopeSnapshot, snapshot)
  )
    throw new IntakeV1PackageDraftProposalError(
      'CONFLICT',
      'Proposal operation ID was already used.',
    )
  return { approvalRequest: existing, replayed: true as const }
}

function exact(left: unknown, right: unknown) {
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
    if (value !== null && typeof value === 'object')
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
        .join(',')}}`
    return JSON.stringify(value)
  }
  return stable(left) === stable(right)
}

export async function prepareIntakeV1PackageDraftProposalAction(
  raw: z.input<typeof inputSchema>,
  client: Pick<typeof db, '$transaction'> = db,
) {
  const parsed = inputSchema.safeParse(raw)
  if (!parsed.success)
    throw new IntakeV1PackageDraftProposalError(
      'INVALID_INPUT',
      parsed.error.issues[0]?.message ?? 'Invalid proposal.',
    )
  const input = parsed.data
  if (input.clientId !== input.tenantId || input.actor.idempotencyKey !== input.operationId)
    throw new IntakeV1PackageDraftProposalError(
      'FORBIDDEN',
      'Proposal scope or operation identity is invalid.',
    )
  const snapshot = IntakeV1PackageDraftProposalApprovalSnapshot.parse({
    contractVersion: 1,
    tenantId: input.tenantId,
    venueId: input.venueId,
    submissionId: input.submissionId,
    revision: input.revision,
    manifestHash: input.manifestHash,
    candidateHash: input.candidateHash,
    payloadHash: input.payloadHash,
    selectionHash: input.selectionHash,
    selectedMemberIds: input.selectedMemberIds,
    partialAcknowledged: input.partialAcknowledged,
    draftOperationId: input.draftOperationId,
    packageDraftCreated: false,
    packageApproved: false,
    packageApplied: false,
    packagePublished: false,
    executionAuthorized: false,
  })
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`intake-v1-package-proposal:${input.tenantId}:${input.operationId}`}, 0))`
    const existing = await tx.approvalRequest.findUnique({
      where: { id: input.operationId },
      select: {
        id: true,
        tenantId: true,
        venueId: true,
        agentIdentityId: true,
        agentRunId: true,
        proposedAction: true,
        scopeSnapshot: true,
        reason: true,
        createdAt: true,
      },
    })
    if (existing) {
      if (
        existing.tenantId !== input.tenantId ||
        existing.venueId !== input.venueId ||
        existing.agentIdentityId !== input.actor.agentIdentityId ||
        existing.agentRunId !== input.actor.agentRunId ||
        existing.proposedAction !== INTAKE_V1_PACKAGE_DRAFT_APPLY_ACTION ||
        existing.reason !== input.reason ||
        !exact(existing.scopeSnapshot, snapshot)
      )
        throw new IntakeV1PackageDraftProposalError(
          'CONFLICT',
          'Proposal operation ID was already used.',
        )
      return { approvalRequest: existing, replayed: true as const }
    }
    await assertIntakeV1PackageMachineAuthority(tx, {
      tenantId: input.tenantId,
      clientId: input.clientId,
      venueId: input.venueId,
      agentIdentityId: input.actor.agentIdentityId,
      agentRunId: input.actor.agentRunId,
      workerKey: input.actor.workerId,
      credentialId: input.actor.credentialId,
      capability: INTAKE_V1_PACKAGE_DRAFT_CAPABILITY,
      executionLeaseToken: input.executionLeaseToken,
    })
    const identity = await tx.agentIdentity.findFirst({
      where: {
        id: input.actor.agentIdentityId,
        tenantId: input.tenantId,
        enabled: true,
        accessCapabilities: { has: INTAKE_V1_PACKAGE_DRAFT_CAPABILITY },
        OR: [
          { accessScope: { in: ['CLIENT', 'PLATFORM'] } },
          { accessScope: 'VENUE', venueId: input.venueId },
        ],
      },
      select: { id: true },
    })
    const revision = await tx.intakeV1SubmissionRevision.findFirst({
      where: {
        submissionId: input.submissionId,
        revision: input.revision,
        tenantId: input.tenantId,
        venueId: input.venueId,
        manifestHash: input.manifestHash,
      },
      select: { id: true },
    })
    if (!identity)
      throw new IntakeV1PackageDraftProposalError('FORBIDDEN', 'Agent run identity is unavailable.')
    if (!revision)
      throw new IntakeV1PackageDraftProposalError(
        'CONFLICT',
        'Exact V1 revision changed or is unavailable.',
      )
    const approvalRequest = await tx.approvalRequest.create({
      data: {
        id: input.operationId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentIdentityId: identity.id,
        agentRunId: input.actor.agentRunId,
        requestedByType: 'AGENT',
        requestedById: identity.id,
        proposedAction: INTAKE_V1_PACKAGE_DRAFT_APPLY_ACTION,
        scopeSnapshot: snapshot,
        reason: input.reason,
        riskCategory: 'MEDIUM',
        artifacts: [],
      },
      select: {
        id: true,
        tenantId: true,
        venueId: true,
        agentIdentityId: true,
        agentRunId: true,
        proposedAction: true,
        scopeSnapshot: true,
        reason: true,
        createdAt: true,
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actor: input.actor,
        action: 'intake-v1.package-draft-proposed',
        targetType: 'ApprovalRequest',
        targetId: approvalRequest.id,
        sourceReferences: [{ type: 'IntakeV1SubmissionRevision', id: revision.id }],
        structuredReason: {
          submissionId: input.submissionId,
          revision: input.revision,
          candidateHash: input.candidateHash,
        },
        afterState: snapshot,
      },
      tx,
    )
    return { approvalRequest, replayed: false as const }
  })
}
