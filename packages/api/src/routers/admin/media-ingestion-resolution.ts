import { TRPCError } from '@trpc/server'
import { mediaEvidenceLocatorId } from '@pathfinder/contracts/media-entity-resolution'
import { z } from 'zod'
import { assertVenueAvailable, db, withTenantIsolationBypass } from '@pathfinder/db'
import {
  MediaResolutionStateSchema,
  projectMediaResolution,
} from '@pathfinder/contracts/media-resolution-state'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { deriveResolutionCandidates } from '../../lib/media-resolution-evidence'
import {
  MediaResolutionError,
  SaveMediaResolutionInput,
  saveMediaResolution,
} from '../../lib/media-resolution-service'
import { mediaIntakeHash } from '../../lib/media-intake-snapshot'

const scope = z
  .object({
    tenantId: z.string().min(1).max(191),
    venueId: z.string().min(1).max(191),
    projectId: z.string().min(1).max(191),
    sourceGeneration: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict()

export const mediaIngestionResolutionRouter = router({
  readIdentityEvidence: adminProcedure
    .input(
      scope.extend({
        revisionId: z.string().uuid(),
        offset: z.number().int().min(0).max(50_000_000).default(0),
      }),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        await assertVenueAvailable(db, input)
        const row = await db.mediaEntityResolutionRevision.findFirst({
          where: {
            id: input.revisionId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            projectId: input.projectId,
            sourceGeneration: input.sourceGeneration,
          },
          select: { id: true, evidenceSnapshot: true, evidenceSnapshotHash: true },
        })
        if (!row)
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Retained identity evidence is unavailable.',
          })
        if (mediaIntakeHash(row.evidenceSnapshot) !== row.evidenceSnapshotHash)
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Retained identity evidence failed its integrity check.',
          })
        const text = JSON.stringify(row.evidenceSnapshot, null, 2)
        if (
          input.offset > text.length ||
          (input.offset > 0 && /[\uDC00-\uDFFF]/u.test(text.charAt(input.offset)))
        )
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid evidence page offset.' })
        let end = Math.min(input.offset + 20_000, text.length)
        if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end -= 1
        const snapshot = row.evidenceSnapshot as { sources?: unknown[] }
        return {
          runId: row.id,
          snapshotHash: row.evidenceSnapshotHash,
          text: text.slice(input.offset, end),
          offset: input.offset,
          nextOffset: end < text.length ? end : null,
          totalCodeUnits: text.length,
          sourceCount: snapshot.sources?.length ?? 0,
        }
      }),
    ),
  previewIdentityCandidates: adminProcedure.input(scope).query(({ input }) =>
    withTenantIsolationBypass(async () => {
      await assertVenueAvailable(db, input)
      const projects = await db.$queryRaw<
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
      AND source_object_generation = ${input.sourceGeneration}::uuid AND status = 'READY_FOR_REVIEW' AND stage = 'review'
      LIMIT 1
    `
      const project = projects[0]
      if (!project?.uploadAttemptId || !project.sourceObjectKey || !project.findings)
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Save a complete bounded media review before resolving identities.',
        })
      const assets = await db.mediaIngestionAsset.findMany({
        where: {
          tenantId: input.tenantId,
          projectId: input.projectId,
          objectKey: { startsWith: `${project.sourceObjectKey}#` },
          status: 'COMPLETE',
        },
        take: 10_001,
        select: { sourceId: true, sha256: true, status: true },
      })
      if (assets.length > 10_000)
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Source inventory exceeds the identity review limit.',
        })
      return {
        ...deriveResolutionCandidates({
          scope: {
            tenantId: input.tenantId,
            projectId: input.projectId,
            uploadAttemptId: project.uploadAttemptId,
          },
          findings: project.findings,
          assets,
        }),
        expectedUpdatedAt: project.updatedAt.toISOString(),
      }
    }),
  ),
  getIdentityReview: adminProcedure.input(scope).query(({ input }) =>
    withTenantIsolationBypass(async () => {
      await assertVenueAvailable(db, input)
      const row = await db.mediaEntityResolutionRevision.findFirst({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          projectId: input.projectId,
          sourceGeneration: input.sourceGeneration,
        },
        orderBy: { revision: 'desc' },
        select: {
          id: true,
          revision: true,
          state: true,
          evidenceSnapshotHash: true,
          createdAt: true,
        },
      })
      if (!row) return null
      const state = MediaResolutionStateSchema.parse(row.state)
      return {
        id: row.id,
        revision: row.revision,
        evidenceSnapshotHash: row.evidenceSnapshotHash,
        createdAt: row.createdAt,
        projection: projectMediaResolution(state),
        candidates: state.candidates.map(({ candidateId, label, kind, evidence }) => ({
          candidateId,
          label,
          kind,
          evidenceLocatorIds: evidence.map(mediaEvidenceLocatorId),
          sourceIds: [...new Set(evidence.map((item) => item.sourceId))],
        })),
        decisions: state.decisions,
      }
    }),
  ),
  saveIdentityReview: adminProcedure
    .input(SaveMediaResolutionInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await withTenantIsolationBypass(async () => {
          await assertVenueAvailable(db, input)
          return saveMediaResolution({ client: db, input, actorId: ctx.session.userId })
        })
      } catch (error) {
        if (error instanceof MediaResolutionError)
          throw new TRPCError({
            code: error.code === 'INVALID_REVIEW' ? 'BAD_REQUEST' : error.code,
            message: error.message,
          })
        throw error
      }
    }),
})
