import { randomUUID } from 'node:crypto'

import { buildOnboardingEvaluationSuite } from '@pathfinder/contracts'
import {
  createOrReplayEvaluationCase,
  db,
  hashEvalCase,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { router } from '../../core'
import { loadReviewableVenuePackageEvaluationPreview } from '../../lib/reviewable-package-evaluation'
import { adminProcedure } from '../../trpc'

export const adminEvaluationOnboardingActionsRouter = router({
  prepareOnboardingEvaluationSuite: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
        packageId: z.string().min(1).max(191),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTenantIsolationBypass(() =>
        db.$transaction(async (tx) => {
          const pkg = await tx.venuePackage.findFirst({
            where: {
              id: input.packageId,
              tenantId: input.tenantId,
              venueId: input.venueId,
              status: { in: ['DRAFT', 'APPROVED'] },
            },
            select: { id: true, payloadHash: true, baseDigest: true, status: true },
          })
          if (!pkg)
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Reviewable onboarding package was not found',
            })

          const reviewed = await loadReviewableVenuePackageEvaluationPreview(tx, input.tenantId, {
            venueId: input.venueId,
            packageId: input.packageId,
          })
          const suite = buildOnboardingEvaluationSuite(reviewed.preview)
          const caseKeys = suite.map(({ evalCase }) => evalCase.caseId)
          const existing = await tx.evalCase.findMany({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              caseKey: { in: caseKeys },
            },
            orderBy: [{ caseKey: 'asc' }, { revision: 'desc' }],
            select: {
              id: true,
              caseKey: true,
              revision: true,
              caseHash: true,
              sourceType: true,
              sourceRef: true,
            },
          })
          const latest = new Map<string, (typeof existing)[number]>()
          for (const row of existing) if (!latest.has(row.caseKey)) latest.set(row.caseKey, row)

          const sourceType = 'ONBOARDING_REVIEWABLE_PACKAGE'
          const sourceRef = `venue-package-review:${pkg.id}:${pkg.payloadHash}:${pkg.baseDigest}`
          const prepared = []
          for (const item of suite) {
            const prior = latest.get(item.evalCase.caseId)
            const caseHash = hashEvalCase(item.evalCase)
            const exactReplay =
              prior?.caseHash === caseHash &&
              prior.sourceType === sourceType &&
              prior.sourceRef === sourceRef
            const revision = exactReplay ? prior.revision : (prior?.revision ?? 0) + 1
            const result = await createOrReplayEvaluationCase({
              db: tx,
              caseId: exactReplay ? prior.id : randomUUID(),
              identity: {
                tenantId: input.tenantId,
                venueId: input.venueId,
                caseKey: item.evalCase.caseId,
                revision,
                schemaVersion: item.evalCase.schemaVersion,
                category: item.evalCase.category,
                caseSnapshot: item.evalCase,
                createdBy: ctx.session.userId,
                sourceType,
                sourceRef,
              },
            })
            prepared.push({
              id: result.evalCase.id,
              caseKey: result.evalCase.caseKey,
              revision: result.evalCase.revision,
              category: result.evalCase.category,
              dimension: item.dimension,
              replayed: result.replayed,
            })
          }

          return {
            package: {
              id: pkg.id,
              status: pkg.status,
              payloadHash: pkg.payloadHash,
              baseDigest: pkg.baseDigest,
            },
            suiteVersion: 'torchiko-onboarding-evaluation-suite-v2' as const,
            cases: prepared,
          }
        }),
      ),
    ),
})
