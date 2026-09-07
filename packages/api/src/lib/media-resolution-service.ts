import { z } from 'zod'
import { db, writeAuditLogStrict } from '@pathfinder/db'
import { MediaEntityCandidateSchema } from '@pathfinder/contracts/media-entity-resolution'
import {
  appendMediaResolutionDecision,
  createMediaResolutionState,
  MediaResolutionStateSchema,
  projectMediaResolution,
  MediaRelationProposalDecisionInputSchema,
  MediaRelationReviewDecisionInputSchema,
  MediaRelationRevertDecisionInputSchema,
} from '@pathfinder/contracts/media-resolution-state'
import { mediaIntakeHash } from './media-intake-snapshot'
import { validateResolutionEvidence } from './media-resolution-evidence'

const id = z.string().min(1).max(191)
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const decision = z.union([
  z
    .object({
      kind: z.literal('MERGE'),
      candidateIds: z.array(id).min(2).max(100),
      representativeId: id,
      rationale: z.string().trim().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('REVERT_MERGE'),
      mergeRequestId: uuid,
      rationale: z.string().trim().min(1).max(2000),
    })
    .strict(),
  MediaRelationProposalDecisionInputSchema,
  MediaRelationReviewDecisionInputSchema,
  MediaRelationRevertDecisionInputSchema,
])
export const SaveMediaResolutionInput = z
  .object({
    tenantId: id,
    venueId: id,
    projectId: id,
    sourceGeneration: uuid,
    requestId: uuid,
    expectedUpdatedAt: z.string().datetime(),
    expectedRevision: z.number().int().min(0).max(500),
    candidates: z.array(MediaEntityCandidateSchema).min(1).max(500).optional(),
    decision: decision.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.expectedRevision === 0
        ? !value.candidates || value.decision
        : value.candidates || !value.decision
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Start with frozen candidates; later revisions append one review decision.',
      })
    }
  })

type Client = Pick<typeof db, '$transaction' | '$queryRaw'>
type Revision = {
  id: string
  revision: number
  requestHash: string
  evidenceSnapshotHash: string
  evidenceSnapshot: unknown
  state: unknown
  actorId: string
}

export class MediaResolutionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_REVIEW',
    message: string,
  ) {
    super(message)
    this.name = 'MediaResolutionError'
  }
}

function readback(row: Revision, replayed: boolean) {
  const state = MediaResolutionStateSchema.parse(row.state)
  if (row.revision !== state.decisions.length + 1)
    throw new MediaResolutionError(
      'INVALID_REVIEW',
      'Stored identity revision does not match its decision history.',
    )
  const snapshot = row.evidenceSnapshot as { scope?: unknown; candidates?: unknown } | null
  if (
    !snapshot ||
    mediaIntakeHash(snapshot) !== row.evidenceSnapshotHash ||
    mediaIntakeHash(snapshot.scope) !== mediaIntakeHash(state.scope) ||
    mediaIntakeHash(snapshot.candidates) !== mediaIntakeHash(state.candidates)
  )
    throw new MediaResolutionError(
      'INVALID_REVIEW',
      'Stored identity review evidence failed its integrity check.',
    )
  return {
    id: row.id,
    revision: row.revision,
    evidenceSnapshotHash: row.evidenceSnapshotHash,
    projection: projectMediaResolution(state),
    replayed,
  }
}

