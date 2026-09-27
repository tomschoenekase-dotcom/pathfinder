import type { Prisma } from '@prisma/client'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type ProspectSizeProposal = {
  venueId: string
  organizationId: string
  expectedUpdatedAt: string
  snapshotName: string
  snapshotCity: string | null
  snapshotRegion: string | null
  size: {
    class: 'XS' | 'S' | 'M' | 'L' | 'XL' | 'UNKNOWN'
    basis: string
    value?: number | undefined
    unit?: string | undefined
    sourceUrl?: string | undefined
    observedAt: string
    confidence?: 'measured' | 'rule' | undefined
  }
}

export type ProspectSizeApplyResult = {
  venueId: string
  status: 'APPLIED' | 'CONFLICT'
  reasons: string[]
  updatedAt?: string
  readbackSize?: string | null
}

// This is the native, audited CRM writer for a human-reviewed size proposal.
// The compare-and-set is repeated inside the transaction: a preview is never
// authority to overwrite a row that changed before Apply.
export async function applyProspectSizeProposalAction(
  input: ProspectSizeProposal,
  actor: { type: 'HUMAN'; id: string; role: 'PLATFORM_ADMIN' },
  client: typeof db = db,
): Promise<ProspectSizeApplyResult> {
  if (actor.type !== 'HUMAN' || actor.role !== 'PLATFORM_ADMIN' || !actor.id) {
    return { venueId: input.venueId, status: 'CONFLICT', reasons: ['Human admin required'] }
  }
  try {
    return await client.$transaction(async (tx) => {
      const current = await tx.prospectVenue.findUnique({
        where: { id: input.venueId },
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
      const reasons: string[] = []
      if (!current || current.archivedAt) reasons.push('Venue missing or archived')
      if (current && current.organizationId !== input.organizationId)
        reasons.push('Organization identity changed')
      if (current && current.name !== input.snapshotName) reasons.push('Venue identity changed')
      if (current && current.city !== input.snapshotCity) reasons.push('City changed')
      if (current && current.region !== input.snapshotRegion) reasons.push('Region changed')
      if (current && current.updatedAt.toISOString() !== input.expectedUpdatedAt)
        reasons.push('Row version changed')
      if (reasons.length) return { venueId: input.venueId, status: 'CONFLICT' as const, reasons }

      const oldFit = current!.fitAttributes
      const fit =
        oldFit && typeof oldFit === 'object' && !Array.isArray(oldFit)
          ? { ...(oldFit as Record<string, unknown>) }
          : {}
      fit.torchikoSizeV1 = input.size
      const updated = await tx.prospectVenue.updateMany({
        where: {
          id: input.venueId,
          organizationId: input.organizationId,
          updatedAt: new Date(input.expectedUpdatedAt),
          archivedAt: null,
        },
        data: {
          estimatedSize: input.size.class,
          fitAttributes: fit as Prisma.InputJsonObject,
          updatedBy: actor.id,
        },
      })
      if (updated.count !== 1)
        return {
          venueId: input.venueId,
          status: 'CONFLICT' as const,
          reasons: ['Row version changed'],
        }
      const readback = await tx.prospectVenue.findUniqueOrThrow({
        where: { id: input.venueId },
        select: { estimatedSize: true, fitAttributes: true, updatedAt: true },
      })
      await writeAuditLogStrict(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: 'admin.prospect-size-proposal.applied',
          targetType: 'ProspectVenue',
          targetId: input.venueId,
          beforeState: {
            estimatedSize: current!.estimatedSize,
            torchikoSizeV1:
              oldFit && typeof oldFit === 'object' && !Array.isArray(oldFit)
                ? ((oldFit as Record<string, unknown>).torchikoSizeV1 ?? null)
                : null,
          },
          afterState: { estimatedSize: readback.estimatedSize, torchikoSizeV1: input.size },
          sourceReferences: input.size.sourceUrl ? [input.size.sourceUrl] : [],
        },
        tx,
      )
      return {
        venueId: input.venueId,
        status: 'APPLIED' as const,
        reasons: [],
        updatedAt: readback.updatedAt.toISOString(),
        readbackSize: readback.estimatedSize,
      }
    })
  } catch (error) {
    if ((error as { code?: string }).code === 'P2034')
      return { venueId: input.venueId, status: 'CONFLICT', reasons: ['Concurrent row update'] }
    throw error
  }
}
