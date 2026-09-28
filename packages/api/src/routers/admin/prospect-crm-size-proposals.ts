import { z } from 'zod'

import {
  prospectSizeProposalFileSchema,
  prospectSizeProposalRecordSchema,
} from '@pathfinder/contracts/prospect-size'
import { applyProspectSizeProposalAction, db, withTenantIsolationBypass } from '@pathfinder/db'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { prospectActor } from './prospect-crm-common'

const applyRow = prospectSizeProposalRecordSchema.extend({
  organizationId: z.string().min(1).max(191),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
})

function currentSize(fitAttributes: unknown): unknown {
  if (!fitAttributes || typeof fitAttributes !== 'object' || Array.isArray(fitAttributes))
    return null
  return (fitAttributes as Record<string, unknown>).torchikoSizeV1 ?? null
}

export const adminProspectCrmSizeProposalsRouter = router({
  // Mutation transport is deliberate: an 80-row proposal must not become a long GET URL.
  // Preview performs no write, and makes no claim that dated snapshot IDs still match CRM.
  previewProspectSizeProposals: adminProcedure
    .input(z.object({ proposalFile: prospectSizeProposalFileSchema }).strict())
    .mutation(({ input }) =>
      withTenantIsolationBypass(async () => {
        const records = input.proposalFile.records
        const venues = await db.prospectVenue.findMany({
          where: { id: { in: records.map((record) => record.venueId) } },
          select: {
            id: true,
            organizationId: true,
            name: true,
            city: true,
            region: true,
            archivedAt: true,
            updatedAt: true,
            estimatedSize: true,
            fitAttributes: true,
          },
        })
        const byId = new Map(venues.map((venue) => [venue.id, venue]))
        return {
          rows: records.map((record) => {
            const venue = byId.get(record.venueId)
            const reasons: string[] = []
            if (!record.organizationId)
              reasons.push('Organization identity requires current CRM review')
            if (!venue || venue.archivedAt) reasons.push('Venue missing or archived')
            if (venue && venue.organizationId !== record.organizationId)
              reasons.push('Organization identity changed')
            if (venue && venue.name !== record.snapshotName) reasons.push('Venue identity changed')
            if (venue && venue.city !== record.snapshotCity) reasons.push('City changed')
            if (venue && venue.region !== record.snapshotRegion) reasons.push('Region changed')
            if (
              venue &&
              record.expectedUpdatedAt &&
              venue.updatedAt.toISOString() !== record.expectedUpdatedAt
            )
              reasons.push('Row version changed')
            return {
              venueId: record.venueId,
              organizationId: record.organizationId,
              snapshotName: record.snapshotName,
              snapshotCity: record.snapshotCity,
              snapshotRegion: record.snapshotRegion,
              currentName: venue?.name ?? null,
              currentCity: venue?.city ?? null,
              currentRegion: venue?.region ?? null,
              currentUpdatedAt: venue?.updatedAt.toISOString() ?? null,
              currentSize: venue?.estimatedSize ?? null,
              currentSizeEvidence: currentSize(venue?.fitAttributes),
              proposedSize: record.size,
              status: reasons.length ? ('CONFLICT' as const) : ('READY' as const),
              reasons,
            }
          }),
        }
      }),
    ),

  applyProspectSizeProposals: adminProcedure
    .input(z.object({ rows: z.array(applyRow).min(1).max(250) }).strict())
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        const actor = prospectActor(ctx.session.userId)
        const results = []
        for (const row of input.rows) {
          results.push(await applyProspectSizeProposalAction(row, actor))
        }
        return { results }
      }),
    ),
})
