import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  db,
  withTenantIsolationBypass,
  submitCharacterCandidateReviewBrief,
  decideCharacterCandidateReview,
  characterCandidateArtifactFingerprint,
  readCustomCharacterFactoryAction,
} from '@pathfinder/db'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { createCharacterArtifactStorage } from '../../lib/character-artifact-storage'
import { readCharacterCandidateMasterPreview } from '../../lib/character-candidate-preview'

const id = z.string().trim().min(1).max(191)
const scope = { tenantId: id, venueId: id }
const snapshot = {
  ...scope,
  briefId: id,
  expectedVersion: z.number().int().positive(),
  expectedRevision: z.number().int().positive(),
  expectedArtifactFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
}

async function action<T>(fn: () => Promise<T>) {
  try {
    return await withTenantIsolationBypass(() => fn())
  } catch (error) {
    if (error instanceof TRPCError) throw error
    if (error instanceof z.ZodError)
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid candidate review input.' })
    if (error && typeof error === 'object' && 'code' in error) {
      if (error.code === 'CONFLICT' || error.code === 'NOT_FOUND' || error.code === 'INVALID_INPUT')
        throw new TRPCError({
          code: error.code === 'INVALID_INPUT' ? 'BAD_REQUEST' : error.code,
          message:
            error.code === 'CONFLICT'
              ? 'Candidate changed. Refresh this review.'
              : 'Candidate review is unavailable.',
        })
    }
    throw error
  }
}

export const adminCharacterCandidateReviewsRouter = router({
  submitCharacterCandidateReview: adminProcedure
    .input(
      z
        .object({
          ...scope,
          characterId: id,
          brief: z.string().trim().min(1).max(4000),
          rationale: z.string().trim().min(1).max(2000),
          sourceProvenance: z.enum(['IMPORTED', 'IMPORTED_FIXTURE', 'GENERATED']),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      action(() =>
        submitCharacterCandidateReviewBrief({
          ...input,
          actor: { type: 'HUMAN', role: 'PLATFORM_ADMIN', id: ctx.session.userId },
        }),
      ),
    ),

  listCharacterCandidateReviews: adminProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(40).default(12),
          cursor: z.object({ createdAt: z.coerce.date(), id }).strict().optional(),
        })
        .strict(),
    )
    .query(({ input }) =>
      action(async () => {
        const rows = await db.characterCandidateReviewBrief.findMany({
          where: {
            decision: { is: null },
            ...(input.cursor
              ? {
                  OR: [
                    { createdAt: { gt: input.cursor.createdAt } },
                    { createdAt: input.cursor.createdAt, id: { gt: input.cursor.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: input.limit + 1,
          include: {
            customCharacter: true,
            tenant: { select: { name: true } },
            venue: { select: { name: true } },
          },
        })
        return {
          hasMore: rows.length > input.limit,
          nextCursor:
            rows.length > input.limit && rows[input.limit - 1]
              ? { createdAt: rows[input.limit - 1]!.createdAt, id: rows[input.limit - 1]!.id }
              : null,
          items: rows.slice(0, input.limit).map((row) => {
            const current =
              row.customCharacter.status === 'REVIEW' &&
              row.customCharacter.version === row.candidateVersion &&
              row.customCharacter.revision === row.candidateRevision &&
              characterCandidateArtifactFingerprint(row.customCharacter) === row.artifactFingerprint
            const query = new URLSearchParams({
              tenantId: row.tenantId,
              venueId: row.venueId,
              briefId: row.id,
              expectedVersion: String(row.candidateVersion),
              expectedRevision: String(row.candidateRevision),
              expectedArtifactFingerprint: row.artifactFingerprint,
            })
            return {
              id: row.id,
              tenantId: row.tenantId,
              venueId: row.venueId,
              characterId: row.customCharacterId,
              clientName: row.tenant.name,
              venueName: row.venue.name,
              displayName: row.customCharacter.displayName,
              version: row.candidateVersion,
              revision: row.candidateRevision,
              artifactFingerprint: row.artifactFingerprint,
              brief: row.brief,
              rationale: row.rationale,
              provenance:
                row.sourceProvenance === 'IMPORTED_FIXTURE'
                  ? 'Imported fixture · reported by producer'
                  : row.sourceProvenance === 'IMPORTED'
                    ? 'Imported source · reported by producer'
                    : 'Generated source · reported by producer',
              current,
              previewHref:
                current && row.customCharacter.assetStorageReference
                  ? `/api/admin/character-candidate-preview?${query.toString()}`
                  : null,
            }
          }),
        }
      }),
    ),

  decideCharacterCandidateReview: adminProcedure
    .input(
      z
        .object({
          ...snapshot,
          operationId: z.string().uuid(),
          decision: z.enum(['ACCEPT', 'REJECT', 'REVISE']),
          revisionRequest: z.string().trim().min(1).max(2000).optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      action(async () => {
        const result = await decideCharacterCandidateReview({
          ...input,
          actor: { type: 'HUMAN', role: 'PLATFORM_ADMIN', id: ctx.session.userId },
        })
        return {
          decision: result.decision.decision,
          jobId: result.decision.resultingJobId,
          replayed: result.replayed,
        }
      }),
    ),

  readCharacterCandidatePreview: adminProcedure
    .input(z.object(snapshot).strict())
    .query(({ input }) =>
      action(async () => {
        const brief = await db.characterCandidateReviewBrief.findFirst({
          where: { id: input.briefId, tenantId: input.tenantId, venueId: input.venueId },
        })
        if (!brief) throw new TRPCError({ code: 'NOT_FOUND' })
        const character = await readCustomCharacterFactoryAction({
          tenantId: input.tenantId,
          venueId: input.venueId,
          characterId: brief.customCharacterId,
        })
        if (
          character.status !== 'REVIEW' ||
          brief.candidateVersion !== input.expectedVersion ||
          brief.candidateRevision !== input.expectedRevision ||
          brief.artifactFingerprint !== input.expectedArtifactFingerprint ||
          character.version !== input.expectedVersion ||
          character.revision !== input.expectedRevision ||
          characterCandidateArtifactFingerprint(character) !== input.expectedArtifactFingerprint
        )
          throw new TRPCError({ code: 'CONFLICT' })
        return readCharacterCandidateMasterPreview({
          tenantId: input.tenantId,
          venueId: input.venueId,
          artifactReference: character.assetStorageReference,
          expectedSpec: character.spec,
          reader: createCharacterArtifactStorage(),
        })
      }),
    ),
})
