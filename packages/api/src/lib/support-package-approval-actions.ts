import { createHash } from 'node:crypto'
import { z } from 'zod'

import {
  SUPPORT_PACKAGE_APPROVAL_APPLY_ACTION,
  SUPPORT_PACKAGE_APPROVAL_CAPABILITY,
  SupportPackageApprovalProposalSnapshot,
} from '@pathfinder/contracts'
import { MachineActorContext } from '@pathfinder/contracts/actor'
import { db, writeAuditLogStrict } from '@pathfinder/db'

import { canonicalVenuePackageWarningCodes } from './client-package-preview'
import { venuePackagePayloadHash } from './venue-package-identity'
import {
  VenuePackagePayload,
  VenuePackageStoredPreview,
  VenuePackageValidationReport,
} from '../schemas/venue-package'

const evidenceReference = z
  .object({ type: z.string().trim().min(1).max(100), id: z.string().trim().min(1).max(191) })
  .strict()

const proposalActor = MachineActorContext.superRefine((actor, context) => {
  if (actor.capability !== SUPPORT_PACKAGE_APPROVAL_CAPABILITY) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capability'],
      message: 'The exact packages:approve capability is required.',
    })
  }
  if (!actor.idempotencyKey) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['idempotencyKey'],
      message: 'Support package-approval proposals require an idempotency key.',
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

const inputSchema = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    packageId: z.string().trim().min(1).max(191),
    expectedUpdatedAt: z.coerce.date(),
    reason: z.string().trim().min(3).max(2000),
    evidence: z.array(evidenceReference).max(20).default([]),
    actor: proposalActor,
  })
  .strict()

export type PrepareSupportPackageApprovalProposalInput = z.input<typeof inputSchema>
export type SupportPackageApprovalProposalErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'

