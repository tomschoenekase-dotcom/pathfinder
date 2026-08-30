import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { VenueLocationDraftFieldsSchema } from '@pathfinder/contracts/location-authoring'
import { db } from '@pathfinder/db'

export const locationAuthoringScope = {
  tenantId: z.string().min(1).max(128),
  venueId: z.string().min(1).max(128),
}

const editableLocationFields = VenueLocationDraftFieldsSchema.shape

export const createLocationInput = z
  .object({ operationId: z.string().uuid(), ...locationAuthoringScope, ...editableLocationFields })
  .strict()

export const updateLocationInput = z
  .object({
    ...locationAuthoringScope,
    locationId: z.string().uuid(),
    expectedUpdatedAt: z.coerce.date(),
    reason: z.string().trim().min(1).max(500),
    ...editableLocationFields,
  })
  .strict()

export function isUniqueConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

export function projectLocation(location: {
  id: string
  stableKey: string
  kind: string
  displayName: string
  description: string | null
  visibility: string
  floorId: string | null
  parentLocationId: string | null
  latitude: unknown
  longitude: unknown
  mapX: unknown
  mapY: unknown
  externalMapReference: string | null
  accessibilityMetadata: unknown
  verifiedAt: Date
  verifiedBy: string
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: location.id,
    stableKey: location.stableKey,
    kind: location.kind,
    displayName: location.displayName,
    description: location.description,
    visibility: location.visibility,
    floorId: location.floorId,
    parentLocationId: location.parentLocationId,
    coordinates:
      location.latitude !== null && location.longitude !== null
        ? { latitude: Number(location.latitude), longitude: Number(location.longitude) }
        : null,
    mapAnchor:
      location.mapX !== null && location.mapY !== null
        ? { x: Number(location.mapX), y: Number(location.mapY) }
        : null,
    externalMapReference: location.externalMapReference,
    accessibilityMetadata: location.accessibilityMetadata,
    verifiedAt: location.verifiedAt,
    verifiedBy: location.verifiedBy,
    isActive: location.isActive,
    createdAt: location.createdAt,
    updatedAt: location.updatedAt,
  }
}

export function exactCreateReplay(
  existing: ReturnType<typeof projectLocation>,
  input: z.infer<typeof createLocationInput>,
) {
  return (
    existing.stableKey === input.stableKey &&
    existing.kind === input.kind &&
    existing.displayName === input.displayName &&
    existing.description === input.description &&
    existing.visibility === input.visibility &&
    existing.floorId === input.floorId &&
    existing.parentLocationId === input.parentLocationId &&
    JSON.stringify(existing.coordinates) === JSON.stringify(input.coordinates) &&
    JSON.stringify(existing.mapAnchor) === JSON.stringify(input.mapAnchor) &&
    existing.externalMapReference === input.externalMapReference &&
    JSON.stringify(existing.accessibilityMetadata) ===
      JSON.stringify(input.accessibilityMetadata) &&
    !existing.isActive
  )
}

export async function validateLocationRelations(
  tx: Pick<typeof db, 'venueFloor' | 'venueLocation'>,
  input: {
    tenantId: string
    venueId: string
    floorId: string | null
    parentLocationId: string | null
    locationId?: string
  },
) {
  if (input.floorId) {
    const floor = await tx.venueFloor.findFirst({
      where: {
        id: input.floorId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        isActive: true,
      },
      select: { id: true },
    })
    if (!floor) throw new TRPCError({ code: 'NOT_FOUND', message: 'Floor not found.' })
  }
  if (input.parentLocationId) {
    if (input.locationId && input.parentLocationId === input.locationId)
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'A location cannot be its own parent.' })
    const parent = await tx.venueLocation.findFirst({
      where: {
        id: input.parentLocationId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        isActive: true,
      },
      select: { id: true },
    })
    if (!parent) throw new TRPCError({ code: 'NOT_FOUND', message: 'Parent location not found.' })
  }
}
