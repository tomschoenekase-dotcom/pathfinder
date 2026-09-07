import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { assertVenueAvailable, db, withTenantIsolationBypass } from '@pathfinder/db'
import { VenuePackagePayloadV1 } from '@pathfinder/contracts'

import {
  MediaIntakeHandoffInput,
  mediaIntakeHash,
  validateMediaIntakeSnapshot,
} from '../../lib/media-intake-snapshot'
import {
  createMediaIntakeHandoff,
  MediaIntakeHandoffError,
} from '../../lib/media-intake-handoff-service'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { mediaFindingsSchema, mediaQuestionSchema } from './media-ingestion-review-schemas'

export const mediaIngestionHandoffRouter = router({
  readIntakeHandoffEvidence: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1).max(191),
          venueId: z.string().min(1).max(191),
          runId: z.string().min(1).max(191),
          offset: z.number().int().min(0).max(50_000_000).default(0),
        })
        .strict(),
    )
    .query(async ({ input }) =>
      withTenantIsolationBypass(async () => {
        await assertVenueAvailable(db, { tenantId: input.tenantId, venueId: input.venueId })
        const run = await db.intakeRun.findFirst({
          where: {
            id: input.runId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            sourceKind: 'STRUCTURED_BOOTSTRAP',
            structuredBootstrap: { path: ['kind'], equals: 'MEDIA_PROJECT_REVIEW' },
          },
          select: { structuredBootstrap: true },
        })
        if (!run)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Reviewed media proposal not found.' })
        const snapshot = validateMediaIntakeSnapshot(run.structuredBootstrap)
        const text = JSON.stringify(snapshot, null, 2)
        if (
          input.offset > text.length ||
          (input.offset > 0 && /[\uDC00-\uDFFF]/u.test(text.charAt(input.offset)))
        ) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid evidence page offset.' })
        }
        let end = Math.min(input.offset + 20_000, text.length)
        if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end -= 1
        return {
          runId: input.runId,
          snapshotHash: mediaIntakeHash(snapshot),
          text: text.slice(input.offset, end),
          offset: input.offset,
          nextOffset: end < text.length ? end : null,
          totalCodeUnits: text.length,
          sourceCount: snapshot.sources.length,
        }
      }),
    ),
  getIntakeHandoff: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1).max(191),
          venueId: z.string().min(1).max(191),
          runId: z.string().min(1).max(191),
        })
        .strict(),
    )
    .query(async ({ input }) =>
      withTenantIsolationBypass(async () => {
        await assertVenueAvailable(db, { tenantId: input.tenantId, venueId: input.venueId })
        const run = await db.intakeRun.findFirst({
          where: {
            id: input.runId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            sourceKind: 'STRUCTURED_BOOTSTRAP',
            structuredBootstrap: { path: ['kind'], equals: 'MEDIA_PROJECT_REVIEW' },
          },
          select: { id: true, displayName: true, status: true },
        })
        if (!run)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Reviewed media proposal not found.' })
        return { ...run, structuredBootstrap: { kind: 'MEDIA_PROJECT_REVIEW' as const } }
      }),
    ),
  previewIntakeHandoff: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1).max(191),
          venueId: z.string().min(1).max(191),
          projectId: z.string().min(1).max(191),
          sourceCursor: z.string().min(1).max(500).optional(),
        })
        .strict(),
    )
    .query(async ({ input }) =>
      withTenantIsolationBypass(async () => {
        await assertVenueAvailable(db, { tenantId: input.tenantId, venueId: input.venueId })
        const project = await db.mediaIngestionProject.findFirst({
          where: { id: input.projectId, tenantId: input.tenantId, venueId: input.venueId },
          select: {
            status: true,
            stage: true,
            updatedAt: true,
            sourceObjectGeneration: true,
            draftJson: true,
            findings: true,
            questions: true,
          },
        })
        if (!project)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Media project not found.' })
        const issues: string[] = []
        const draftResult = VenuePackagePayloadV1.safeParse(project.draftJson)
        const findingsResult = mediaFindingsSchema.safeParse(project.findings)
        const questionsResult = z.array(mediaQuestionSchema).max(500).safeParse(project.questions)
        if (project.status !== 'READY_FOR_REVIEW' || project.stage !== 'review')
          issues.push('The project is not ready for reviewed intake handoff.')
        if (!project.sourceObjectGeneration) issues.push('The source generation is unavailable.')
        if (!draftResult.success) issues.push('The reviewed draft is invalid.')
        if (!findingsResult.success) issues.push('The reviewed findings are invalid.')
        if (!questionsResult.success) issues.push('The review questions are invalid.')
        else if (
          questionsResult.data.some(
            (question) => question.answer === undefined || !question.answer.trim(),
          )
        )
          issues.push('Every review question must be answered.')
        const findingIds = new Set(
          findingsResult.success ? findingsResult.data.map((finding) => finding.sourceId) : [],
        )
        if (findingsResult.success && findingIds.size !== findingsResult.data.length)
          issues.push('The reviewed findings contain duplicate source identities.')
        const sourceWhere = {
          tenantId: input.tenantId,
          projectId: input.projectId,
          status: 'COMPLETE' as const,
          sha256: { not: null },
          sourceId: { in: [...findingIds] },
        }
        const [sourceCount, assets] = await Promise.all([
          db.mediaIngestionAsset.count({ where: sourceWhere }),
          db.mediaIngestionAsset.findMany({
            where: {
              ...sourceWhere,
              sourceId: {
                ...sourceWhere.sourceId,
                ...(input.sourceCursor ? { gt: input.sourceCursor } : {}),
              },
            },
            orderBy: { sourceId: 'asc' },
            take: 101,
            select: { sourceId: true, filename: true },
          }),
        ])
        const page = assets.slice(0, 100)
        if (sourceCount === 0) issues.push('No complete reviewed media sources are available.')
        const draft = draftResult.success ? draftResult.data : null
        return {
          sourceGeneration: project.sourceObjectGeneration,
          updatedAt: project.updatedAt.toISOString(),
          items: draft
            ? [
                ...draft.places.map((item, itemIndex) => ({
                  kind: 'place' as const,
                  itemIndex,
                  itemHash: mediaIntakeHash(item),
                  label: item.name,
                })),
                ...draft.knowledgeEntries.map((item, itemIndex) => ({
                  kind: 'knowledge' as const,
                  itemIndex,
                  itemHash: mediaIntakeHash(item),
                  label: item.title,
                })),
              ]
            : [],
          sources: page,
          nextSourceCursor: assets.length > 100 ? page.at(-1)!.sourceId : null,
          ready: issues.length === 0,
          issues,
        }
      }),
    ),
  createIntakeHandoff: adminProcedure
    .input(MediaIntakeHandoffInput)
    .mutation(async ({ ctx, input }) => {
      try {
        await withTenantIsolationBypass(() =>
          assertVenueAvailable(db, { tenantId: input.tenantId, venueId: input.venueId }),
        )
        return await withTenantIsolationBypass(() =>
          createMediaIntakeHandoff({ db, input, actorId: ctx.session.userId }),
        )
      } catch (error) {
        if (error instanceof MediaIntakeHandoffError)
          throw new TRPCError({
            code: error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'CONFLICT',
            message:
              error.code === 'NOT_FOUND'
                ? 'Reviewed media project not found.'
                : 'The reviewed media project or handoff request changed.',
            cause: error,
          })
        throw error
      }
    }),
})
