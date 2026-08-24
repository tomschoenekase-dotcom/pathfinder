import { createHash } from 'node:crypto'
import { z } from 'zod'

import {
  SUPPORT_PACKAGE_HANDOFF_SUPERSESSION_CAPABILITY,
  SupportPackageHandoffSupersessionApplyParameters,
} from '@pathfinder/contracts'
import { MachineActorContext } from '@pathfinder/contracts/actor'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { lockVenueContentMutation } from './venue-content-lock'

type SupersessionClient = Pick<typeof db, '$transaction'>

const inputSchema = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    parameters: SupportPackageHandoffSupersessionApplyParameters,
    actor: MachineActorContext,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.parameters.clientId !== value.tenantId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parameters', 'clientId'],
        message: 'Supersession client scope must match the transaction tenant.',
      })
    }
    if (value.parameters.venueId !== value.venueId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parameters', 'venueId'],
        message: 'Supersession venue scope must match the transaction venue.',
      })
    }
    if (value.actor.capability !== SUPPORT_PACKAGE_HANDOFF_SUPERSESSION_CAPABILITY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actor', 'capability'],
        message: 'The exact packages:reconcile capability is required.',
      })
    }
    if (!value.actor.approvalGrantId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actor', 'approvalGrantId'],
        message: 'Support package handoff supersession requires an approval grant.',
      })
    }
    if (value.actor.idempotencyKey !== value.operationId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actor', 'idempotencyKey'],
        message: 'Supersession operation identity must match the actor idempotency key.',
      })
    }
  })

export type SupersedeSupportPackageHandoffInput = z.input<typeof inputSchema>

export class SupportPackageHandoffSupersessionError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'SupportPackageHandoffSupersessionError'
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function operationHash(input: {
  operationId: string
  parameters: SupportPackageHandoffSupersessionApplyParameters
  actorId: string
}) {
  return createHash('sha256')
    .update(
      canonicalJson({
        domain: 'pathfinder.support-package-handoff-supersession.v1',
        ...input,
      }),
    )
    .digest('hex')
}

function exactPackageIdentity(
  actual: {
    id: string
    status: string
    updatedAt: Date
    payloadHash: string
    appliedAt: Date | null
    appliedBy: string | null
    appliedCommandKey: string | null
    revertedAt: Date | null
    revertedBy: string | null
    revertedCommandKey: string | null
  },
  expected:
    | SupportPackageHandoffSupersessionApplyParameters['superseded']
    | SupportPackageHandoffSupersessionApplyParameters['replacement'],
) {
  if (
    actual.id !== expected.packageId ||
    actual.updatedAt.toISOString() !== expected.packageUpdatedAt ||
    actual.payloadHash !== expected.payloadHash
  ) {
    return false
  }
  if ('revertedAt' in expected) {
    return (
      actual.status === 'REVERTED' &&
      actual.revertedAt?.toISOString() === expected.revertedAt &&
      actual.revertedBy === expected.revertedBy &&
      actual.revertedCommandKey === expected.revertedCommandKey
    )
  }
  return (
    actual.status === 'APPLIED' &&
    actual.appliedAt?.toISOString() === expected.appliedAt &&
    actual.appliedBy === expected.appliedBy &&
    actual.appliedCommandKey === expected.appliedCommandKey
  )
}

/** Appends one exact current-truth relation from a reverted support handoff to
 * a separately linked, already-applied replacement. Package rows and the
 * original handoffs remain untouched. */
