import { z } from 'zod'

import {
  PublicMapReferenceSchema,
  VenueLocationStableKeySchema,
} from '@pathfinder/contracts/location-authoring'
import { db } from '@pathfinder/db'

import { locationAuthoringScope } from './location-authoring-contract'

export const VenueLocationConnectionKindSchema = z.enum([
  'WALKWAY',
  'DOOR',
  'STAIRS',
  'ELEVATOR',
  'ESCALATOR',
  'OUTDOOR_PATH',
  'SHUTTLE',
])

export const floorFields = {
  stableKey: VenueLocationStableKeySchema,
  name: z.string().trim().min(1).max(160),
  level: z.number().int().min(-1000).max(1000).nullable().default(null),
  sortOrder: z.number().int().min(-10000).max(10000).default(0),
  mapImageUrl: z.union([PublicMapReferenceSchema, z.null()]).default(null),
}

export const createFloorInput = z
  .object({ operationId: z.string().uuid(), ...locationAuthoringScope, ...floorFields })
  .strict()

export const updateFloorInput = z
  .object({
    ...locationAuthoringScope,
    floorId: z.string().uuid(),
    expectedUpdatedAt: z.coerce.date(),
    reason: z.string().trim().min(1).max(500),
    ...floorFields,
  })
  .strict()

export const connectionFields = {
  fromLocationId: z.string().uuid(),
  toLocationId: z.string().uuid(),
  kind: VenueLocationConnectionKindSchema,
  bidirectional: z.boolean().default(true),
  accessible: z.boolean().default(false),
  directions: z.string().trim().max(2000).nullable().default(null),
}

export const createConnectionInput = z
  .object({ operationId: z.string().uuid(), ...locationAuthoringScope, ...connectionFields })
  .strict()

export const updateConnectionInput = z
  .object({
    ...locationAuthoringScope,
    connectionId: z.string().uuid(),
    expectedUpdatedAt: z.coerce.date(),
    reason: z.string().trim().min(1).max(500),
    ...connectionFields,
  })
  .strict()

export function projectFloor(floor: {
  id: string
  stableKey: string
  name: string
  level: number | null
  sortOrder: number
  mapImageUrl: string | null
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}) {
  return { ...floor }
}

export function exactFloorReplay(
  floor: ReturnType<typeof projectFloor>,
  input: z.infer<typeof createFloorInput>,
) {
  return (
    floor.stableKey === input.stableKey &&
    floor.name === input.name &&
    floor.level === input.level &&
    floor.sortOrder === input.sortOrder &&
    floor.mapImageUrl === input.mapImageUrl &&
    !floor.isActive
  )
}

export function projectConnection(connection: {
  id: string
  fromLocationId: string
  toLocationId: string
  kind: string
  bidirectional: boolean
  accessible: boolean
  directions: string | null
  verifiedAt: Date
  verifiedBy: string
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}) {
  return { ...connection }
}

export function exactConnectionReplay(
  connection: ReturnType<typeof projectConnection>,
  input: z.infer<typeof createConnectionInput>,
) {
  return (
    connection.fromLocationId === input.fromLocationId &&
    connection.toLocationId === input.toLocationId &&
    connection.kind === input.kind &&
    connection.bidirectional === input.bidirectional &&
    connection.accessible === input.accessible &&
    connection.directions === input.directions &&
    !connection.isActive
  )
}

export async function validateConnectionLocations(
  tx: Pick<typeof db, 'venueLocation'>,
  input: {
    tenantId: string
    venueId: string
    fromLocationId: string
    toLocationId: string
    requireActive: boolean
  },
) {
  if (input.fromLocationId === input.toLocationId) {
    throw new Error('A connection requires two different location anchors.')
  }
  const where = (id: string) => ({
    id,
    tenantId: input.tenantId,
    venueId: input.venueId,
    ...(input.requireActive ? { isActive: true } : {}),
  })
  const [from, to] = await Promise.all([
    tx.venueLocation.findFirst({ where: where(input.fromLocationId), select: { id: true } }),
    tx.venueLocation.findFirst({ where: where(input.toLocationId), select: { id: true } }),
  ])
  if (!from || !to) {
    throw new Error(
      input.requireActive
        ? 'Both connection anchors must be active in this venue.'
        : 'Both connection anchors must exist in this venue.',
    )
  }
}
