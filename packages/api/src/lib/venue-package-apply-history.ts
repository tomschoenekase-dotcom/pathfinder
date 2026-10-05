import { TRPCError } from '@trpc/server'

import type { TRPCContext } from '../context'
import type { VenuePackageAppliedEntitiesV3 } from '../schemas/venue-package'

export type PackagePendingEffect = {
  itemKey: string
  entityType: 'VENUE' | 'PLACE' | 'KNOWLEDGE_ENTRY'
  entityId: string
  operation: 'CREATE' | 'UPDATE' | 'DELETE'
}

/** Verify every trigger-written receipt before the surrounding transaction may commit. */
export async function readPackageApplyHistory(input: {
  db: TRPCContext['db']
  tenantId: string
  venueId: string
  packageId: string
  effects: PackagePendingEffect[]
}): Promise<VenuePackageAppliedEntitiesV3['effects']> {
  if (input.effects.length === 0) return []
  // Individual content writes still establish their own transaction-local provenance. History
  // reads can share one round trip; PostgreSQL's unique constraints retain one receipt per item.
  const versions = await input.db.contentVersion.findMany({
    where: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      venuePackageId: input.packageId,
      venuePackageAction: 'APPLY',
    },
    select: {
      id: true,
      venuePackageItemKey: true,
      entityType: true,
      entityId: true,
      operation: true,
      beforeState: true,
      afterState: true,
      snapshotSchemaVersion: true,
    },
    take: input.effects.length + 1,
  })
  const byKey = new Map(versions.map((version) => [version.venuePackageItemKey, version]))
  if (
    versions.length !== input.effects.length ||
    byKey.size !== input.effects.length ||
    new Set(input.effects.map((effect) => effect.itemKey)).size !== input.effects.length
  ) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Package mutation did not produce the expected immutable history records',
    })
  }
  return input.effects.map((effect) => {
    const version = byKey.get(effect.itemKey)
    if (
      !version ||
      version.entityType !== effect.entityType ||
      version.entityId !== effect.entityId ||
      version.operation !== effect.operation
    ) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Package mutation did not produce the expected immutable history record',
      })
    }
    return {
      ...effect,
      applyVersionId: version.id,
      snapshotSchemaVersion: version.snapshotSchemaVersion,
      beforeState: version.beforeState as Record<string, unknown> | null,
      afterState: version.afterState as Record<string, unknown> | null,
    }
  })
}
