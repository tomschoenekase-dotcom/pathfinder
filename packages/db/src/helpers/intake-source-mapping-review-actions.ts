import { createHash } from 'node:crypto'
import { z } from 'zod'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

type Transaction = Parameters<Parameters<typeof db.$transaction>[0]>[0]
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const inputSchema = z
  .object({
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    operationId: z.string().uuid(),
    sourceRunId: z.string().trim().min(1).max(191),
    expectedSourceInputHash: hashSchema,
    kind: z.enum(['WEBSITE_MAPPING', 'OPTIONAL_NOTES_SELECTION']),
    reviewedBy: z.string().trim().min(1).max(191),
    rationale: z.string().trim().min(1).max(500),
    requestIdentity: z.unknown(),
  })
  .strict()

const projectionSchema = z
  .object({
    researchReceiptId: z.string().uuid().nullable(),
    researchHash: hashSchema.nullable(),
    selectionSnapshot: z.unknown(),
    selectionHash: hashSchema,
    payload: z.unknown(),
    payloadHash: hashSchema,
  })
  .strict()

export type IntakeSourceMappingReviewSource = {
  id: string
  sourceKind: string
  status: string
  submissionInputHash: string | null
  requestedBy: string
  requestedByType: string
  agentIdentityId: string | null
  agentRunId: string | null
  workerId: string | null
  credentialId: string | null
  approvalGrantId: string | null
  capability: string | null
  modelProvider: string | null
  modelName: string | null
  structuredBootstrap: unknown
  evidence: Array<{ locator: string; normalizedHash: string }>
}

export type IntakeSourceMappingReviewProjector = (
  tx: Transaction,
  source: IntakeSourceMappingReviewSource,
) => Promise<z.input<typeof projectionSchema>>

export class IntakeSourceMappingReviewError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'IntakeSourceMappingReviewError'
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

export function intakeSourceMappingDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function safe(
  review: {
    id: string
    proposalRunId: string
    kind: string
    mappingVersion: number
    selectionHash: string
    payloadHash: string
    createdAt: Date
  },
  replayed: boolean,
) {
  return {
    reviewId: review.id,
    proposalRunId: review.proposalRunId,
    kind: review.kind as 'WEBSITE_MAPPING' | 'OPTIONAL_NOTES_SELECTION',
    mappingVersion: review.mappingVersion,
    selectionHash: review.selectionHash,
    payloadHash: review.payloadHash,
    createdAt: review.createdAt,
    replayed,
    autoApprove: false as const,
    autoApply: false as const,
    published: false as const,
  }
}

