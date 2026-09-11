import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

import { db } from '../client'
import {
  INTAKE_V1_FILE_EXTRACTION_POLICY_VERSION,
  isIntakeV1FileExtractionSupported,
} from './intake-v1-file-extraction-policy'

export const INTAKE_V1_PROCESSING_POLICY_VERSION = 'intake-v1-processing-v1'
export const INTAKE_V1_PROCESSING_LEASE_MS = 120_000
export const INTAKE_V1_PROCESSING_MAX_ATTEMPTS = 3

type Transaction = Parameters<Parameters<typeof db.$transaction>[0]>[0]
export class IntakeV1ProcessingDispatchError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'IntakeV1ProcessingDispatchError'
  }
}

/** Creates projections only for the new immutable revision inside its submission transaction. */
export async function createIntakeV1ProcessingDispatchesInTransaction(
  tx: Transaction,
  input: { tenantId: string; venueId: string; revisionId: string },
) {
  const scope = z
    .object({
      tenantId: z.string().min(1).max(191),
      venueId: z.string().min(1).max(191),
      revisionId: z.string().min(1).max(191),
    })
    .strict()
    .parse(input)
  const members = await tx.intakeV1SubmissionMember.findMany({
    where: { revisionId: scope.revisionId, tenantId: scope.tenantId, venueId: scope.venueId },
    orderBy: { ordinal: 'asc' },
    select: {
      id: true,
      immutableHash: true,
      intakeRunId: true,
      intakeUpload: { select: { intakeRunId: true, mimeType: true, byteSize: true } },
      intakeRun: {
        select: {
          sourceKind: true,
          websiteUri: true,
          submissionInputHash: true,
          websiteResearchReceipts: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { id: true, outcome: true, sourceUriHash: true },
          },
        },
      },
    },
  })
  if (!members.length)
    throw new IntakeV1ProcessingDispatchError('CONFLICT', 'V1 revision has no members.')
  const rows = members.map((member) => {
    const intakeRunId = member.intakeRunId ?? member.intakeUpload?.intakeRunId
    if (!intakeRunId)
      throw new IntakeV1ProcessingDispatchError(
        'CONFLICT',
        'V1 member has no canonical intake run.',
      )
    const sourceKind = member.intakeRun?.sourceKind ?? 'FILE_UPLOAD'
    if (sourceKind === 'WEBSITE') {
      const receipt = member.intakeRun?.websiteResearchReceipts[0]
      const sourceUriHash = member.intakeRun?.websiteUri
        ? createHash('sha256').update(member.intakeRun.websiteUri).digest('hex')
        : null
      if (member.intakeRun?.submissionInputHash !== member.immutableHash || !sourceUriHash)
        throw new IntakeV1ProcessingDispatchError(
          'CONFLICT',
          'Website member source identity changed.',
        )
      if (receipt && receipt.sourceUriHash === sourceUriHash)
        return receipt.outcome === 'SUCCEEDED'
          ? {
              id: randomUUID(),
              tenantId: scope.tenantId,
              venueId: scope.venueId,
              revisionId: scope.revisionId,
              memberId: member.id,
              intakeRunId,
              operationId: randomUUID(),
              kind: 'WEBSITE_RESEARCH' as const,
              status: 'COMPLETED' as const,
              sourceHash: member.immutableHash,
              policyVersion: INTAKE_V1_PROCESSING_POLICY_VERSION,
              receiptId: receipt.id,
              completedAt: new Date(),
            }
          : {
              id: randomUUID(),
              tenantId: scope.tenantId,
              venueId: scope.venueId,
              revisionId: scope.revisionId,
              memberId: member.id,
              intakeRunId,
              operationId: randomUUID(),
              kind: 'WEBSITE_RESEARCH' as const,
              status: 'HELD' as const,
              sourceHash: member.immutableHash,
              policyVersion: INTAKE_V1_PROCESSING_POLICY_VERSION,
              receiptId: receipt.id,
              holdReason: 'PRIOR_RESEARCH_NOT_SUCCESSFUL',
              completedAt: new Date(),
            }
      return {
        id: randomUUID(),
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        revisionId: scope.revisionId,
        memberId: member.id,
        intakeRunId,
        operationId: randomUUID(),
        kind: 'WEBSITE_RESEARCH' as const,
        status: 'PENDING' as const,
        sourceHash: member.immutableHash,
        policyVersion: INTAKE_V1_PROCESSING_POLICY_VERSION,
      }
    }
    if (sourceKind === 'INTERVIEW' || sourceKind === 'STRUCTURED_BOOTSTRAP')
      return {
        id: randomUUID(),
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        revisionId: scope.revisionId,
        memberId: member.id,
        intakeRunId,
        operationId: randomUUID(),
        kind: 'REVIEW_READY' as const,
        status: 'COMPLETED' as const,
        sourceHash: member.immutableHash,
        policyVersion: INTAKE_V1_PROCESSING_POLICY_VERSION,
        completedAt: new Date(),
      }
    if (
      sourceKind === 'FILE_UPLOAD' &&
      member.intakeUpload &&
      isIntakeV1FileExtractionSupported(member.intakeUpload.mimeType, member.intakeUpload.byteSize)
    )
      return {
        id: randomUUID(),
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        revisionId: scope.revisionId,
        memberId: member.id,
        intakeRunId,
        operationId: randomUUID(),
        kind: 'FILE_EXTRACTION' as const,
        status: 'PENDING' as const,
        sourceHash: member.immutableHash,
        policyVersion: INTAKE_V1_FILE_EXTRACTION_POLICY_VERSION,
      }
    return {
      id: randomUUID(),
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      revisionId: scope.revisionId,
      memberId: member.id,
      intakeRunId,
      operationId: randomUUID(),
      kind: 'EXTRACTION_UNSUPPORTED' as const,
      status: 'HELD' as const,
      sourceHash: member.immutableHash,
      policyVersion: INTAKE_V1_PROCESSING_POLICY_VERSION,
      holdReason: 'EXTRACTION_NOT_EXECUTABLE',
      completedAt: new Date(),
    }
  })
  await tx.intakeV1ProcessingDispatch.createMany({ data: rows })
  return rows
}

