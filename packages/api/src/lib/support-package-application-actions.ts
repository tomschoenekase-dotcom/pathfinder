import { createHash } from 'node:crypto'
import { z } from 'zod'

import {
  SUPPORT_PACKAGE_APPLICATION_APPLY_ACTION,
  SUPPORT_PACKAGE_APPLICATION_CAPABILITY,
  SupportPackageApplicationProposalSnapshot,
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
  if (actor.capability !== SUPPORT_PACKAGE_APPLICATION_CAPABILITY) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capability'],
      message: 'The exact packages:apply capability is required.',
    })
  }
  if (!actor.idempotencyKey) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['idempotencyKey'],
      message: 'Support package-application proposals require an idempotency key.',
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

export type PrepareSupportPackageApplicationProposalInput = z.input<typeof inputSchema>
export class SupportPackageApplicationProposalError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'SupportPackageApplicationProposalError'
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
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Freezes one exact APPROVED support-linked package for founder review. This proposal
 * does not mutate content; later execution does and may be visitor-visible. */
export async function prepareSupportPackageApplicationProposalAction(
  input: PrepareSupportPackageApplicationProposalInput,
  client: Pick<typeof db, '$transaction'> = db,
) {
  const parsedResult = inputSchema.safeParse(input)
  if (!parsedResult.success) {
    throw new SupportPackageApplicationProposalError(
      'INVALID_INPUT',
      parsedResult.error.issues[0]?.message ?? 'Support package-application proposal is invalid.',
    )
  }
  const parsed = parsedResult.data
  return client.$transaction(async (tx) => {
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
      },
    })
    if (existing) {
      const snapshot = SupportPackageApplicationProposalSnapshot.safeParse(existing.scopeSnapshot)
      if (
        existing.tenantId !== parsed.tenantId ||
        existing.venueId !== parsed.venueId ||
        existing.agentIdentityId !== parsed.actor.agentIdentityId ||
        existing.agentRunId !== parsed.actor.agentRunId ||
        existing.proposedAction !== SUPPORT_PACKAGE_APPLICATION_APPLY_ACTION ||
        existing.reason !== parsed.reason ||
        !snapshot.success ||
        snapshot.data.packageId !== parsed.packageId ||
        snapshot.data.expectedUpdatedAt !== parsed.expectedUpdatedAt.toISOString() ||
        canonicalJson(existing.artifacts) !== canonicalJson(parsed.evidence)
      ) {
        throw new SupportPackageApplicationProposalError(
          'CONFLICT',
          'Support package-application proposal operation ID was already used.',
        )
      }
      return { approvalRequest: existing, snapshot: snapshot.data, replayed: true as const }
    }

    const identity = await tx.agentIdentity.findFirst({
      where: {
        id: parsed.actor.agentIdentityId,
        tenantId: parsed.tenantId,
        enabled: true,
        accessCapabilities: { has: SUPPORT_PACKAGE_APPLICATION_CAPABILITY },
        OR: [
          { accessScope: { in: ['CLIENT', 'PLATFORM'] } },
          { accessScope: 'VENUE', venueId: parsed.venueId },
        ],
      },
      select: { id: true },
    })
    if (!identity) {
      throw new SupportPackageApplicationProposalError(
        'FORBIDDEN',
        'Enabled package-application agent identity is not in scope.',
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
        where: { id: parsed.packageId, tenantId: parsed.tenantId, venueId: parsed.venueId },
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
          approvedAt: true,
          approvedBy: true,
          supportHandoffs: {
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 1,
            select: { id: true, supportRequestId: true, requestVersion: true },
          },
        },
      }),
    ])
    if (!run) {
      throw new SupportPackageApplicationProposalError(
        'FORBIDDEN',
        'Running package-application agent run is not in scope.',
      )
    }
    if (!pkg)
      throw new SupportPackageApplicationProposalError('NOT_FOUND', 'Venue package not found.')
    if (
      pkg.status !== 'APPROVED' ||
      pkg.updatedAt.getTime() !== parsed.expectedUpdatedAt.getTime() ||
      !pkg.approvedAt ||
      !pkg.approvedBy
    ) {
      throw new SupportPackageApplicationProposalError(
        'CONFLICT',
        'Venue package is not the expected approved revision.',
      )
    }
    const payload = VenuePackagePayload.safeParse(pkg.payload)
    const report = VenuePackageValidationReport.safeParse(pkg.validationReport)
    const preview = VenuePackageStoredPreview.safeParse(pkg.previewPlan)
    if (!payload.success || !report.success || !preview.success) {
      throw new SupportPackageApplicationProposalError(
        'CONFLICT',
        'Stored venue-package review evidence is unavailable.',
      )
    }
    const payloadHash = venuePackagePayloadHash(parsed.venueId, payload.data)
    const warningDigest = digest(report.data.warnings)
    if (
      payloadHash !== pkg.payloadHash ||
      payload.data.schemaVersion !== pkg.schemaVersion ||
      preview.data.schemaVersion !== pkg.schemaVersion ||
      preview.data.payloadHash !== pkg.payloadHash ||
      preview.data.baseDigest !== pkg.baseDigest ||
      preview.data.warningDigest !== warningDigest ||
      canonicalJson(preview.data.report) !== canonicalJson(report.data) ||
      report.data.errors.length > 0 ||
      report.data.semanticDuplicateScan.status !== 'COMPLETE'
    ) {
      throw new SupportPackageApplicationProposalError(
        'CONFLICT',
        'Approved package evidence is stale, inconsistent, or incomplete.',
      )
    }
    const handoff = pkg.supportHandoffs[0]
    if (!handoff) {
      throw new SupportPackageApplicationProposalError(
        'CONFLICT',
        'Only a support-linked package can use this application workflow.',
      )
    }
    const evaluationRuns = await tx.evalRun.findMany({
      where: {
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        contentSnapshotRef: pkg.id,
        contentSnapshotKind: { in: ['REVIEWABLE_VENUE_PACKAGE_V1', 'APPROVED_VENUE_PACKAGE_V1'] },
        packageSnapshotHash: pkg.payloadHash,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 21,
      select: { id: true },
    })
    const snapshot = SupportPackageApplicationProposalSnapshot.parse({
      contractVersion: 1,
      tenantId: parsed.tenantId,
      venueId: parsed.venueId,
      packageId: pkg.id,
      expectedUpdatedAt: pkg.updatedAt.toISOString(),
      fromStatus: 'APPROVED',
      toStatus: 'APPLIED',
      payloadHash: pkg.payloadHash,
      baseDigest: pkg.baseDigest,
      warningDigest,
      warningCodes: canonicalVenuePackageWarningCodes(report.data.warnings),
      approvedAt: pkg.approvedAt.toISOString(),
      approvedBy: pkg.approvedBy,
      supportHandoff: {
        handoffId: handoff.id,
        supportRequestId: handoff.supportRequestId,
        supportRequestVersion: handoff.requestVersion,
      },
      evaluationEvidence: {
        exactPackageRunIds: evaluationRuns.slice(0, 20).map(({ id }) => id),
        truncated: evaluationRuns.length > 20,
        thresholdApplied: false,
      },
      currentContentMutation: true,
      visitorVisibleChangePossible: true,
      supportRequestChanged: false,
      customerContacted: false,
      externalDeliveryTriggered: false,
      supportCompletionTriggered: false,
      revertTriggered: false,
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
        proposedAction: SUPPORT_PACKAGE_APPLICATION_APPLY_ACTION,
        scopeSnapshot: snapshot,
        reason: parsed.reason,
        riskCategory: 'HIGH',
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
        actionName: 'torchiko.support.propose_package_application',
        inputSummary: `Prepare approved support-linked package ${pkg.id} for founder application review.`,
        inputReference: `VenuePackage:${pkg.id}:${pkg.payloadHash}:${pkg.baseDigest}:APPROVED`,
        output: {
          approvalRequestId: approvalRequest.id,
          packageId: pkg.id,
          currentContentMutation: true,
          visitorVisibleChangePossible: true,
        },
        modelProvider: parsed.actor.modelProvider ?? null,
        modelName: parsed.actor.modelName ?? null,
        status: 'SUCCEEDED',
        beforeVersionRef: `VenuePackage:${pkg.id}:${pkg.updatedAt.toISOString()}:APPROVED`,
        afterVersionRef: `ApprovalRequest:${approvalRequest.id}:PENDING`,
      },
      select: { id: true },
    })
    const transitioned = await tx.agentRun.updateMany({
      where: { id: run.id, tenantId: parsed.tenantId, venueId: parsed.venueId, status: 'RUNNING' },
      data: { status: 'AWAITING_APPROVAL' },
    })
    if (transitioned.count !== 1) {
      throw new SupportPackageApplicationProposalError(
        'CONFLICT',
        'Agent run changed before the package-application proposal was recorded.',
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
        eventType: 'support-package-application.awaiting-approval',
        message:
          'An exact approved support-linked package is waiting for founder approval to mutate current venue content.',
        data: {
          approvalRequestId: approvalRequest.id,
          packageId: pkg.id,
          currentContentMutation: true,
          visitorVisibleChangePossible: true,
        },
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: parsed.tenantId,
        actor: parsed.actor,
        action: 'support-package.application-proposed',
        targetType: 'ApprovalRequest',
        targetId: approvalRequest.id,
        sourceReferences: parsed.evidence,
        structuredReason: { packageId: pkg.id, payloadHash: pkg.payloadHash },
        afterState: {
          status: 'PENDING',
          packageStatus: 'APPROVED',
          currentContentMutation: false,
          visitorVisibleChange: false,
          executionAuthorized: false,
        },
      },
      tx,
    )
    return { approvalRequest, snapshot, replayed: false as const }
  })
}