export class SupportPackageApprovalProposalError extends Error {
  constructor(
    readonly code: SupportPackageApprovalProposalErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SupportPackageApprovalProposalError'
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

function exactJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}

/** Freezes one exact support-linked DRAFT for founder review. No package lifecycle,
 * support request, customer-visible, publication, or external-delivery mutation occurs. */
export async function prepareSupportPackageApprovalProposalAction(
  input: PrepareSupportPackageApprovalProposalInput,
  client: Pick<typeof db, '$transaction'> = db,
) {
  const parsedResult = inputSchema.safeParse(input)
  if (!parsedResult.success) {
    throw new SupportPackageApprovalProposalError(
      'INVALID_INPUT',
      parsedResult.error.issues[0]?.message ?? 'Support package-approval proposal is invalid.',
    )
  }
  const parsed = parsedResult.data

  try {
    return await client.$transaction(async (tx) => {
      const existing = await tx.approvalRequest.findUnique({
        where: { id: parsed.operationId },
        select: {
          id: true,
          tenantId: true,
          venueId: true,
          agentIdentityId: true,
          agentRunId: true,
          proposedAction: true,
          scopeSnapshot: true,
          artifacts: true,
          reason: true,
          createdAt: true,
          decision: { select: { decision: true } },
        },
      })
      if (existing) {
        const snapshot = SupportPackageApprovalProposalSnapshot.safeParse(existing.scopeSnapshot)
        if (
          existing.tenantId !== parsed.tenantId ||
          existing.venueId !== parsed.venueId ||
          existing.agentIdentityId !== parsed.actor.agentIdentityId ||
          existing.agentRunId !== parsed.actor.agentRunId ||
          existing.proposedAction !== SUPPORT_PACKAGE_APPROVAL_APPLY_ACTION ||
          existing.reason !== parsed.reason ||
          !snapshot.success ||
          snapshot.data.packageId !== parsed.packageId ||
          snapshot.data.expectedUpdatedAt !== parsed.expectedUpdatedAt.toISOString() ||
          !exactJson(existing.artifacts, parsed.evidence)
        ) {
          throw new SupportPackageApprovalProposalError(
            'CONFLICT',
            'Support package-approval proposal operation ID was already used.',
          )
        }
        return { approvalRequest: existing, snapshot: snapshot.data, replayed: true as const }
      }

      const identity = await tx.agentIdentity.findFirst({
        where: {
          id: parsed.actor.agentIdentityId,
          tenantId: parsed.tenantId,
          enabled: true,
          accessCapabilities: { has: SUPPORT_PACKAGE_APPROVAL_CAPABILITY },
          OR: [
            { accessScope: { in: ['CLIENT', 'PLATFORM'] } },
            { accessScope: 'VENUE', venueId: parsed.venueId },
          ],
        },
        select: { id: true },
      })
      if (!identity) {
        throw new SupportPackageApprovalProposalError(
          'FORBIDDEN',
          'Enabled package-approval agent identity is not in scope.',
        )
      }

      const [run, pkg] = await Promise.all([
        tx.agentRun.findFirst({
          where: {
            id: parsed.actor.agentRunId,
            tenantId: parsed.tenantId,
            venueId: parsed.venueId,
            agentIdentityId: identity.id,
            status: 'RUNNING',
          },
          select: { id: true, requestedOperation: true },
        }),
        tx.venuePackage.findFirst({
          where: {
            id: parsed.packageId,
            tenantId: parsed.tenantId,
            venueId: parsed.venueId,
          },
          select: {
            id: true,
            schemaVersion: true,
            payload: true,
            payloadHash: true,
            baseDigest: true,
            validationReport: true,
            previewPlan: true,
            status: true,
            updatedAt: true,
            supportHandoffs: {
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: 1,
              select: {
                id: true,
                supportRequestId: true,
                requestVersion: true,
              },
            },
          },
        }),
      ])
      if (!run) {
        throw new SupportPackageApprovalProposalError(
          'FORBIDDEN',
          'Running package-approval agent run is not in scope.',
        )
      }
      if (!pkg) {
        throw new SupportPackageApprovalProposalError('NOT_FOUND', 'Venue package was not found.')
      }
      if (
        pkg.status !== 'DRAFT' ||
        pkg.updatedAt.getTime() !== parsed.expectedUpdatedAt.getTime()
      ) {
        throw new SupportPackageApprovalProposalError(
          'CONFLICT',
          'Venue package changed; refresh it before proposing approval.',
        )
      }
      const payload = VenuePackagePayload.safeParse(pkg.payload)
      const report = VenuePackageValidationReport.safeParse(pkg.validationReport)
      const preview = VenuePackageStoredPreview.safeParse(pkg.previewPlan)
      if (!payload.success || !report.success || !preview.success) {
        throw new SupportPackageApprovalProposalError(
          'CONFLICT',
          'Stored venue-package review evidence is unavailable.',
        )
      }
      const payloadHash = venuePackagePayloadHash(parsed.venueId, payload.data)
      const warningDigest = digest(report.data.warnings)
      const evidenceMismatches = [
        payloadHash !== pkg.payloadHash ? 'payload-hash' : null,
        payload.data.schemaVersion !== pkg.schemaVersion ? 'payload-schema-version' : null,
        preview.data.schemaVersion !== pkg.schemaVersion ? 'preview-schema-version' : null,
        preview.data.payloadHash !== pkg.payloadHash ? 'preview-payload-hash' : null,
        preview.data.baseDigest !== pkg.baseDigest ? 'preview-base-digest' : null,
        preview.data.warningDigest !== warningDigest ? 'preview-warning-digest' : null,
        canonicalJson(preview.data.report) !== canonicalJson(report.data)
          ? 'validation-report'
          : null,
      ].filter((value): value is string => value !== null)
      if (evidenceMismatches.length > 0) {
        throw new SupportPackageApprovalProposalError(
          'CONFLICT',
          `Stored venue-package review evidence does not match its immutable identity (${evidenceMismatches.join(', ')}).`,
        )
      }
      if (
        report.data.errors.length > 0 ||
        report.data.semanticDuplicateScan.status !== 'COMPLETE'
      ) {
        throw new SupportPackageApprovalProposalError(
          'CONFLICT',
          'Package approval requires error-free validation and a complete semantic scan.',
        )
      }
      const handoff = pkg.supportHandoffs[0]
      if (!handoff) {
        throw new SupportPackageApprovalProposalError(
          'CONFLICT',
          'Only a support-linked package can use this approval workflow.',
        )
      }
      const evaluationRuns = await tx.evalRun.findMany({
        where: {
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          contentSnapshotRef: pkg.id,
          contentSnapshotKind: {
            in: ['REVIEWABLE_VENUE_PACKAGE_V1', 'APPROVED_VENUE_PACKAGE_V1'],
          },
          packageSnapshotHash: pkg.payloadHash,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 21,
        select: { id: true },
      })
      const snapshot = SupportPackageApprovalProposalSnapshot.parse({
        contractVersion: 1,
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        packageId: pkg.id,
        expectedUpdatedAt: pkg.updatedAt.toISOString(),
        fromStatus: 'DRAFT',
        toStatus: 'APPROVED',
        payloadHash: pkg.payloadHash,
        baseDigest: pkg.baseDigest,
        warningDigest,
        warningCodes: canonicalVenuePackageWarningCodes(report.data.warnings),
        supportHandoff: {
          handoffId: handoff.id,
          supportRequestId: handoff.supportRequestId,
          supportRequestVersion: handoff.requestVersion,
        },
        evaluationEvidence: {
          exactPackageRunIds: evaluationRuns.slice(0, 20).map((evaluation) => evaluation.id),
          truncated: evaluationRuns.length > 20,
          thresholdApplied: false,
        },
        packageApproved: false,
        packageApplied: false,
        packagePublished: false,
        supportRequestChanged: false,
        customerContacted: false,
        externalDeliveryTriggered: false,
        executionAuthorized: false,
      })

      const approvalRequest = await tx.approvalRequest.create({
        data: {
          id: parsed.operationId,
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          agentIdentityId: identity.id,
          agentRunId: run.id,
          requestedByType: 'AGENT',
          requestedById: identity.id,
          proposedAction: SUPPORT_PACKAGE_APPROVAL_APPLY_ACTION,
          scopeSnapshot: snapshot,
          reason: parsed.reason,
          riskCategory: 'MEDIUM',
          artifacts: parsed.evidence,
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
      const action = await tx.agentAction.create({
        data: {
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          agentRunId: run.id,
          agentIdentityId: identity.id,
          actorType: 'AGENT',
          actorId: identity.id,
          requestedOperation: run.requestedOperation,
          actionName: 'torchiko.support.propose_package_approval',
          inputSummary: `Prepare exact support-linked package ${pkg.id} for founder approval.`,
          inputReference: `VenuePackage:${pkg.id}:${pkg.payloadHash}:${pkg.baseDigest}:DRAFT`,
          output: {
            approvalRequestId: approvalRequest.id,
            packageId: pkg.id,
            packageStatus: 'DRAFT',
            evaluationRunCount: snapshot.evaluationEvidence.exactPackageRunIds.length,
            thresholdApplied: false,
          },
          modelProvider: parsed.actor.modelProvider ?? null,
          modelName: parsed.actor.modelName ?? null,
          status: 'SUCCEEDED',
          beforeVersionRef: `VenuePackage:${pkg.id}:${pkg.updatedAt.toISOString()}:DRAFT`,
          afterVersionRef: `ApprovalRequest:${approvalRequest.id}:PENDING`,
        },
        select: { id: true },
      })
      const transitioned = await tx.agentRun.updateMany({
        where: {
          id: run.id,
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          status: 'RUNNING',
        },
        data: { status: 'AWAITING_APPROVAL' },
      })
      if (transitioned.count !== 1) {
        throw new SupportPackageApprovalProposalError(
          'CONFLICT',
          'Agent run changed before the package-approval proposal was recorded.',
        )
      }
      await tx.agentTimelineEvent.create({
        data: {
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          agentRunId: run.id,
          agentActionId: action.id,
          actorType: 'AGENT',
          actorId: identity.id,
          eventType: 'support-package-approval.awaiting-approval',
          message: 'An exact support-linked package DRAFT is waiting for founder approval.',
          data: {
            approvalRequestId: approvalRequest.id,
            packageId: pkg.id,
            payloadHash: pkg.payloadHash,
            baseDigest: pkg.baseDigest,
            warningDigest,
            evaluationRunCount: snapshot.evaluationEvidence.exactPackageRunIds.length,
            thresholdApplied: false,
          },
        },
      })
      await writeAuditLogStrict(
        {
          tenantId: parsed.tenantId,
          actor: parsed.actor,
          action: 'support-package.approval-proposed',
          targetType: 'ApprovalRequest',
          targetId: approvalRequest.id,
          sourceReferences: parsed.evidence,
          structuredReason: {
            proposedAction: approvalRequest.proposedAction,
            packageId: pkg.id,
            payloadHash: pkg.payloadHash,
          },
          afterState: {
            status: 'PENDING',
            packageStatus: 'DRAFT',
            packageApproved: false,
            packageApplied: false,
            packagePublished: false,
            supportRequestChanged: false,
            customerContacted: false,
            executionAuthorized: false,
          },
        },
        tx,
      )
      return { approvalRequest, snapshot, replayed: false as const }
    })
  } catch (error) {
    if (error instanceof SupportPackageApprovalProposalError) throw error
    if (isUniqueConstraintError(error)) {
      throw new SupportPackageApprovalProposalError(
        'CONFLICT',
        'A support package-approval proposal already exists for this operation.',
      )
    }
    throw error
  }
}
