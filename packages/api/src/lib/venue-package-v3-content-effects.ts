import type { TRPCContext } from '../context'
import type { VenuePackagePayloadV3, VenuePackageSourceProvenance } from '../schemas/venue-package'

type DbClient = TRPCContext['db']

export type VenuePackageV3RecordedEffect = {
  itemKey: string
  entityType: 'PLACE' | 'KNOWLEDGE_ENTRY'
  entityId: string
  operation: 'CREATE' | 'UPDATE' | 'DELETE'
}

type ProvenanceData = {
  sourceType: string
  authorship: 'HUMAN_AUTHORED' | 'AI_GENERATED'
  sourceName: string | null
  sourceUrl: string | null
  importedAt: Date
  humanConfirmedAt: Date
  humanConfirmedBy: string
  lastReviewedAt: Date
  lastReviewedBy: string
  sourcePackageId: string
}

/**
 * Applies the V3 child-content operations in their historical order. Venue mutation,
 * lifecycle authority, transaction ownership, and immutable-history verification stay
 * with the router; this module owns only the scoped Prisma effects.
 */
export async function applyVenuePackageV3ContentEffects(input: {
  db: DbClient
  tenantId: string
  venueId: string
  packageId: string
  approvedAt: Date
  approvedBy: string
  importedAt: Date
  payload: VenuePackagePayloadV3
  establishContext: (itemKey: string, provenance: VenuePackageSourceProvenance) => Promise<void>
  provenanceData: (input: {
    provenance: VenuePackageSourceProvenance
    packageId: string
    importedAt: Date
    humanConfirmedAt: Date
    humanConfirmedBy: string
  }) => ProvenanceData
  record: (effect: VenuePackageV3RecordedEffect) => Promise<void>
  conflict: (message: string) => never
}): Promise<void> {
  const provenanceFor = (provenance: VenuePackageSourceProvenance) =>
    input.provenanceData({
      provenance,
      packageId: input.packageId,
      importedAt: input.importedAt,
      humanConfirmedAt: input.approvedAt,
      humanConfirmedBy: input.approvedBy,
    })

  for (const operation of input.payload.places.create) {
    await input.establishContext(operation.itemKey, operation.provenance)
    const place = await input.db.place.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        name: operation.value.name,
        type: operation.value.type,
        ...(operation.value.itemType !== undefined ? { itemType: operation.value.itemType } : {}),
        ...(operation.value.shortDescription !== undefined
          ? { shortDescription: operation.value.shortDescription }
          : {}),
        ...(operation.value.longDescription !== undefined
          ? { longDescription: operation.value.longDescription }
          : {}),
        ...(operation.value.lat !== undefined ? { lat: operation.value.lat } : {}),
        ...(operation.value.lng !== undefined ? { lng: operation.value.lng } : {}),
        tags: operation.value.tags,
        importanceScore: operation.value.importanceScore,
        ...(operation.value.areaName !== undefined ? { areaName: operation.value.areaName } : {}),
        ...(operation.value.hours !== undefined ? { hours: operation.value.hours } : {}),
        ...(operation.value.photoUrl !== undefined ? { photoUrl: operation.value.photoUrl } : {}),
        ...provenanceFor(operation.provenance),
      },
      select: { id: true },
    })
    await input.record({
      itemKey: operation.itemKey,
      entityType: 'PLACE',
      entityId: place.id,
      operation: 'CREATE',
    })
  }
  for (const operation of input.payload.places.update) {
    await input.establishContext(operation.itemKey, operation.provenance)
    const changed = await input.db.place.updateMany({
      where: { id: operation.id, tenantId: input.tenantId, venueId: input.venueId },
      data: { ...operation.value, ...provenanceFor(operation.provenance) },
    })
    if (changed.count !== 1) input.conflict('Place changed during package application')
    await input.record({
      itemKey: operation.itemKey,
      entityType: 'PLACE',
      entityId: operation.id,
      operation: 'UPDATE',
    })
  }
  for (const operation of input.payload.places.delete) {
    await input.establishContext(operation.itemKey, operation.provenance)
    const changed = await input.db.place.deleteMany({
      where: { id: operation.id, tenantId: input.tenantId, venueId: input.venueId },
    })
    if (changed.count !== 1) input.conflict('Place changed during package application')
    await input.record({
      itemKey: operation.itemKey,
      entityType: 'PLACE',
      entityId: operation.id,
      operation: 'DELETE',
    })
  }

  for (const operation of input.payload.knowledgeEntries.create) {
    await input.establishContext(operation.itemKey, operation.provenance)
    const entry = await input.db.venueKnowledgeEntry.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        ...operation.value,
        ...provenanceFor(operation.provenance),
      },
      select: { id: true },
    })
    await input.record({
      itemKey: operation.itemKey,
      entityType: 'KNOWLEDGE_ENTRY',
      entityId: entry.id,
      operation: 'CREATE',
    })
  }
  for (const operation of input.payload.knowledgeEntries.update) {
    await input.establishContext(operation.itemKey, operation.provenance)
    const changed = await input.db.venueKnowledgeEntry.updateMany({
      where: { id: operation.id, tenantId: input.tenantId, venueId: input.venueId },
      data: { ...operation.value, ...provenanceFor(operation.provenance) },
    })
    if (changed.count !== 1) input.conflict('Knowledge entry changed during package application')
    await input.record({
      itemKey: operation.itemKey,
      entityType: 'KNOWLEDGE_ENTRY',
      entityId: operation.id,
      operation: 'UPDATE',
    })
  }
  for (const operation of input.payload.knowledgeEntries.delete) {
    await input.establishContext(operation.itemKey, operation.provenance)
    const changed = await input.db.venueKnowledgeEntry.deleteMany({
      where: { id: operation.id, tenantId: input.tenantId, venueId: input.venueId },
    })
    if (changed.count !== 1) input.conflict('Knowledge entry changed during package application')
    await input.record({
      itemKey: operation.itemKey,
      entityType: 'KNOWLEDGE_ENTRY',
      entityId: operation.id,
      operation: 'DELETE',
    })
  }
}
