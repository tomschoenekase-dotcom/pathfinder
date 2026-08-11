import { z } from 'zod'
import { TRPCError } from '@trpc/server'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import {
  deploymentManifestDraftInput,
  deploymentManifestPreviewInput,
} from '../../lib/venue-deployment-manifest'
import { adminProcedure } from '../../trpc'

const MAX_MANIFEST_JSON_BYTES = 250_000

export const adminDeploymentManifestReviewRouter = router({
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
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const venue = await db.venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: { id: true, name: true },
        })
        if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
        let manifest: unknown
        try {
          manifest = JSON.parse(input.manifestJson) as unknown
        } catch {
          return {
            scope: { tenantId: input.tenantId, venueId: input.venueId, venueName: venue.name },
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
        const preview = deploymentManifestPreviewInput({ venueId: input.venueId, manifest })
        const draft = deploymentManifestDraftInput({ venueId: input.venueId, manifest })
        return {
          scope: { tenantId: input.tenantId, venueId: input.venueId, venueName: venue.name },
          compatible: preview.converted.compatible,
          manifestHash: preview.converted.manifestHash,
          issues: preview.converted.issues,
          handoff: preview.converted.handoff,
          previewInput: preview.previewInput,
          draftInput: draft.draftInput,
        }
      }),
    ),
})
