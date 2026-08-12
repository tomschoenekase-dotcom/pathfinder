import { z } from 'zod'
import { TRPCError } from '@trpc/server'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import {
  FullManifestProjectionError,
  projectFullVenueDeploymentManifest,
} from '../../lib/full-venue-deployment-manifest'
import { adminProcedure } from '../../trpc'
import { reviewVenuePackageManifestService } from '../../lib/venue-package-manifest-service'

const MAX_MANIFEST_JSON_BYTES = 250_000

export const adminDeploymentManifestReviewRouter = router({
  createVenuePackageManifestArtifact: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          manifestJson: z.string().min(2).max(MAX_MANIFEST_JSON_BYTES),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        let manifest: unknown
        try {
          manifest = JSON.parse(input.manifestJson) as unknown
        } catch {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Manifest text is not valid JSON.' })
        }
        try {
          return await reviewVenuePackageManifestService({
            db,
            tenantId: input.tenantId,
            venueId: input.venueId,
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
            manifest,
            persist: true,
          })
        } catch (error) {
          if (error instanceof z.ZodError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'Manifest validation failed.' })
          }
          throw error
        }
      }),
    ),

  previewFullVenueDeploymentManifest: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          manifestId: z.string().uuid(),
          idempotencyKey: z.string().uuid(),
        })
        .strict(),
    )
    .query(async ({ input }) => {
      try {
        return await withTenantIsolationBypass(() => projectFullVenueDeploymentManifest(input, db))
      } catch (error) {
        if (error instanceof FullManifestProjectionError) {
          throw new TRPCError({
            code:
              error.code === 'NOT_FOUND'
                ? 'NOT_FOUND'
                : error.code === 'INVALID_INPUT'
                  ? 'BAD_REQUEST'
                  : 'PRECONDITION_FAILED',
            message: error.message,
          })
        }
        throw error
      }
    }),

  reviewDeploymentManifest: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          manifestJson: z.string().min(2).max(MAX_MANIFEST_JSON_BYTES),
        })
        .strict(),
    )
    .query(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        let manifest: unknown
        try {
          manifest = JSON.parse(input.manifestJson) as unknown
        } catch {
          return {
            scope: { tenantId: input.tenantId, venueId: input.venueId, venueName: null },
            compatible: false,
            manifestHash: null,
            issues: [
              {
                severity: 'ERROR' as const,
                code: 'INVALID_JSON',
                path: '',
                message: 'Manifest text is not valid JSON.',
              },
            ],
            handoff: null,
            previewInput: null,
            draftInput: null,
          }
        }
        let reviewed
        try {
          reviewed = await reviewVenuePackageManifestService({
            db,
            tenantId: input.tenantId,
            venueId: input.venueId,
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
            manifest,
            persist: false,
          })
        } catch (error) {
          if (error instanceof z.ZodError) {
            return {
              scope: { tenantId: input.tenantId, venueId: input.venueId, venueName: null },
              compatible: false,
              manifestHash: null,
              issues: error.issues.map((issue) => ({
                severity: 'ERROR' as const,
                code: 'INVALID_MANIFEST',
                path: issue.path.join('.'),
                message: issue.message,
              })),
              handoff: null,
              previewInput: null,
              draftInput: null,
              materialization: null,
            }
          }
          throw error
        }
        const draftInput = reviewed.legacyDraftInput as {
          venueId: string
          draftKey: string
          payload: unknown
        } | null
        return {
          scope: reviewed.scope,
          compatible: reviewed.materialization.status === 'MATERIALIZABLE',
          manifestHash: reviewed.manifestHash,
          issues: reviewed.materialization.issues,
          handoff: draftInput
            ? {
                previewProcedure: 'venuePackage.preview' as const,
                draftProcedure: 'venuePackage.createDraft' as const,
                approvalProcedure: 'venuePackage.approve' as const,
                applyProcedure: 'venuePackage.applyPackage' as const,
                rollbackProcedure: 'venuePackage.revertPackage' as const,
              }
            : null,
          previewInput: draftInput
            ? { venueId: draftInput.venueId, payload: draftInput.payload }
            : null,
          draftInput,
          materialization: reviewed.materialization,
        }
      }),
    ),
})
