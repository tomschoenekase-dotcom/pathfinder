import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db } from '@pathfinder/db'

export const locationAuthoringScope = {
  tenantId: z.string().min(1).max(128),
  venueId: z.string().min(1).max(128),
}

const stableKey = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'Use lowercase letters, numbers, and hyphens.')
const locationKind = z.enum([
  'VENUE',
  'FLOOR',
  'ZONE',
  'ROOM',
  'POI',
  'ENTRANCE',
  'EXIT',
  'RESTROOM',
  'EXHIBIT',
  'ACCESSIBILITY_POINT',
  'SERVICE_DESK',
  'FOOD',
  'PARKING',
])
const safeHttpsUrl = z
  .string()
  .url()
  .max(2000)
  .refine((value) => {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return false
    const keys = [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()]
    const secretPattern =
      /token|key|secret|signature|credential|auth|password|^sig$|^x-amz-|^x-goog-/iu
    return !keys.some((key) => secretPattern.test(key)) && !secretPattern.test(url.hash)
  }, 'Use a public HTTPS URL without credentials or secret-like parameters.')
const nullableSafeUrl = z.union([safeHttpsUrl, z.null()]).default(null)
const coordinates = z
  .object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
  .strict()
  .nullable()
  .default(null)
const mapAnchor = z
  .object({ x: z.number().finite(), y: z.number().finite() })
  .strict()
  .nullable()
  .default(null)
const accessibilityMetadata = z
  .record(z.string().min(1).max(100), z.union([z.string().max(500), z.number(), z.boolean()]))
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > 20)
      ctx.addIssue({ code: 'custom', message: 'At most 20 accessibility facts are allowed.' })
    if (JSON.stringify(value).length > 5000)
      ctx.addIssue({ code: 'custom', message: 'Accessibility facts are too large.' })
  })
  .default({})

const editableLocationFields = {
  stableKey,
  kind: locationKind,
  displayName: z.string().trim().min(1).max(191),
  description: z.string().trim().max(2000).nullable().default(null),
  visibility: z.enum(['PUBLIC', 'SECOND_LAYER']).default('PUBLIC'),
  floorId: z.string().uuid().nullable().default(null),
  parentLocationId: z.string().uuid().nullable().default(null),
  coordinates,
  mapAnchor,
  externalMapReference: nullableSafeUrl,
  accessibilityMetadata,
}

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
