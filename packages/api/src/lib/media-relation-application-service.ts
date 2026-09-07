import { db, lockVenueContentMutation, writeAuditLogStrict } from '@pathfinder/db'
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library'
import { MediaResolutionStateSchema } from '@pathfinder/contracts/media-resolution-state'
import { ApplyMediaRelationInput, reviewedTraversalDraft } from './media-relation-application'
import { mediaIntakeHash } from './media-intake-snapshot'
import { validateResolutionEvidence } from './media-resolution-evidence'

type Client = Pick<typeof db, '$transaction' | '$queryRaw'>
type Receipt = {
  id: string
  connectionId: string
  requestHash: string
  actorId: string
  inputSnapshot: unknown
}
export class MediaRelationApplicationError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST',
    message: string,
  ) {
    super(message)
    this.name = 'MediaRelationApplicationError'
  }
}

function replay(receipt: Receipt, requestHash: string, actorId: string) {
  if (receipt.requestHash !== requestHash || receipt.actorId !== actorId)
    throw new MediaRelationApplicationError(
      'CONFLICT',
      'This application request is already bound to another reviewed route.',
    )
  const snapshot = receipt.inputSnapshot as { input?: unknown; actorId?: unknown } | null
  const storedInput = ApplyMediaRelationInput.safeParse(snapshot?.input)
  if (
    !snapshot ||
    !storedInput.success ||
    receipt.connectionId !== storedInput.data.requestId ||
    mediaIntakeHash({ input: snapshot.input, actorId: snapshot.actorId }) !== requestHash
  )
    throw new MediaRelationApplicationError(
      'CONFLICT',
      'The stored application receipt failed its integrity check.',
    )
  return {
    receiptId: receipt.id,
    connectionId: receipt.connectionId,
    createdAs: 'INACTIVE_DRAFT' as const,
    replayed: true,
  }
}

