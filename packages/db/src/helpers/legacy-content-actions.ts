import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { lockContentVersionEntity, setContentVersionContext } from './content-version-context'
import { lockVenueContentMutation } from './venue-content-lock'
export type LegacyContentActor = {
  type: 'HUMAN'
  id: string
  role: 'MANAGER' | 'OWNER' | 'PLATFORM_ADMIN'
}
export type LegacyContentActionClient = Pick<typeof db, '$transaction'>
export type LegacyContentActionErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT'
export class LegacyContentActionError extends Error {
  constructor(
    readonly code: LegacyContentActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'LegacyContentActionError'
  }
}
export const legacyPlaceSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  name: true,
  type: true,
  itemType: true,
  shortDescription: true,
  longDescription: true,
  lat: true,
  lng: true,
  tags: true,
  importanceScore: true,
  areaName: true,
  hours: true,
  photoUrl: true,
  isActive: true,
  visibility: true,
  createdAt: true,
  updatedAt: true,
} as const
export const legacyKnowledgeSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  title: true,
  category: true,
  content: true,
  isEnabled: true,
  visibility: true,
  createdAt: true,
  updatedAt: true,
} as const

type PlaceFields = {
  name: string
  type: string
  itemType?: string | null
  shortDescription?: string | null
  longDescription?: string | null
  lat?: number | null
  lng?: number | null
  tags: string[]
  importanceScore: number
  areaName?: string | null
  hours?: string | null
  photoUrl?: string | null
  isActive?: boolean
  visibility?: 'PUBLIC' | 'SECOND_LAYER'
}
type KnowledgeFields = {
  title: string
  category: string
  content: string
  isEnabled: boolean
  visibility?: 'PUBLIC' | 'SECOND_LAYER'
}

function actor(actor: LegacyContentActor): void {
  if (
    actor.type !== 'HUMAN' ||
    !actor.id ||
    !['MANAGER', 'OWNER', 'PLATFORM_ADMIN'].includes(actor.role)
  ) {
    throw new LegacyContentActionError('INVALID_INPUT', 'A manager human actor is required')
  }
}

function conflict(): never {
  throw new LegacyContentActionError(
    'CONFLICT',
    'Content changed after this page loaded; refresh and try again',
  )
}

async function prepare(
  tx: typeof db,
  input: { tenantId: string; venueId: string; actor: LegacyContentActor },
) {
  actor(input.actor)
  await setContentVersionContext(tx, { actorId: input.actor.id })
  const venue = await tx.venue.findFirst({
    where: { id: input.venueId, tenantId: input.tenantId },
    select: { id: true },
  })
  if (!venue) throw new LegacyContentActionError('NOT_FOUND', 'Venue not found')
  await lockVenueContentMutation(tx, { tenantId: input.tenantId, venueId: input.venueId })
}

function placeAudit(value: {
  id: string
  venueId: string
  name: string
  type: string
  itemType: string | null
  tags: string[]
  importanceScore: number
  isActive: boolean
  visibility: string
  updatedAt: Date
}) {
  return {
    id: value.id,
    venueId: value.venueId,
    name: value.name,
    type: value.type,
    itemType: value.itemType,
    tags: value.tags,
    importanceScore: value.importanceScore,
    isActive: value.isActive,
    visibility: value.visibility,
    updatedAt: value.updatedAt.toISOString(),
  }
}
function knowledgeAudit(value: {
  id: string
  venueId: string
  title: string
  category: string
  isEnabled: boolean
  visibility: string
  updatedAt: Date
}) {
  return {
    id: value.id,
    venueId: value.venueId,
    title: value.title,
    category: value.category,
    isEnabled: value.isEnabled,
    visibility: value.visibility,
    updatedAt: value.updatedAt.toISOString(),
  }
}

export async function createLegacyPlaceAction(
  input: { tenantId: string; venueId: string; actor: LegacyContentActor; fields: PlaceFields },
  client: LegacyContentActionClient = db,
) {
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await prepare(tx, input)
    const place = await tx.place.create({
      data: { tenantId: input.tenantId, venueId: input.venueId, ...input.fields },
      select: legacyPlaceSelect,
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'place.created',
        targetType: 'Place',
        targetId: place.id,
        afterState: placeAudit(place),
      },
      tx,
    )
    return place
  })
}

export async function bulkCreateLegacyPlacesAction(
  input: { tenantId: string; venueId: string; actor: LegacyContentActor; places: PlaceFields[] },
  client: LegacyContentActionClient = db,
) {
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await prepare(tx, input)
    const places = []
    for (const fields of input.places) {
      const place = await tx.place.create({
        data: { tenantId: input.tenantId, venueId: input.venueId, ...fields },
        select: legacyPlaceSelect,
      })
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'place.created',
          targetType: 'Place',
          targetId: place.id,
          afterState: placeAudit(place),
        },
        tx,
      )
      places.push(place)
    }
    return places
  })
}