export async function supersedeSupportPackageHandoffAction(
  input: SupersedeSupportPackageHandoffInput,
  client: SupersessionClient = db,
) {
  const parsedResult = inputSchema.safeParse(input)
  if (!parsedResult.success) {
    throw new SupportPackageHandoffSupersessionError(
      'INVALID_INPUT',
      parsedResult.error.issues[0]?.message ?? 'Support package handoff supersession is invalid.',
    )
  }
  const parsed = parsedResult.data
  const hash = operationHash({
    operationId: parsed.operationId,
    parameters: parsed.parameters,
    actorId: parsed.actor.actorId,
  })

  return client.$transaction(async (tx) => {
    await lockVenueContentMutation(tx, { tenantId: parsed.tenantId, venueId: parsed.venueId })
    const replay = await tx.supportPackageHandoffSupersession.findUnique({
      where: {
        tenantId_operationId: { tenantId: parsed.tenantId, operationId: parsed.operationId },
      },
      select: {
        id: true,
        venueId: true,
        supportRequestId: true,
        supersededHandoffId: true,
        replacementHandoffId: true,
        requestVersion: true,
        operationHash: true,
        createdByKind: true,
        createdById: true,
        createdAt: true,
      },
    })
    if (replay) {
      if (
        replay.venueId !== parsed.venueId ||
        replay.supportRequestId !== parsed.parameters.requestId ||
        replay.supersededHandoffId !== parsed.parameters.superseded.handoffId ||
        replay.replacementHandoffId !== parsed.parameters.replacement.handoffId ||
        replay.operationHash !== hash ||
        replay.createdByKind !== 'AGENT' ||
        replay.createdById !== parsed.actor.agentIdentityId
      ) {
        throw new SupportPackageHandoffSupersessionError(
          'CONFLICT',
          'Support package handoff supersession operation ID was already used.',
        )
      }
      return {
        supersession: replay,
        requestVersion: replay.requestVersion,
        replayed: true as const,
      }
    }

    const request = await tx.supportRequest.findFirst({
      where: {
        id: parsed.parameters.requestId,
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
      },
      select: { id: true, status: true, version: true, clientVersion: true },
    })
    if (!request) {
      throw new SupportPackageHandoffSupersessionError('NOT_FOUND', 'Support request not found.')
    }
    if (
      request.version !== parsed.parameters.expectedVersion ||
      request.status !== parsed.parameters.supportRequestStatus
    ) {
      throw new SupportPackageHandoffSupersessionError(
        'CONFLICT',
        'Support request changed; refresh handoff supersession evidence.',
      )
    }

    const handoffs = await tx.supportPackageHandoff.findMany({
      where: {
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        supportRequestId: request.id,
        id: {
          in: [parsed.parameters.superseded.handoffId, parsed.parameters.replacement.handoffId],
        },
      },
      select: {
        id: true,
        requestVersion: true,
        supersessionAsPrior: { select: { id: true } },
        venuePackage: {
          select: {
            id: true,
            status: true,
            updatedAt: true,
            payloadHash: true,
            appliedAt: true,
            appliedBy: true,
            appliedCommandKey: true,
            revertedAt: true,
            revertedBy: true,
            revertedCommandKey: true,
          },
        },
      },
    })
    const superseded = handoffs.find(
      (handoff) => handoff.id === parsed.parameters.superseded.handoffId,
    )
    const replacement = handoffs.find(
      (handoff) => handoff.id === parsed.parameters.replacement.handoffId,
    )
    if (!superseded || !replacement) {
      throw new SupportPackageHandoffSupersessionError(
        'NOT_FOUND',
        'Exact support package handoffs were not found.',
      )
    }
    if (superseded.supersessionAsPrior) {
      throw new SupportPackageHandoffSupersessionError(
        'CONFLICT',
        'The historical support package handoff is already superseded.',
      )
    }
    if (
      superseded.requestVersion !== parsed.parameters.superseded.handoffRequestVersion ||
      replacement.requestVersion !== parsed.parameters.replacement.handoffRequestVersion ||
      !exactPackageIdentity(superseded.venuePackage, parsed.parameters.superseded) ||
      !exactPackageIdentity(replacement.venuePackage, parsed.parameters.replacement)
    ) {
      throw new SupportPackageHandoffSupersessionError(
        'CONFLICT',
        'Support package handoff or package lifecycle evidence changed after founder review.',
      )
    }

    const nextVersion = request.version + 1
    const changed = await tx.supportRequest.updateMany({
      where: {
        id: request.id,
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        version: request.version,
        status: request.status,
      },
      data: {
        version: nextVersion,
        updatedByKind: 'AGENT',
        updatedById: parsed.actor.agentIdentityId,
      },
    })
    if (changed.count !== 1) {
      throw new SupportPackageHandoffSupersessionError(
        'CONFLICT',
        'Support request changed; refresh handoff supersession evidence.',
      )
    }
    const supersession = await tx.supportPackageHandoffSupersession.create({
      data: {
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        supportRequestId: request.id,
        supersededHandoffId: superseded.id,
        replacementHandoffId: replacement.id,
        requestVersion: nextVersion,
        operationId: parsed.operationId,
        operationHash: hash,
        createdByKind: 'AGENT',
        createdById: parsed.actor.agentIdentityId,
      },
      select: {
        id: true,
        venueId: true,
        supportRequestId: true,
        supersededHandoffId: true,
        replacementHandoffId: true,
        requestVersion: true,
        operationHash: true,
        createdByKind: true,
        createdById: true,
        createdAt: true,
      },
    })
    await tx.supportRequestAuditEvent.create({
      data: {
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        supportRequestId: request.id,
        requestVersion: nextVersion,
        eventType: 'PACKAGE_HANDOFF_SUPERSEDED',
        actorKind: 'AGENT',
        actorId: parsed.actor.agentIdentityId,
        fromStatus: null,
        toStatus: null,
      },
      select: { id: true },
    })
    await writeAuditLogStrict(
      {
        tenantId: parsed.tenantId,
        actor: parsed.actor,
        action: 'support-request.package-handoff-superseded',
        targetType: 'SupportRequest',
        targetId: request.id,
        beforeState: {
          status: request.status,
          version: request.version,
          clientVersion: request.clientVersion,
          supersededHandoffId: superseded.id,
          supersededPackageStatus: 'REVERTED',
          replacementHandoffId: replacement.id,
          replacementPackageStatus: 'APPLIED',
        },
        afterState: {
          status: request.status,
          version: nextVersion,
          clientVersion: request.clientVersion,
          supersessionId: supersession.id,
          historicalHandoffPreserved: true,
          packageLifecycleChanged: false,
          supportStatusChanged: false,
          clientActivityChanged: false,
          customerContacted: false,
          externalDeliveryTriggered: false,
        },
      },
      tx,
    )
    return { supersession, requestVersion: nextVersion, replayed: false as const }
  })
}
