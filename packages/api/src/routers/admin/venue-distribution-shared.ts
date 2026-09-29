import { z } from 'zod'
import { db } from '@pathfinder/db'

export const targetInput = z
  .object({ tenantId: z.string().min(1).max(128), venueId: z.string().min(1).max(128) })
  .strict()
export const Reason = z.string().trim().min(1).max(500)
export const distributionProposalAction = 'torchiko.distribution.apply_change'
export const proposalSnapshot = z
  .object({
    tenantId: z.string().min(1),
    venueId: z.string().min(1),
    expectedRevision: z.number().int().min(0),
    change: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('ADD_ORIGIN'), origin: z.string().min(1).max(255) }).strict(),
      z.object({ kind: z.literal('REVOKE_ORIGIN'), origin: z.string().min(1).max(255) }).strict(),
      z
        .object({
          kind: z.literal('SET_SURFACE'),
          surface: z.enum(['WEBSITE', 'APP']),
          enabled: z.boolean(),
        })
        .strict(),
    ]),
  })
  .strict()

export async function bumpDistribution(
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  input: { tenantId: string; venueId: string; actorId: string },
  create: { websiteState?: 'ENABLED' | 'DISABLED'; appState?: 'ENABLED' | 'DISABLED' } = {},
) {
  return tx.venueDistribution.upsert({
    where: { venueId_tenantId: { venueId: input.venueId, tenantId: input.tenantId } },
    create: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      updatedBy: input.actorId,
      ...create,
    },
    update: { revision: { increment: 1 }, updatedBy: input.actorId, ...create },
    select: { websiteState: true, appState: true, revision: true },
  })
}
