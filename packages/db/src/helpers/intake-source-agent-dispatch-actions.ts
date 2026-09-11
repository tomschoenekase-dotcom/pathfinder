import { z } from 'zod'
import { db } from '../client'
import { createSystemSourceAgentTaskInTransaction } from './agent-task-actions'
import { assertIntakeSourceAgentRoutingInTransaction } from './intake-source-agent-routing-actions'

type Client = Pick<typeof db, '$transaction' | 'intakeSourceAgentDispatch'>
const scopeSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().min(1).max(191),
    venueId: z.string().min(1).max(191),
  })
  .strict()
export async function listPendingIntakeSourceAgentDispatches(
  input: { limit?: number },
  client: Pick<typeof db, '$queryRaw'> = db,
) {
  const { limit } = z
    .object({ limit: z.number().int().min(1).max(100).default(25) })
    .strict()
    .parse(input)
  return client.$queryRaw<
    Array<{ id: string; tenantId: string; venueId: string }>
  >`SELECT d.id,d.tenant_id AS "tenantId",d.venue_id AS "venueId" FROM intake_source_agent_dispatches d WHERE (d.status IN ('PENDING','HELD') OR (d.status='COMPLETED' AND EXISTS (SELECT 1 FROM agent_runs r WHERE r.id=d.agent_run_id AND r.tenant_id=d.tenant_id AND r.venue_id=d.venue_id AND r.status='QUEUED'))) AND d.next_attempt_at <= clock_timestamp() ORDER BY d.next_attempt_at,d.id LIMIT ${limit}`
}

/** Recover metadata for pre-outbox completed extraction rows, without re-extraction or
 * task creation. Concurrent sweeps converge on the extraction unique key. Current
 * review/routing/identity authority is independently rechecked by dispatch. */
export async function recoverMissingIntakeSourceAgentDispatches(
  input: { limit?: number },
  client: Pick<typeof db, '$executeRaw'> = db,
) {
  const { limit } = z
    .object({ limit: z.number().int().min(1).max(100).default(25) })
    .strict()
    .parse(input)
  return client.$executeRaw`INSERT INTO intake_source_agent_dispatches
    (id,tenant_id,venue_id,extraction_dispatch_id,intake_run_id,receipt_id,extracted_text_hash,updated_at)
    SELECT gen_random_uuid(),d.tenant_id,d.venue_id,d.id,d.intake_run_id,r.id,r.extracted_text_hash,clock_timestamp()
    FROM intake_v1_processing_dispatches d
    JOIN intake_file_extraction_receipts r ON r.id=d.file_extraction_receipt_id
      AND r.tenant_id=d.tenant_id AND r.venue_id=d.venue_id AND r.run_id=d.intake_run_id
    JOIN intake_runs i ON i.id=d.intake_run_id AND i.tenant_id=d.tenant_id AND i.venue_id=d.venue_id
    WHERE d.kind='FILE_EXTRACTION' AND d.status='COMPLETED' AND r.outcome='SUCCEEDED'
      AND r.extracted_text_hash IS NOT NULL AND i.source_kind='FILE_UPLOAD' AND i.status='AWAITING_REVIEW'
      AND NOT EXISTS (SELECT 1 FROM intake_file_extraction_reviews v WHERE v.receipt_id=r.id)
      AND NOT EXISTS (SELECT 1 FROM intake_source_agent_dispatches existing WHERE existing.extraction_dispatch_id=d.id)
    ORDER BY d.created_at,d.id LIMIT ${limit}
    ON CONFLICT (extraction_dispatch_id) DO NOTHING`
}

/** No network or provider work. Source review lock precedes task/policy locks; never called
 * from inside the extraction transaction, which holds upload/processing locks. */