/** Caller must establish platform-human authority and venue availability. No activation occurs here. */
export async function applyMediaRelationDraft(params: {
  client: Client
  input: unknown
  actorId: string
}) {
  const input = ApplyMediaRelationInput.parse(params.input)
  if (!params.actorId.trim() || params.actorId.length > 191)
    throw new MediaRelationApplicationError('BAD_REQUEST', 'A reviewer identity is required.')
  const requestHash = mediaIntakeHash({ input, actorId: params.actorId })
  try {
    return await params.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['media-relation-application', input.tenantId, input.requestId])}, 0))`
        const receipts = await tx.$queryRaw<Receipt[]>`
        SELECT id, connection_id AS "connectionId", request_hash AS "requestHash", actor_id AS "actorId", input_snapshot AS "inputSnapshot"
        FROM media_relation_applications WHERE tenant_id = ${input.tenantId} AND request_id = ${input.requestId}::uuid LIMIT 1
      `
        if (receipts[0]) return replay(receipts[0], requestHash, params.actorId)

        const projects = await tx.$queryRaw<
          Array<{
            uploadAttemptId: string | null
            sourceObjectKey: string | null
            updatedAt: Date
            findings: unknown
          }>
        >`
        SELECT upload_attempt_id AS "uploadAttemptId", source_object_key AS "sourceObjectKey", updated_at AS "updatedAt",
          CASE WHEN octet_length(findings::text) <= 8388608 THEN findings ELSE NULL END AS findings
        FROM media_ingestion_projects WHERE id = ${input.projectId} AND tenant_id = ${input.tenantId} AND venue_id = ${input.venueId}
          AND source_object_generation = ${input.sourceGeneration}::uuid AND status = 'READY_FOR_REVIEW' AND stage = 'review' FOR UPDATE
      `
        const project = projects[0]
        if (
          !project?.uploadAttemptId ||
          !project.sourceObjectKey ||
          !project.findings ||
          project.updatedAt.toISOString() !== input.expectedMediaUpdatedAt
        )
          throw new MediaRelationApplicationError(
            'CONFLICT',
            'The exact current media review is unavailable or changed.',
          )
        const revisions = await tx.$queryRaw<
          Array<{
            id: string
            revision: number
            state: unknown
            evidenceSnapshot: unknown
            evidenceSnapshotHash: string
          }>
        >`
        SELECT id, revision, state, evidence_snapshot AS "evidenceSnapshot", evidence_snapshot_hash AS "evidenceSnapshotHash"
        FROM media_entity_resolution_revisions WHERE tenant_id = ${input.tenantId} AND venue_id = ${input.venueId}
          AND project_id = ${input.projectId} AND source_generation = ${input.sourceGeneration}::uuid ORDER BY revision DESC LIMIT 1
      `
        const revision = revisions[0]
        if (!revision || revision.id !== input.revisionId)
          throw new MediaRelationApplicationError(
            'CONFLICT',
            'Reload the latest relation review before applying a route draft.',
          )
        const state = MediaResolutionStateSchema.parse(revision.state)
        if (
          state.decisions.length + 1 !== revision.revision ||
          state.scope.tenantId !== input.tenantId ||
          state.scope.projectId !== input.projectId ||
          state.scope.uploadAttemptId !== project.uploadAttemptId ||
          mediaIntakeHash(revision.evidenceSnapshot) !== revision.evidenceSnapshotHash
        )
          throw new MediaRelationApplicationError(
            'CONFLICT',
            'Stored relation evidence failed its scope or integrity check.',
          )
        let reviewedDraft: ReturnType<typeof reviewedTraversalDraft>
        try {
          reviewedDraft = reviewedTraversalDraft(
            state,
            input.relationId,
            input.relationReviewRequestId,
          )
        } catch (error) {
          throw new MediaRelationApplicationError(
            'BAD_REQUEST',
            error instanceof Error ? error.message : 'The route review is incomplete.',
          )
        }
        const sourceIds = [
          ...new Set(
            state.candidates.flatMap((candidate) =>
              candidate.evidence.map((locator) => locator.sourceId),
            ),
          ),
        ]
        await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM media_ingestion_assets WHERE tenant_id = ${input.tenantId} AND project_id = ${input.projectId}
          AND source_id = ANY(${sourceIds}::text[]) FOR SHARE
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
        try {
          const evidence = validateResolutionEvidence({
            scope: state.scope,
            sourceGeneration: input.sourceGeneration,
            candidates: state.candidates,
            findings: project.findings,
            assets,
          })
          if (evidence.evidenceSnapshotHash !== revision.evidenceSnapshotHash)
            throw new Error('The reviewed source evidence changed.')
        } catch (error) {
          throw new MediaRelationApplicationError(
            'CONFLICT',
            error instanceof Error ? error.message : 'Source evidence is unavailable.',
          )
        }

        await lockVenueContentMutation(tx, input)
        const locations = await tx.venueLocation.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            id: { in: [input.fromLocationId, input.toLocationId] },
            isActive: true,
            visibility: 'PUBLIC',
          },
          select: { id: true, updatedAt: true },
        })
        const from = locations.find((location) => location.id === input.fromLocationId)
        const to = locations.find((location) => location.id === input.toLocationId)
        if (
          !from ||
          !to ||
          from.updatedAt.toISOString() !== input.fromLocationUpdatedAt ||
          to.updatedAt.toISOString() !== input.toLocationUpdatedAt
        )
          throw new MediaRelationApplicationError(
            'CONFLICT',
            'Both reviewed location anchors must still be active, public and unchanged in this venue.',
          )
        const priorApplications = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM media_relation_applications WHERE tenant_id = ${input.tenantId} AND venue_id = ${input.venueId}
          AND relation_review_request_id = ${input.relationReviewRequestId}::uuid LIMIT 1
      `
        if (priorApplications[0])
          throw new MediaRelationApplicationError(
            'CONFLICT',
            'This reviewed relation already has a canonical draft; open that draft instead of applying it again.',
          )
        const connection = await tx.venueLocationConnection.create({
          data: {
            id: input.requestId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            fromLocationId: input.fromLocationId,
            toLocationId: input.toLocationId,
            kind: reviewedDraft.kind,
            bidirectional: reviewedDraft.bidirectional,
            accessible: reviewedDraft.accessible,
            directions: reviewedDraft.directions,
            verifiedAt: new Date(),
            verifiedBy: params.actorId,
            isActive: false,
          },
          select: { id: true },
        })
        const inputSnapshot = {
          input,
          actorId: params.actorId,
          reviewedDraft,
          evidenceSnapshotHash: revision.evidenceSnapshotHash,
          stateHash: mediaIntakeHash(state),
        }
        const snapshotText = JSON.stringify(inputSnapshot)
        if (Buffer.byteLength(snapshotText) > 262144)
          throw new MediaRelationApplicationError(
            'BAD_REQUEST',
            'The reviewed route application exceeds its retained receipt limit.',
          )
        const created = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO media_relation_applications (tenant_id, venue_id, revision_id, relation_id, relation_review_request_id, request_id, request_hash, actor_id, connection_id, input_snapshot)
        VALUES (${input.tenantId}, ${input.venueId}, ${input.revisionId}::uuid, ${input.relationId}, ${input.relationReviewRequestId}::uuid, ${input.requestId}::uuid, ${requestHash}, ${params.actorId}, ${connection.id}::uuid, ${snapshotText}::jsonb)
        RETURNING id
      `
        if (!created[0]) throw new Error('Route application receipt was not retained.')
        await writeAuditLogStrict(
          {
            tenantId: input.tenantId,
            actorId: params.actorId,
            actorRole: 'PLATFORM_ADMIN',
            action: 'media.relation.inactive-route-created',
            targetType: 'VenueLocationConnection',
            targetId: connection.id,
            idempotencyKey: input.requestId,
            afterState: {
              receiptId: created[0].id,
              revisionId: revision.id,
              relationId: input.relationId,
              isActive: false,
              evidenceSnapshotHash: revision.evidenceSnapshotHash,
              rationale: input.rationale,
            },
          },
          tx,
        )
        return {
          receiptId: created[0].id,
          connectionId: connection.id,
          createdAs: 'INACTIVE_DRAFT' as const,
          replayed: false,
        }
      },
      { isolationLevel: 'Serializable' },
    )
  } catch (error) {
    const receipts = await params.client.$queryRaw<Receipt[]>`
      SELECT id, connection_id AS "connectionId", request_hash AS "requestHash", actor_id AS "actorId", input_snapshot AS "inputSnapshot"
      FROM media_relation_applications WHERE tenant_id = ${input.tenantId} AND request_id = ${input.requestId}::uuid LIMIT 1
    `
    if (receipts[0]) return replay(receipts[0], requestHash, params.actorId)
    if (error instanceof PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new MediaRelationApplicationError(
        'CONFLICT',
        'This connection or application identity already exists; review the existing route draft.',
      )
    }
    throw error
  }
}