export async function updateLegacyPlaceAction(
  input: {
    tenantId: string
    venueId: string
    id: string
    expectedUpdatedAt: Date
    actor: LegacyContentActor
    fields: Partial<PlaceFields>
    auditAction?: 'place.updated' | 'place.retired'
  },
  client: LegacyContentActionClient = db,
) {
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await prepare(tx, input)
    await lockContentVersionEntity(tx, {
      tenantId: input.tenantId,
      entityType: 'PLACE',
      entityId: input.id,
    })
    const existing = await tx.place.findFirst({
      where: { id: input.id, tenantId: input.tenantId, venueId: input.venueId },
      select: legacyPlaceSelect,
    })
    if (!existing) throw new LegacyContentActionError('NOT_FOUND', 'Place not found')
    const changed = await tx.place.updateMany({
      where: {
        id: input.id,
        tenantId: input.tenantId,
        venueId: input.venueId,
        updatedAt: input.expectedUpdatedAt,
      },
      data: input.fields,
    })
    if (changed.count !== 1) conflict()
    const place = await tx.place.findFirst({
      where: { id: input.id, tenantId: input.tenantId, venueId: input.venueId },
      select: legacyPlaceSelect,
    })
    if (!place) conflict()
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: input.auditAction ?? 'place.updated',
        targetType: 'Place',
        targetId: input.id,
        beforeState: placeAudit(existing),
        afterState: placeAudit(place),
      },
      tx,
    )
    return place
  })
}

export async function retireLegacyPlaceAction(
  input: {
    tenantId: string
    venueId: string
    id: string
    expectedUpdatedAt: Date
    actor: LegacyContentActor
  },
  client: LegacyContentActionClient = db,
) {
  return updateLegacyPlaceAction(
    { ...input, fields: { isActive: false }, auditAction: 'place.retired' },
    client,
  )
}

export async function createLegacyKnowledgeAction(
  input: { tenantId: string; venueId: string; actor: LegacyContentActor; fields: KnowledgeFields },
  client: LegacyContentActionClient = db,
) {
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await prepare(tx, input)
    const entry = await tx.venueKnowledgeEntry.create({
      data: { tenantId: input.tenantId, venueId: input.venueId, ...input.fields },
      select: legacyKnowledgeSelect,
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'knowledge.created',
        targetType: 'VenueKnowledgeEntry',
        targetId: entry.id,
        afterState: knowledgeAudit(entry),
      },
      tx,
    )
    return entry
  })
}

export async function bulkCreateLegacyKnowledgeAction(
  input: {
    tenantId: string
    venueId: string
    actor: LegacyContentActor
    entries: KnowledgeFields[]
  },
  client: LegacyContentActionClient = db,
) {
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await prepare(tx, input)
    const entries = []
    for (const fields of input.entries) {
      const entry = await tx.venueKnowledgeEntry.create({
        data: { tenantId: input.tenantId, venueId: input.venueId, ...fields },
        select: legacyKnowledgeSelect,
      })
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'knowledge.created',
          targetType: 'VenueKnowledgeEntry',
          targetId: entry.id,
          afterState: knowledgeAudit(entry),
        },
        tx,
      )
      entries.push(entry)
    }
    return entries
  })
}

export async function updateLegacyKnowledgeAction(
  input: {
    tenantId: string
    venueId: string
    id: string
    expectedUpdatedAt: Date
    actor: LegacyContentActor
    fields: Partial<KnowledgeFields>
    auditAction?: 'knowledge.updated' | 'knowledge.retired'
  },
  client: LegacyContentActionClient = db,
) {
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await prepare(tx, input)
    await lockContentVersionEntity(tx, {
      tenantId: input.tenantId,
      entityType: 'KNOWLEDGE_ENTRY',
      entityId: input.id,
    })
    const existing = await tx.venueKnowledgeEntry.findFirst({
      where: { id: input.id, tenantId: input.tenantId, venueId: input.venueId },
      select: legacyKnowledgeSelect,
    })
    if (!existing) throw new LegacyContentActionError('NOT_FOUND', 'Knowledge entry not found')
    const changed = await tx.venueKnowledgeEntry.updateMany({
      where: {
        id: input.id,
        tenantId: input.tenantId,
        venueId: input.venueId,
        updatedAt: input.expectedUpdatedAt,
      },
      data: input.fields,
    })
    if (changed.count !== 1) conflict()
    const entry = await tx.venueKnowledgeEntry.findFirst({
      where: { id: input.id, tenantId: input.tenantId, venueId: input.venueId },
      select: legacyKnowledgeSelect,
    })
    if (!entry) conflict()
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: input.auditAction ?? 'knowledge.updated',
        targetType: 'VenueKnowledgeEntry',
        targetId: input.id,
        beforeState: knowledgeAudit(existing),
        afterState: knowledgeAudit(entry),
      },
      tx,
    )
    return entry
  })
}

export async function retireLegacyKnowledgeAction(
  input: {
    tenantId: string
    venueId: string
    id: string
    expectedUpdatedAt: Date
    actor: LegacyContentActor
  },
  client: LegacyContentActionClient = db,
) {
  return updateLegacyKnowledgeAction(
    { ...input, fields: { isEnabled: false }, auditAction: 'knowledge.retired' },
    client,
  )
}