export async function dispatchIntakeSourceAgentTask(
  raw: z.input<typeof scopeSchema>,
  client: Client = db,
): Promise<{ status: 'COMPLETED' | 'HELD' | 'CANCELLED'; runId?: string; replayed?: boolean }> {
  const scope = scopeSchema.parse(raw)
  const initial = await client.intakeSourceAgentDispatch.findFirst({ where: scope })
  if (!initial) throw new Error('Source task dispatch unavailable')
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:intake-file-extraction-review:${scope.tenantId}:${scope.venueId}:${initial.receiptId}`}, 0))`
    await tx.$queryRaw`SELECT id FROM intake_source_agent_dispatches WHERE id=${scope.id}::uuid AND tenant_id=${scope.tenantId} AND venue_id=${scope.venueId} FOR UPDATE`
    const row = await tx.intakeSourceAgentDispatch.findFirstOrThrow({ where: scope })
    if (row.receiptId !== initial.receiptId)
      throw new Error('Source task dispatch identity changed')
    // Task and dispatch completion commit together. Recover the immutable result even when
    // routing or source state later changes; recovery never creates or reassigns a task.
    if (row.status === 'COMPLETED' && row.agentRunId) {
      await tx.$executeRaw`UPDATE intake_source_agent_dispatches SET next_attempt_at=clock_timestamp()+interval '60 seconds', updated_at=clock_timestamp() WHERE id=${scope.id}::uuid AND tenant_id=${scope.tenantId} AND venue_id=${scope.venueId}`
      return { status: 'COMPLETED', runId: row.agentRunId, replayed: true }
    }
    if (row.status === 'CANCELLED') return { status: 'CANCELLED', replayed: true }
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
    if (!clock) throw new Error('Database clock unavailable')
    const hold = async (reason: string) => {
      await tx.intakeSourceAgentDispatch.update({
        where: scope,
        data: {
          status: 'HELD',
          holdReason: reason,
          nextAttemptAt: new Date(clock.now.getTime() + 60_000),
        },
      })
      return { status: 'HELD' as const }
    }
    const receipt = await tx.intakeFileExtractionReceipt.findFirst({
      where: {
        id: row.receiptId,
        tenantId: row.tenantId,
        venueId: row.venueId,
        runId: row.intakeRunId,
        outcome: 'SUCCEEDED',
        extractedTextHash: row.extractedTextHash,
        review: { is: null },
        run: { sourceKind: 'FILE_UPLOAD', status: 'AWAITING_REVIEW' },
      },
      select: { id: true },
    })
    const extraction = await tx.intakeV1ProcessingDispatch.findFirst({
      where: {
        id: row.extractionDispatchId,
        tenantId: row.tenantId,
        venueId: row.venueId,
        kind: 'FILE_EXTRACTION',
        status: 'COMPLETED',
        intakeRunId: row.intakeRunId,
        fileExtractionReceiptId: row.receiptId,
      },
      select: { id: true },
    })
    if (!receipt || !extraction) {
      await tx.intakeSourceAgentDispatch.update({
        where: scope,
        data: { status: 'CANCELLED', holdReason: 'SOURCE_UNAVAILABLE' },
      })
      return { status: 'CANCELLED' }
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:agent-task-operation:${scope.tenantId}:${row.id}`}, 0))`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:intake-source-routing:${scope.tenantId}:${scope.venueId}`}, 0))`
    const policy = await tx.intakeSourceAgentRoutingPolicy.findFirst({
      where: { tenantId: scope.tenantId, venueId: scope.venueId },
    })
    if (!policy) return hold('ROUTING_UNCONFIGURED')
    if (!policy.enabled) return hold('ROUTING_DISABLED')
    const identity = await tx.agentIdentity.findFirst({
      where: {
        id: policy.agentIdentityId,
        tenantId: row.tenantId,
        enabled: true,
        agentType: 'CONTENT',
        accessCapabilities: { hasEvery: ['intake.read', 'content.draft'] },
        autonomousActions: { has: 'content.prepare-draft' },
        autonomyLevel: { not: 'READ_ONLY' },
        defaultProvider: { not: null },
        defaultModel: { not: null },
        OR: [{ venueId: row.venueId }, { venueId: null, accessScope: 'CLIENT' }],
      },
      select: { id: true },
    })
    if (!identity) return hold('IDENTITY_UNAVAILABLE')
    const taskInput = {
      tenantId: row.tenantId,
      venueId: row.venueId,
      operationId: row.id,
      agentIdentityId: policy.agentIdentityId,
      dispatchId: row.id,
      policyRevision: policy.revision,
      sourceAssignment: {
        version: 1 as const,
        kind: 'FILE_EXTRACTION' as const,
        intakeRunId: row.intakeRunId,
        receiptId: row.receiptId,
        extractedTextHash: row.extractedTextHash,
      },
    }
    const task = await createSystemSourceAgentTaskInTransaction(tx, taskInput, {
      admitTask: async () => {
        await assertIntakeSourceAgentRoutingInTransaction(tx, taskInput)
      },
    })
    await tx.intakeSourceAgentDispatch.update({
      where: scope,
      data: {
        status: 'COMPLETED',
        agentRunId: task.run.id,
        agentIdentityId: policy.agentIdentityId,
        policyRevision: policy.revision,
        holdReason: null,
      },
    })
    return { status: 'COMPLETED', runId: task.run.id, replayed: task.replayed }
  })
}
