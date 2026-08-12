import type { ContentVersionSourceProvenance } from '@pathfinder/db'

import type { JsonSnapshot } from './venue-package-rollback'

export type VenuePackageMutableEntityType = 'VENUE' | 'PLACE' | 'KNOWLEDGE_ENTRY'

const mutableEntityFields = {
  VENUE: new Set([
    'name',
    'slug',
    'description',
    'guideNotes',
    'aiGuideNotes',
    'aiFeaturedPlaceId',
    'aiTone',
    'tonePreset',
    'tonePresetVersion',
    'aiGuideName',
    'chatTheme',
    'chatAccentColor',
    'chatFont',
    'chatLogoUrl',
    'chatBannerUrl',
    'category',
    'guideMode',
    'defaultCenterLat',
    'defaultCenterLng',
    'geoBoundary',
    'isActive',
  ]),
  PLACE: new Set([
    'name',
    'type',
    'itemType',
    'shortDescription',
    'longDescription',
    'lat',
    'lng',
    'tags',
    'importanceScore',
    'areaName',
    'hours',
    'photoUrl',
    'isActive',
    'sourceType',
    'authorship',
    'sourceName',
    'sourceUrl',
    'importedAt',
    'humanConfirmedAt',
    'humanConfirmedBy',
    'lastReviewedAt',
    'lastReviewedBy',
    'sourcePackageId',
  ]),
  KNOWLEDGE_ENTRY: new Set([
    'title',
    'category',
    'content',
    'isEnabled',
    'sourceType',
    'authorship',
    'sourceName',
    'sourceUrl',
    'importedAt',
    'humanConfirmedAt',
    'humanConfirmedBy',
    'lastReviewedAt',
    'lastReviewedBy',
    'sourcePackageId',
  ]),
} as const

const provenanceDateFields = new Set(['importedAt', 'humanConfirmedAt', 'lastReviewedAt'])

function mutationValue(field: string, value: unknown) {
  if (provenanceDateFields.has(field) && typeof value === 'string') return new Date(value)
  return value
}

/** Builds a Prisma patch from the immutable-history field allowlist only. */
export function venuePackageRollbackMutationData(
  entityType: VenuePackageMutableEntityType,
  snapshot: JsonSnapshot,
): Record<string, unknown> {
  const allowed = mutableEntityFields[entityType]
  const data: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(snapshot)) {
    if (allowed.has(field)) data[field] = mutationValue(field, value)
  }
  return data
}

/** Builds the exact-state guard used before applying an inverse mutation. */
export function venuePackageRollbackCasWhere(
  entityType: VenuePackageMutableEntityType,
  expected: JsonSnapshot,
): Record<string, unknown> {
  const where: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(
    venuePackageRollbackMutationData(entityType, expected),
  )) {
    where[field] = field === 'tags' && Array.isArray(value) ? { equals: value } : value
  }
  return where
}

export function parseVenuePackageContentVersionProvenance(
  value: unknown,
  conflict: (message: string) => never,
): ContentVersionSourceProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return conflict('Package history provenance is invalid')
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.sourceType !== 'string' ||
    (record.sourceName !== undefined && typeof record.sourceName !== 'string') ||
    (record.sourceUrl !== undefined && typeof record.sourceUrl !== 'string') ||
    (record.contentOrigin !== 'HUMAN_AUTHORED' && record.contentOrigin !== 'AI_GENERATED') ||
    typeof record.importedAt !== 'string' ||
    typeof record.humanConfirmedAt !== 'string' ||
    typeof record.lastReviewedAt !== 'string'
  ) {
    return conflict('Package history provenance is invalid')
  }
  return record as ContentVersionSourceProvenance
}