export async function saveMediaResolution(params: {
  client: Client
  actorId: string
  input: unknown
}) {
  const input = SaveMediaResolutionInput.parse(params.input)
  if (!params.actorId.trim() || params.actorId.length > 191)
    throw new MediaResolutionError('INVALID_REVIEW', 'Reviewer identity is required.')
  if (Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 * 1024)
    throw new MediaResolutionError('INVALID_REVIEW', 'Review exceeds the retained evidence limit.')
  const requestHash = mediaIntakeHash({ input, actorId: params.actorId })
  try {
    return await params.client.$transaction(
      async (tx) => {
        // Serialize even cross-project reuse of a tenant request ID before exact receipt replay.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['media-resolution', input.tenantId, input.requestId])}, 0))`
        const previous = await tx.$queryRaw<Revision[]>`
      SELECT id, revision, request_hash AS "requestHash", evidence_snapshot_hash AS "evidenceSnapshotHash", evidence_snapshot AS "evidenceSnapshot", state, actor_id AS "actorId"
      FROM media_entity_resolution_revisions
      WHERE tenant_id = ${input.tenantId} AND request_id = ${input.requestId}::uuid
      LIMIT 1
    `
        if (previous[0]) {
          if (previous[0].requestHash !== requestHash || previous[0].actorId !== params.actorId)
            throw new MediaResolutionError(
              'CONFLICT',
              'This review request already records another decision.',
            )
          return readback(previous[0], true)
        }
        const projects = await tx.$queryRaw<
          Array<{
            uploadAttemptId: string | null
            updatedAt: Date
            sourceObjectKey: string | null
            findings: unknown
          }>
        >`
      SELECT upload_attempt_id AS "uploadAttemptId", updated_at AS "updatedAt", source_object_key AS "sourceObjectKey",
        CASE WHEN octet_length(findings::text) <= 8388608 THEN findings ELSE NULL END AS findings
      FROM media_ingestion_projects
      WHERE id = ${input.projectId} AND tenant_id = ${input.tenantId} AND venue_id = ${input.venueId}
        AND source_object_generation = ${input.sourceGeneration}::uuid AND status = 'READY_FOR_REVIEW' AND stage = 'review'
      FOR UPDATE
    `
        const project = projects[0]
        if (!project)
          throw new MediaResolutionError(
            'NOT_FOUND',
            'This media review generation is unavailable.',
          )
        if (
          !project.uploadAttemptId ||
          !project.sourceObjectKey ||
          !project.findings ||
          project.updatedAt.toISOString() !== input.expectedUpdatedAt
        ) {
          throw new MediaResolutionError(
            'CONFLICT',
            'Save and reload the current bounded media review before resolving identities.',
          )
        }
        const latestRows = await tx.$queryRaw<Revision[]>`
      SELECT id, revision, request_hash AS "requestHash", evidence_snapshot_hash AS "evidenceSnapshotHash", evidence_snapshot AS "evidenceSnapshot", state, actor_id AS "actorId"
      FROM media_entity_resolution_revisions
      WHERE tenant_id = ${input.tenantId} AND venue_id = ${input.venueId} AND project_id = ${input.projectId}
        AND source_generation = ${input.sourceGeneration}::uuid
      ORDER BY revision DESC LIMIT 1
    `
        const latest = latestRows[0]
        if ((latest?.revision ?? 0) !== input.expectedRevision)
          throw new MediaResolutionError(
            'CONFLICT',
            'Identity review advanced; reload before applying this decision.',
          )
        let state: z.infer<typeof MediaResolutionStateSchema>
        try {
          state = latest
            ? MediaResolutionStateSchema.parse(latest.state)
            : createMediaResolutionState(
                {
                  tenantId: input.tenantId,
                  projectId: input.projectId,
                  uploadAttemptId: project.uploadAttemptId,
                },
                input.candidates!,
              )
          if (latest) readback(latest, true)
        } catch (error) {
          throw new MediaResolutionError(
            'INVALID_REVIEW',
            error instanceof Error ? error.message : 'Invalid frozen identity state.',
          )
        }
        if (
          state.scope.tenantId !== input.tenantId ||
          state.scope.projectId !== input.projectId ||
          state.scope.uploadAttemptId !== project.uploadAttemptId
        )
          throw new MediaResolutionError('CONFLICT', 'Stored review authority changed.')
        const sourceIds = [
          ...new Set(
            state.candidates.flatMap((candidate) =>
              candidate.evidence.map((locator) => locator.sourceId),
            ),
          ),
        ]
        // Lock the project asset set before reading hashes so processing cannot race the receipt.
        await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM media_ingestion_assets WHERE tenant_id = ${input.tenantId} AND project_id = ${input.projectId} AND source_id = ANY(${sourceIds}::text[]) FOR SHARE
    `
        const assets = await tx.mediaIngestionAsset.findMany({
          where: {
            tenantId: input.tenantId,
            projectId: input.projectId,
            sourceId: { in: sourceIds },
            objectKey: { startsWith: `${project.sourceObjectKey}#` },
          },
          select: { sourceId: true, sha256: true, status: true },
        })
        let evidenceSnapshotHash: string
        let evidenceSnapshot: unknown
        try {
          const validatedEvidence = validateResolutionEvidence({
            scope: state.scope,
            sourceGeneration: input.sourceGeneration,
            candidates: state.candidates,
            findings: project.findings,
            assets,
          })
          evidenceSnapshotHash = validatedEvidence.evidenceSnapshotHash
          evidenceSnapshot = validatedEvidence.evidenceSnapshot
          if (latest && latest.evidenceSnapshotHash !== evidenceSnapshotHash)
            throw new Error('Frozen source evidence changed.')
          if (input.decision)
            state = appendMediaResolutionDecision(state, {
              ...input.decision,
              requestId: input.requestId,
              reviewerId: params.actorId,
            })
        } catch (error) {
          throw new MediaResolutionError(
            'INVALID_REVIEW',
            error instanceof Error ? error.message : 'Invalid source review.',
          )
        }
        const stateText = JSON.stringify(state)
        const evidenceText = JSON.stringify(evidenceSnapshot)
        if (Buffer.byteLength(stateText) + Buffer.byteLength(evidenceText) > 8 * 1024 * 1024)
          throw new MediaResolutionError(
            'INVALID_REVIEW',
            'Review history reached its retained evidence limit.',
          )
        const created = await tx.$queryRaw<Revision[]>`
      INSERT INTO media_entity_resolution_revisions (tenant_id, venue_id, project_id, source_generation, revision, request_id, request_hash, evidence_snapshot_hash, evidence_snapshot, state, actor_id)
      VALUES (${input.tenantId}, ${input.venueId}, ${input.projectId}, ${input.sourceGeneration}::uuid, ${input.expectedRevision + 1}, ${input.requestId}::uuid, ${requestHash}, ${evidenceSnapshotHash}, ${evidenceText}::jsonb, ${stateText}::jsonb, ${params.actorId})
      RETURNING id, revision, request_hash AS "requestHash", evidence_snapshot_hash AS "evidenceSnapshotHash", evidence_snapshot AS "evidenceSnapshot", state, actor_id AS "actorId"
    `
        await writeAuditLogStrict(
          {
            tenantId: input.tenantId,
            actorId: params.actorId,
            actorRole: 'PLATFORM_ADMIN',
            action: 'media.identity-review.revised',
            targetType: 'MediaIngestionProject',
            targetId: input.projectId,
            beforeState: { revision: input.expectedRevision },
            afterState: {
              revision: created[0]!.revision,
              evidenceSnapshotHash,
              decisionKind: input.decision?.kind ?? 'INITIALIZE',
              publication: 'NOT_PUBLISHED',
            },
          },
          tx,
        )
        return readback(created[0]!, false)
      },
      { isolationLevel: 'Serializable' },
    )
  } catch (error) {
    // A concurrent exact request may have committed while this serializable snapshot retried.
    const raced = await params.client.$queryRaw<Revision[]>`
      SELECT id, revision, request_hash AS "requestHash", evidence_snapshot_hash AS "evidenceSnapshotHash", evidence_snapshot AS "evidenceSnapshot", state, actor_id AS "actorId"
      FROM media_entity_resolution_revisions WHERE tenant_id = ${input.tenantId} AND request_id = ${input.requestId}::uuid LIMIT 1
    `
    if (raced[0]?.requestHash === requestHash && raced[0].actorId === params.actorId)
      return readback(raced[0], true)
    throw error
  }
}