export type LeasedIntakeV1ProcessingDispatch = {
  id: string
  tenantId: string
  venueId: string
  revisionId: string
  memberId: string
  intakeRunId: string
  operationId: string
  sourceHash: string
  policyVersion: string
  attempts: number
  leaseToken: string
}

export async function listPendingIntakeV1WebsiteResearchDispatchIds(
  input: { limit?: number },
  client: Pick<typeof db, '$queryRaw'> = db,
) {
  const { limit } = z
    .object({ limit: z.number().int().min(1).max(100).default(25) })
    .strict()
    .parse(input)
  return client.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM intake_v1_processing_dispatches
    WHERE kind='WEBSITE_RESEARCH'
      AND ((status='PENDING' AND attempts < ${INTAKE_V1_PROCESSING_MAX_ATTEMPTS})
        OR (status='LEASED' AND attempts <= ${INTAKE_V1_PROCESSING_MAX_ATTEMPTS} AND lease_expires_at <= clock_timestamp()))
    ORDER BY created_at ASC, id ASC LIMIT ${limit}
  `
}

export async function claimIntakeV1WebsiteResearchDispatch(
  input: { dispatchId: string; leaseOwner: string },
  client: Pick<typeof db, '$transaction'> = db,
) {
  const parsed = z
    .object({
      dispatchId: z.string().min(1).max(191),
      leaseOwner: z.string().trim().min(1).max(191),
    })
    .strict()
    .parse(input)
  const leaseToken = randomUUID()
  return client.$transaction(async (tx) => {
    const lockedSources = await tx.$queryRaw<
      Array<{
        websiteUri: string | null
        submissionInputHash: string | null
        memberHash: string
        dispatchHash: string
      }>
    >`SELECT run.website_uri AS "websiteUri", run.submission_input_hash AS "submissionInputHash",
        member.immutable_hash AS "memberHash", dispatch.source_hash AS "dispatchHash"
      FROM intake_v1_processing_dispatches AS dispatch
      JOIN intake_runs AS run ON run.id=dispatch.intake_run_id AND run.tenant_id=dispatch.tenant_id AND run.venue_id=dispatch.venue_id
      JOIN intake_v1_submission_members AS member ON member.id=dispatch.member_id
        AND member.revision_id=dispatch.revision_id AND member.tenant_id=dispatch.tenant_id AND member.venue_id=dispatch.venue_id
      WHERE dispatch.id=${parsed.dispatchId} FOR UPDATE OF run`
    const lockedSource = lockedSources[0]
    if (
      !lockedSource?.websiteUri ||
      lockedSource.submissionInputHash !== lockedSource.memberHash ||
      lockedSource.memberHash !== lockedSource.dispatchHash
    )
      return null
    const lockedSourceUriHash = createHash('sha256').update(lockedSource.websiteUri).digest('hex')
    const rows = await tx.$queryRaw<LeasedIntakeV1ProcessingDispatch[]>`
    WITH recovered AS (
      UPDATE intake_v1_processing_dispatches AS dispatch
      SET status=CASE WHEN receipt.outcome='SUCCEEDED' THEN 'COMPLETED'::"IntakeV1ProcessingStatus" ELSE 'HELD'::"IntakeV1ProcessingStatus" END,
        receipt_id=receipt.id,
        hold_reason=CASE WHEN receipt.outcome='SUCCEEDED' THEN NULL ELSE 'PRIOR_RESEARCH_NOT_SUCCESSFUL' END,
        lease_token=NULL, lease_owner=NULL, lease_expires_at=NULL,
        completed_at=clock_timestamp(), updated_at=clock_timestamp()
      FROM intake_website_research_receipts AS receipt
      WHERE dispatch.id=${parsed.dispatchId} AND dispatch.kind='WEBSITE_RESEARCH'
        AND dispatch.status='LEASED' AND dispatch.attempts >= ${INTAKE_V1_PROCESSING_MAX_ATTEMPTS}
        AND dispatch.lease_expires_at <= clock_timestamp()
        AND receipt.id=dispatch.operation_id AND receipt.tenant_id=dispatch.tenant_id
        AND receipt.venue_id=dispatch.venue_id AND receipt.run_id=dispatch.intake_run_id
        AND receipt.source_uri_hash=${lockedSourceUriHash}
        AND dispatch.source_hash=${lockedSource.dispatchHash}
      RETURNING dispatch.id
    ), exhausted AS (
      UPDATE intake_v1_processing_dispatches SET status='FAILED', last_error='Processing lease expired after the final attempt.',
        lease_token=NULL, lease_owner=NULL, lease_expires_at=NULL, completed_at=clock_timestamp(), updated_at=clock_timestamp()
      WHERE id=${parsed.dispatchId} AND kind='WEBSITE_RESEARCH' AND status='LEASED'
        AND attempts >= ${INTAKE_V1_PROCESSING_MAX_ATTEMPTS} AND lease_expires_at <= clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM recovered)
      RETURNING id
    )
    UPDATE intake_v1_processing_dispatches SET status='LEASED', attempts=attempts+1,
      lease_token=${leaseToken}::uuid, lease_owner=${parsed.leaseOwner},
      lease_expires_at=clock_timestamp()+(${INTAKE_V1_PROCESSING_LEASE_MS}*interval '1 millisecond'),
      last_error=NULL, updated_at=clock_timestamp()
    WHERE id=${parsed.dispatchId} AND kind='WEBSITE_RESEARCH'
      AND attempts < ${INTAKE_V1_PROCESSING_MAX_ATTEMPTS}
      AND (status='PENDING' OR (status='LEASED' AND lease_expires_at <= clock_timestamp()))
      AND NOT EXISTS (
        SELECT 1 FROM intake_v1_processing_dispatches AS active
        WHERE active.tenant_id=intake_v1_processing_dispatches.tenant_id
          AND active.venue_id=intake_v1_processing_dispatches.venue_id
          AND active.intake_run_id=intake_v1_processing_dispatches.intake_run_id
          AND active.id<>intake_v1_processing_dispatches.id
          AND active.kind='WEBSITE_RESEARCH' AND active.status='LEASED'
          AND active.lease_expires_at > clock_timestamp()
      )
    RETURNING id, tenant_id AS "tenantId", venue_id AS "venueId", revision_id AS "revisionId",
      member_id AS "memberId", intake_run_id AS "intakeRunId", operation_id AS "operationId",
      source_hash AS "sourceHash", policy_version AS "policyVersion", attempts,
      lease_token AS "leaseToken"
  `
    return rows[0] ?? null
  })
}

export async function assertIntakeV1WebsiteResearchDispatchActive(
  input: z.input<typeof exactSchema> & { policyVersion: string },
  client: Pick<typeof db, '$queryRaw'> = db,
) {
  const exact = exactSchema
    .extend({ policyVersion: z.literal(INTAKE_V1_PROCESSING_POLICY_VERSION) })
    .parse(input)
  const rows = await client.$queryRaw<LeasedIntakeV1ProcessingDispatch[]>`
    SELECT dispatch.id, dispatch.tenant_id AS "tenantId", dispatch.venue_id AS "venueId", dispatch.revision_id AS "revisionId",
      dispatch.member_id AS "memberId", dispatch.intake_run_id AS "intakeRunId", dispatch.operation_id AS "operationId",
      dispatch.source_hash AS "sourceHash", dispatch.policy_version AS "policyVersion", dispatch.attempts,
      dispatch.lease_token AS "leaseToken"
    FROM intake_v1_processing_dispatches AS dispatch
    JOIN intake_v1_submission_members AS member
      ON member.id=dispatch.member_id AND member.revision_id=dispatch.revision_id
      AND member.tenant_id=dispatch.tenant_id AND member.venue_id=dispatch.venue_id
    JOIN intake_runs AS run ON run.id=dispatch.intake_run_id
      AND run.tenant_id=dispatch.tenant_id AND run.venue_id=dispatch.venue_id
    WHERE dispatch.id=${exact.id} AND dispatch.tenant_id=${exact.tenantId} AND dispatch.venue_id=${exact.venueId}
      AND dispatch.operation_id=${exact.operationId}::uuid AND dispatch.source_hash=${exact.sourceHash}
      AND member.immutable_hash=dispatch.source_hash
      AND member.intake_run_id=dispatch.intake_run_id AND run.submission_input_hash=member.immutable_hash
      AND dispatch.policy_version=${exact.policyVersion} AND dispatch.kind='WEBSITE_RESEARCH' AND dispatch.status='LEASED'
      AND dispatch.lease_token=${exact.leaseToken}::uuid AND dispatch.lease_expires_at > clock_timestamp()
  `
  return rows[0] ?? null
}

const exactSchema = z
  .object({
    id: z.string().min(1).max(191),
    tenantId: z.string().min(1).max(191),
    venueId: z.string().min(1).max(191),
    operationId: z.string().uuid(),
    leaseToken: z.string().uuid(),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()

async function lockProcessingDispatch(tx: Transaction, exact: z.input<typeof exactSchema>) {
  await tx.$queryRaw`SELECT id FROM intake_v1_processing_dispatches WHERE id=${exact.id} AND tenant_id=${exact.tenantId} AND venue_id=${exact.venueId} FOR UPDATE`
}

async function processingDatabaseClock(tx: Transaction): Promise<Date> {
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
  if (!(clock[0]?.now instanceof Date))
    throw new IntakeV1ProcessingDispatchError('CONFLICT', 'Database clock was unavailable.')
  return clock[0].now
}

export async function completeIntakeV1ProcessingDispatch(
  input: z.input<typeof exactSchema> & { receiptId: string },
  client: Pick<typeof db, '$transaction'> = db,
) {
  const exact = exactSchema.extend({ receiptId: z.string().uuid() }).parse(input)
  return client.$transaction(async (tx) => {
    await lockProcessingDispatch(tx, exact)
    const now = await processingDatabaseClock(tx)
    const receipt = await tx.intakeWebsiteResearchReceipt.findFirst({
      where: { id: exact.receiptId, tenantId: exact.tenantId, venueId: exact.venueId },
      select: { id: true, runId: true, outcome: true },
    })
    const dispatch = await tx.intakeV1ProcessingDispatch.findFirst({
      where: { id: exact.id, tenantId: exact.tenantId, venueId: exact.venueId },
      select: { intakeRunId: true },
    })
    if (
      !receipt ||
      !dispatch ||
      receipt.id !== exact.operationId ||
      receipt.runId !== dispatch.intakeRunId ||
      receipt.outcome !== 'SUCCEEDED'
    )
      throw new IntakeV1ProcessingDispatchError(
        'CONFLICT',
        'Website research receipt does not match the dispatch.',
      )
    const changed = await tx.intakeV1ProcessingDispatch.updateMany({
      where: {
        id: exact.id,
        tenantId: exact.tenantId,
        venueId: exact.venueId,
        operationId: exact.operationId,
        sourceHash: exact.sourceHash,
        kind: 'WEBSITE_RESEARCH',
        status: 'LEASED',
        leaseToken: exact.leaseToken,
        leaseExpiresAt: { gt: now },
      },
      data: {
        status: 'COMPLETED',
        receiptId: exact.receiptId,
        leaseToken: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: now,
      },
    })
    if (changed.count !== 1)
      throw new IntakeV1ProcessingDispatchError(
        'CONFLICT',
        'V1 processing lease was lost or source changed.',
      )
    const retained = await tx.intakeV1ProcessingDispatch.findFirst({
      where: {
        id: exact.id,
        tenantId: exact.tenantId,
        venueId: exact.venueId,
        revisionId: { not: '' },
      },
      select: {
        id: true,
        revisionId: true,
        memberId: true,
        status: true,
        receiptId: true,
        completedAt: true,
      },
    })
    if (!retained || retained.status !== 'COMPLETED' || retained.receiptId !== exact.receiptId)
      throw new IntakeV1ProcessingDispatchError(
        'CONFLICT',
        'Completed V1 processing state was not retained.',
      )
    return retained
  })
}

export async function holdIntakeV1ProcessingDispatch(
  input: z.input<typeof exactSchema> & {
    receiptId: string
    reason: 'INACCESSIBLE' | 'RESEARCH_FAILED'
  },
  client: Pick<typeof db, '$transaction'> = db,
) {
  const exact = exactSchema
    .extend({ receiptId: z.string().uuid(), reason: z.enum(['INACCESSIBLE', 'RESEARCH_FAILED']) })
    .parse(input)
  return client.$transaction(async (tx) => {
    await lockProcessingDispatch(tx, exact)
    const now = await processingDatabaseClock(tx)
    const receipt = await tx.intakeWebsiteResearchReceipt.findFirst({
      where: { id: exact.receiptId, tenantId: exact.tenantId, venueId: exact.venueId },
      select: { id: true, runId: true, outcome: true },
    })
    const dispatch = await tx.intakeV1ProcessingDispatch.findFirst({
      where: { id: exact.id, tenantId: exact.tenantId, venueId: exact.venueId },
      select: { intakeRunId: true },
    })
    if (
      !receipt ||
      receipt.id !== exact.operationId ||
      receipt.runId !== dispatch?.intakeRunId ||
      receipt.outcome === 'SUCCEEDED'
    )
      throw new IntakeV1ProcessingDispatchError(
        'CONFLICT',
        'Held research receipt does not match the dispatch.',
      )
    const changed = await tx.intakeV1ProcessingDispatch.updateMany({
      where: {
        id: exact.id,
        tenantId: exact.tenantId,
        venueId: exact.venueId,
        operationId: exact.operationId,
        sourceHash: exact.sourceHash,
        kind: 'WEBSITE_RESEARCH',
        status: 'LEASED',
        leaseToken: exact.leaseToken,
        leaseExpiresAt: { gt: now },
      },
      data: {
        status: 'HELD',
        receiptId: exact.receiptId,
        holdReason: exact.reason,
        leaseToken: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: now,
      },
    })
    if (changed.count !== 1)
      throw new IntakeV1ProcessingDispatchError(
        'CONFLICT',
        'V1 processing lease was lost or source changed.',
      )
    const retained = await tx.intakeV1ProcessingDispatch.findFirst({
      where: { id: exact.id, tenantId: exact.tenantId, venueId: exact.venueId },
      select: {
        id: true,
        revisionId: true,
        memberId: true,
        status: true,
        receiptId: true,
        holdReason: true,
        completedAt: true,
      },
    })
    if (
      !retained ||
      retained.status !== 'HELD' ||
      retained.receiptId !== exact.receiptId ||
      retained.holdReason !== exact.reason
    )
      throw new IntakeV1ProcessingDispatchError(
        'CONFLICT',
        'Held V1 processing state was not retained.',
      )
    return retained
  })
}

/** After claim and before network, inherits any terminal canonical receipt created since enqueue. */
export async function preflightIntakeV1WebsiteResearchDispatch(
  input: z.input<typeof exactSchema> & { policyVersion: string },
  client: Pick<typeof db, '$transaction'> = db,
) {
  const exact = exactSchema
    .extend({ policyVersion: z.literal(INTAKE_V1_PROCESSING_POLICY_VERSION) })
    .parse(input)
  return client.$transaction(async (tx) => {
    await lockProcessingDispatch(tx, exact)
    const active = await assertIntakeV1WebsiteResearchDispatchActive(exact, tx)
    if (!active)
      throw new IntakeV1ProcessingDispatchError(
        'CONFLICT',
        'V1 processing lease was lost or source changed.',
      )
    const dispatch = await tx.intakeV1ProcessingDispatch.findFirst({
      where: { id: exact.id, tenantId: exact.tenantId, venueId: exact.venueId },
      select: {
        intakeRun: { select: { websiteUri: true, submissionInputHash: true } },
        member: { select: { immutableHash: true } },
      },
    })
    if (
      !dispatch?.intakeRun.websiteUri ||
      dispatch.intakeRun.submissionInputHash !== dispatch.member.immutableHash ||
      dispatch.member.immutableHash !== exact.sourceHash
    )
      throw new IntakeV1ProcessingDispatchError(
        'CONFLICT',
        'Website member source identity changed.',
      )
    const sourceUriHash = createHash('sha256').update(dispatch.intakeRun.websiteUri).digest('hex')
    const receipt = await tx.intakeWebsiteResearchReceipt.findFirst({
      where: { tenantId: exact.tenantId, venueId: exact.venueId, runId: active.intakeRunId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, outcome: true, sourceUriHash: true },
    })
    if (!receipt) return { state: 'EXECUTE' as const, dispatch: active }
    if (receipt.sourceUriHash !== sourceUriHash)
      throw new IntakeV1ProcessingDispatchError(
        'CONFLICT',
        'Stored website research source identity changed.',
      )
    const now = await processingDatabaseClock(tx)
    const status = receipt.outcome === 'SUCCEEDED' ? ('COMPLETED' as const) : ('HELD' as const)
    const holdReason = receipt.outcome === 'SUCCEEDED' ? null : 'PRIOR_RESEARCH_NOT_SUCCESSFUL'
    const changed = await tx.intakeV1ProcessingDispatch.updateMany({
      where: {
        id: exact.id,
        tenantId: exact.tenantId,
        venueId: exact.venueId,
        status: 'LEASED',
        leaseToken: exact.leaseToken,
      },
      data: {
        status,
        receiptId: receipt.id,
        holdReason,
        leaseToken: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: now,
      },
    })
    if (changed.count !== 1)
      throw new IntakeV1ProcessingDispatchError('CONFLICT', 'V1 processing preflight raced.')
    const retained = await tx.intakeV1ProcessingDispatch.findFirst({
      where: { id: exact.id, tenantId: exact.tenantId, venueId: exact.venueId },
      select: {
        id: true,
        revisionId: true,
        memberId: true,
        status: true,
        receiptId: true,
        holdReason: true,
      },
    })
    if (!retained || retained.status !== status || retained.receiptId !== receipt.id)
      throw new IntakeV1ProcessingDispatchError(
        'CONFLICT',
        'V1 processing preflight was not retained.',
      )
    return { state: 'INHERITED' as const, dispatch: retained }
  })
}

export async function failIntakeV1ProcessingDispatch(
  input: z.input<typeof exactSchema> & { error: string },
  client: Pick<typeof db, '$transaction'> = db,
) {
  const exact = exactSchema.extend({ error: z.string().trim().min(1).max(500) }).parse(input)
  return client.$transaction(async (tx) => {
    await lockProcessingDispatch(tx, exact)
    const now = await processingDatabaseClock(tx)
    const row = await tx.intakeV1ProcessingDispatch.findFirst({
      where: { id: exact.id, tenantId: exact.tenantId, venueId: exact.venueId },
      select: { attempts: true },
    })
    if (!row)
      throw new IntakeV1ProcessingDispatchError('NOT_FOUND', 'V1 processing dispatch not found.')
    const terminal = row.attempts >= INTAKE_V1_PROCESSING_MAX_ATTEMPTS
    const changed = await tx.intakeV1ProcessingDispatch.updateMany({
      where: {
        id: exact.id,
        tenantId: exact.tenantId,
        venueId: exact.venueId,
        operationId: exact.operationId,
        sourceHash: exact.sourceHash,
        status: 'LEASED',
        leaseToken: exact.leaseToken,
        leaseExpiresAt: { gt: now },
      },
      data: terminal
        ? {
            status: 'FAILED',
            lastError: exact.error,
            leaseToken: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            completedAt: now,
          }
        : {
            status: 'PENDING',
            lastError: exact.error,
            leaseToken: null,
            leaseOwner: null,
            leaseExpiresAt: null,
          },
    })
    if (changed.count !== 1)
      throw new IntakeV1ProcessingDispatchError(
        'CONFLICT',
        'V1 processing lease was lost or source changed.',
      )
    return {
      id: exact.id,
      status: terminal ? ('FAILED' as const) : ('PENDING' as const),
      attempts: row.attempts,
    }
  })
}