export async function reviewIntakeSourceForV1(
  raw: z.input<typeof inputSchema>,
  projector: IntakeSourceMappingReviewProjector,
  client: Pick<typeof db, '$transaction'> = db,
) {
  const parsed = inputSchema.safeParse(raw)
  if (!parsed.success)
    throw new IntakeSourceMappingReviewError('INVALID_INPUT', 'Invalid source mapping review.')
  const input = parsed.data
  let requestHash: string
  try {
    requestHash = intakeSourceMappingDigest(input.requestIdentity)
  } catch {
    throw new IntakeSourceMappingReviewError('INVALID_INPUT', 'Invalid mapping request identity.')
  }
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['pathfinder:intake-source-mapping-review', input.tenantId, input.operationId])}, 0))`
    const replay = await tx.intakeSourceMappingReview.findFirst({
      where: { id: input.operationId, tenantId: input.tenantId },
      select: {
        id: true,
        venueId: true,
        sourceRunId: true,
        sourceInputHash: true,
        kind: true,
        reviewedBy: true,
        rationale: true,
        requestHash: true,
        proposalRunId: true,
        mappingVersion: true,
        selectionHash: true,
        payloadHash: true,
        createdAt: true,
      },
    })
    if (replay) {
      if (
        replay.venueId !== input.venueId ||
        replay.sourceRunId !== input.sourceRunId ||
        replay.sourceInputHash !== input.expectedSourceInputHash ||
        replay.kind !== input.kind ||
        replay.reviewedBy !== input.reviewedBy ||
        replay.rationale !== input.rationale ||
        replay.requestHash !== requestHash
      )
        throw new IntakeSourceMappingReviewError(
          'CONFLICT',
          'This operation is bound to a different source mapping review.',
        )
      return safe(replay, true)
    }

    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM intake_runs
       WHERE id=${input.sourceRunId} AND tenant_id=${input.tenantId} AND venue_id=${input.venueId}
       FOR UPDATE
    `
    const source = await tx.intakeRun.findFirst({
      where: { id: input.sourceRunId, tenantId: input.tenantId, venueId: input.venueId },
      select: {
        id: true,
        sourceKind: true,
        status: true,
        submissionInputHash: true,
        requestedBy: true,
        requestedByType: true,
        agentIdentityId: true,
        agentRunId: true,
        workerId: true,
        credentialId: true,
        approvalGrantId: true,
        capability: true,
        modelProvider: true,
        modelName: true,
        structuredBootstrap: true,
        evidence: {
          orderBy: [{ capturedAt: 'asc' }, { id: 'asc' }],
          select: { locator: true, normalizedHash: true },
        },
      },
    })
    if (!source) throw new IntakeSourceMappingReviewError('NOT_FOUND', 'Source run not found.')
    if (
      source.status !== 'AWAITING_REVIEW' ||
      source.submissionInputHash !== input.expectedSourceInputHash
    )
      throw new IntakeSourceMappingReviewError('CONFLICT', 'Source identity changed.')

    const projected = projectionSchema.safeParse(await projector(tx, source))
    if (!projected.success)
      throw new IntakeSourceMappingReviewError(
        'CONFLICT',
        'Reviewed mapping projection is invalid.',
      )
    if (
      (input.kind === 'WEBSITE_MAPPING') !== Boolean(projected.data.researchReceiptId) ||
      (input.kind === 'WEBSITE_MAPPING') !== Boolean(projected.data.researchHash)
    )
      throw new IntakeSourceMappingReviewError('CONFLICT', 'Mapping evidence kind is inconsistent.')
    if (
      Buffer.byteLength(JSON.stringify(projected.data.selectionSnapshot)) > 50_000 ||
      Buffer.byteLength(JSON.stringify(projected.data.payload)) > 50_000
    )
      throw new IntakeSourceMappingReviewError('INVALID_INPUT', 'Reviewed mapping is too large.')

    const proposal = await tx.intakeRun.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        sourceKind: 'STRUCTURED_BOOTSTRAP',
        status: 'AWAITING_REVIEW',
        displayName: `Reviewed ${input.kind === 'WEBSITE_MAPPING' ? 'website mapping' : 'notes selection'}`,
        structuredBootstrap: {
          kind: 'SOURCE_MAPPING_REVIEW',
          reviewId: input.operationId,
          mappingVersion: 1,
          selectionHash: projected.data.selectionHash,
          payloadHash: projected.data.payloadHash,
        },
        submissionRequestId: input.operationId,
        submissionInputHash: requestHash,
        requestedBy: source.requestedBy,
        requestedByType: source.requestedByType as 'HUMAN' | 'AGENT',
        ...(source.agentIdentityId ? { agentIdentityId: source.agentIdentityId } : {}),
        ...(source.agentRunId ? { agentRunId: source.agentRunId } : {}),
        ...(source.workerId ? { workerId: source.workerId } : {}),
        ...(source.credentialId ? { credentialId: source.credentialId } : {}),
        ...(source.approvalGrantId ? { approvalGrantId: source.approvalGrantId } : {}),
        ...(source.capability ? { capability: source.capability } : {}),
        ...(source.modelProvider ? { modelProvider: source.modelProvider } : {}),
        ...(source.modelName ? { modelName: source.modelName } : {}),
      },
      select: { id: true },
    })
    const review = await tx.intakeSourceMappingReview.create({
      data: {
        id: input.operationId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        sourceRunId: source.id,
        proposalRunId: proposal.id,
        kind: input.kind,
        sourceInputHash: input.expectedSourceInputHash,
        researchReceiptId: projected.data.researchReceiptId,
        researchHash: projected.data.researchHash,
        requestHash,
        mappingVersion: 1,
        selectionSnapshot: projected.data.selectionSnapshot as never,
        selectionHash: projected.data.selectionHash,
        payload: projected.data.payload as never,
        payloadHash: projected.data.payloadHash,
        rationale: input.rationale,
        reviewedBy: input.reviewedBy,
      },
      select: {
        id: true,
        proposalRunId: true,
        kind: true,
        mappingVersion: true,
        selectionHash: true,
        payloadHash: true,
        createdAt: true,
      },
    })
    await tx.intakeEvidenceRecord.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: proposal.id,
        sourceKind: 'STRUCTURED_BOOTSTRAP',
        locator: `intake-source-mapping-review:${review.id}`,
        normalizedHash: projected.data.payloadHash,
        confidence: 1,
        capturedAt: review.createdAt,
      },
    })
    await tx.intakeRunEvent.createMany({
      data: [
        {
          tenantId: input.tenantId,
          venueId: input.venueId,
          runId: proposal.id,
          kind: 'PROPOSAL_CREATED',
          actorId: input.reviewedBy,
          metadata: {
            sourceRunId: source.id,
            sourceOwnerId: source.requestedBy,
            reviewId: review.id,
            reviewKind: input.kind,
            systemProducedReviewProjection: true,
            packageDraftCreated: false,
            autoApproved: false,
            autoApplied: false,
            autoPublished: false,
          },
        },
        {
          tenantId: input.tenantId,
          venueId: input.venueId,
          runId: proposal.id,
          kind: 'EVIDENCE_RECORDED',
          actorId: input.reviewedBy,
          metadata: {
            reviewId: review.id,
            selectionHash: review.selectionHash,
            payloadHash: review.payloadHash,
          },
        },
      ],
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.reviewedBy,
        actorRole: 'PLATFORM_ADMIN',
        action: 'intake.source-mapping-reviewed',
        targetType: 'IntakeSourceMappingReview',
        targetId: review.id,
        afterState: {
          venueId: input.venueId,
          sourceRunId: source.id,
          proposalRunId: proposal.id,
          kind: input.kind,
          sourceOwnerId: source.requestedBy,
          requestHash,
          selectionHash: review.selectionHash,
          payloadHash: review.payloadHash,
          packageDraftCreated: false,
          autoApproved: false,
          autoApplied: false,
          autoPublished: false,
        },
      },
      tx,
    )
    return safe(review, false)
  })
}
