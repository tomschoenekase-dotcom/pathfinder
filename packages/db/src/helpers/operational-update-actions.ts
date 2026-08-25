import type { MachineActorContext } from '@pathfinder/contracts/actor'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import {
  lockContentVersionEntity,
  lockOperationalUpdateCapacity,
  setContentVersionContext,
} from './content-version-context'

export const MAX_GUEST_OPERATIONAL_UPDATES = 20

export type OperationalUpdateActionErrorCode = 'NOT_FOUND' | 'INVALID_INPUT' | 'CONFLICT'

export class OperationalUpdateActionError extends Error {
  constructor(
    readonly code: OperationalUpdateActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'OperationalUpdateActionError'
  }
}

export type OperationalUpdateHumanActor = {
  type: 'HUMAN'
  id: string
  role: 'MANAGER' | 'OWNER' | 'PLATFORM_ADMIN'
}
export type OperationalUpdateActor = OperationalUpdateHumanActor | MachineActorContext

export type OperationalUpdateFields = {
  venueId: string
  placeId?: string | null
  updateType:
    | 'GENERAL_NOTICE'
    | 'TEMPORARY_CLOSURE'
    | 'UNAVAILABLE_EXHIBIT'
    | 'CHANGED_HOURS'
    | 'MAINTENANCE'
    | 'SPECIAL_EVENT'
    | 'SOLD_OUT_ACTIVITY'
    | 'TEMPORARY_VENDOR_LOCATION'
  severity: 'INFO' | 'WARNING' | 'CLOSURE' | 'REDIRECT'
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'
  title: string
  body?: string | null
  redirectTo?: string | null
  startsAt: Date
  expiresAt: Date
}

export type OperationalUpdateActionClient = Pick<typeof db, '$transaction'>

export const operationalUpdateActionSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  placeId: true,
  updateType: true,
  severity: true,
  priority: true,
  title: true,
  body: true,
  redirectTo: true,
  startsAt: true,
  expiresAt: true,
  status: true,
  isActive: true,
  createdBy: true,
  publishedBy: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  venue: { select: { id: true, name: true } },
  place: { select: { id: true, name: true } },
} as const

export type SelectedOperationalUpdate = {
  id: string
  tenantId: string
  venueId: string
  placeId: string | null
  updateType: string
  severity: string
  priority: string
  title: string
  body: string | null
  redirectTo: string | null
  startsAt: Date
  expiresAt: Date
  status: string
  isActive: boolean
  createdBy: string
  publishedBy: string | null
  publishedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type OperationalUpdatePreview = {
  lifecycle: 'DRAFT' | 'SCHEDULED' | 'LIVE' | 'EXPIRED' | 'INACTIVE'
  guestVisibleNow: boolean
  startsAt: string
  expiresAt: string
}

export type OperationalUpdateActionResult<TUpdate = SelectedOperationalUpdate> = {
  update: TUpdate
  preview: OperationalUpdatePreview
}

export function buildOperationalUpdatePreview(
  update: Pick<SelectedOperationalUpdate, 'status' | 'isActive' | 'startsAt' | 'expiresAt'>,
  now = new Date(),
): OperationalUpdatePreview {
  const current = now.getTime()
  let lifecycle: OperationalUpdatePreview['lifecycle']
  if (update.status === 'DRAFT') lifecycle = 'DRAFT'
  else if (!update.isActive) lifecycle = 'INACTIVE'
  else if (update.expiresAt.getTime() <= current) lifecycle = 'EXPIRED'
  else if (update.startsAt.getTime() > current) lifecycle = 'SCHEDULED'
  else lifecycle = 'LIVE'
  return {
    lifecycle,
    guestVisibleNow: lifecycle === 'LIVE',
    startsAt: update.startsAt.toISOString(),
    expiresAt: update.expiresAt.toISOString(),
  }
}

export type OperationalUpdateDraftFinalizer = (input: {
  tx: typeof db
  update: SelectedOperationalUpdate
  preview: OperationalUpdatePreview
}) => Promise<void>

function validateActor(actor: OperationalUpdateActor, schedule: boolean): void {
  if (actor.type === 'AGENT') {
    if (schedule || actor.capability !== 'updates:draft') {
      throw new OperationalUpdateActionError(
        'INVALID_INPUT',
        'Machine actors may only create drafts with updates:draft capability',
      )
    }
    return
  }
  if (!actor.id || !['MANAGER', 'OWNER', 'PLATFORM_ADMIN'].includes(actor.role)) {
    throw new OperationalUpdateActionError('INVALID_INPUT', 'A manager human actor is required')
  }
}

function validateWindow(input: Pick<OperationalUpdateFields, 'startsAt' | 'expiresAt'>): void {
  if (
    !Number.isFinite(input.startsAt.getTime()) ||
    !Number.isFinite(input.expiresAt.getTime()) ||
    input.startsAt.getTime() >= input.expiresAt.getTime()
  ) {
    throw new OperationalUpdateActionError('INVALID_INPUT', 'Expiry must be after the start time')
  }
}

function assertSchedulable(
  update: Pick<SelectedOperationalUpdate, 'status' | 'expiresAt'>,
  now: Date,
): void {
  if (update.status !== 'DRAFT') {
    throw new OperationalUpdateActionError('CONFLICT', 'Only a draft can be scheduled')
  }
  if (update.expiresAt.getTime() <= now.getTime()) {
    throw new OperationalUpdateActionError('INVALID_INPUT', 'Expired updates cannot be scheduled')
  }
}

function conflict(): never {
  throw new OperationalUpdateActionError(
    'CONFLICT',
    'Operational update changed after this page loaded; refresh and try again',
  )
}

function toAuditState(update: SelectedOperationalUpdate) {
  return {
    id: update.id,
    tenantId: update.tenantId,
    venueId: update.venueId,
    placeId: update.placeId,
    updateType: update.updateType,
    severity: update.severity,
    priority: update.priority,
    title: update.title,
    body: update.body,
    redirectTo: update.redirectTo,
    startsAt: update.startsAt.toISOString(),
    expiresAt: update.expiresAt.toISOString(),
    status: update.status,
    isActive: update.isActive,
    createdBy: update.createdBy,
    publishedBy: update.publishedBy,
    publishedAt: update.publishedAt?.toISOString() ?? null,
    createdAt: update.createdAt.toISOString(),
    updatedAt: update.updatedAt.toISOString(),
  }
}

async function findUpdate(tx: typeof db, id: string, tenantId: string) {
  return tx.operationalUpdate.findFirst({
    where: { id, tenantId },
    select: operationalUpdateActionSelect,
  })
}

async function assertScope(
  tx: typeof db,
  tenantId: string,
  fields: Pick<OperationalUpdateFields, 'venueId' | 'placeId'>,
): Promise<void> {
  const venue = await tx.venue.findFirst({
    where: { id: fields.venueId, tenantId },
    select: { id: true },
  })
  if (!venue) throw new OperationalUpdateActionError('NOT_FOUND', 'Venue not found')
  if (!fields.placeId) return
  const place = await tx.place.findFirst({
    where: { id: fields.placeId, venueId: fields.venueId, tenantId },
    select: { id: true },
  })
  if (!place) throw new OperationalUpdateActionError('NOT_FOUND', 'Place not found')
}

async function assertCapacity(
  tx: typeof db,
  input: { tenantId: string; venueId: string; startsAt: Date; expiresAt: Date; excludeId?: string },
): Promise<void> {
  await lockOperationalUpdateCapacity(tx, input)
  const count = await tx.operationalUpdate.count({
    where: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      status: 'PUBLISHED',
      isActive: true,
      startsAt: { lt: input.expiresAt },
      expiresAt: { gt: input.startsAt },
      ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
    },
  })
  if (count >= MAX_GUEST_OPERATIONAL_UPDATES) {
    throw new OperationalUpdateActionError(
      'CONFLICT',
      `A venue can have at most ${MAX_GUEST_OPERATIONAL_UPDATES} overlapping published updates`,
    )
  }
}

async function prepare(
  tx: typeof db,
  actor: OperationalUpdateActor,
  schedule: boolean,
): Promise<void> {
  validateActor(actor, schedule)
  await setContentVersionContext(tx, { actorId: actor.type === 'AGENT' ? actor.actorId : actor.id })
}

export async function createOperationalUpdateAction(
  input: {
    tenantId: string
    actor: OperationalUpdateActor
    fields: OperationalUpdateFields
    schedule: boolean
    now?: Date
    id?: string
    finalizer?: OperationalUpdateDraftFinalizer
  },
  client: OperationalUpdateActionClient = db,
): Promise<OperationalUpdateActionResult> {
  validateWindow(input.fields)
  const now = input.now ?? new Date()
  if (input.schedule && input.fields.expiresAt.getTime() <= now.getTime()) {
    throw new OperationalUpdateActionError('INVALID_INPUT', 'Expired updates cannot be scheduled')
  }
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await prepare(tx, input.actor, input.schedule)
    await assertScope(tx, input.tenantId, input.fields)
    if (input.schedule) await assertCapacity(tx, { tenantId: input.tenantId, ...input.fields })
    const created = await tx.operationalUpdate.create({
      data: {
        ...(input.id ? { id: input.id } : {}),
        tenantId: input.tenantId,
        venueId: input.fields.venueId,
        placeId: input.fields.placeId ?? null,
        updateType: input.fields.updateType,
        severity: input.fields.severity,
        priority: input.fields.priority,
        title: input.fields.title,
        body: input.fields.body ?? null,
        redirectTo: input.fields.redirectTo ?? null,
        startsAt: input.fields.startsAt,
        expiresAt: input.fields.expiresAt,
        status: input.schedule ? 'PUBLISHED' : 'DRAFT',
        isActive: input.schedule,
        createdBy: input.actor.type === 'AGENT' ? input.actor.actorId : input.actor.id,
        publishedBy: input.schedule && input.actor.type === 'HUMAN' ? input.actor.id : null,
        publishedAt: input.schedule ? now : null,
      },
      select: operationalUpdateActionSelect,
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        ...(input.actor.type === 'AGENT'
          ? { actor: input.actor }
          : { actorId: input.actor.id, actorRole: input.actor.role }),
        action: input.schedule
          ? 'operational-update.created-published'
          : 'operational-update.created-draft',
        targetType: 'OperationalUpdate',
        targetId: created.id,
        afterState: toAuditState(created),
      },
      tx,
    )
    const preview = buildOperationalUpdatePreview(created, now)
    if (input.finalizer) await input.finalizer({ tx, update: created, preview })
    return { update: created, preview }
  })
}

export async function updateOperationalUpdateAction(
  input: {
    tenantId: string
    actor: OperationalUpdateHumanActor
    id: string
    expectedUpdatedAt: Date
    fields: OperationalUpdateFields
    schedule: boolean
    now?: Date
  },
  client: OperationalUpdateActionClient = db,
): Promise<OperationalUpdateActionResult> {
  validateWindow(input.fields)
  const now = input.now ?? new Date()
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await prepare(tx, input.actor, input.schedule)
    await lockContentVersionEntity(tx, {
      tenantId: input.tenantId,
      entityType: 'OPERATIONAL_UPDATE',
      entityId: input.id,
    })
    const existing = await findUpdate(tx, input.id, input.tenantId)
    if (!existing)
      throw new OperationalUpdateActionError('NOT_FOUND', 'Operational update not found')
    await assertScope(tx, input.tenantId, input.fields)
    if (input.schedule) assertSchedulable(existing, now)
    if (input.schedule || (existing.status === 'PUBLISHED' && existing.isActive)) {
      if (input.fields.expiresAt.getTime() <= now.getTime()) {
        throw new OperationalUpdateActionError(
          'INVALID_INPUT',
          'An active update must expire in the future',
        )
      }
      await assertCapacity(tx, {
        tenantId: input.tenantId,
        ...input.fields,
        excludeId: input.id,
      })
    }
    const changed = await tx.operationalUpdate.updateMany({
      where: {
        id: input.id,
        tenantId: input.tenantId,
        updatedAt: input.expectedUpdatedAt,
        ...(input.schedule ? { status: 'DRAFT' as const } : {}),
      },
      data: {
        venueId: input.fields.venueId,
        placeId: input.fields.placeId ?? null,
        updateType: input.fields.updateType,
        severity: input.fields.severity,
        priority: input.fields.priority,
        title: input.fields.title,
        body: input.fields.body ?? null,
        redirectTo: input.fields.redirectTo ?? null,
        startsAt: input.fields.startsAt,
        expiresAt: input.fields.expiresAt,
        ...(input.schedule
          ? {
              status: 'PUBLISHED' as const,
              isActive: true,
              publishedBy: input.actor.id,
              publishedAt: now,
            }
          : {}),
      },
    })
    if (changed.count !== 1) conflict()
    const updated = await findUpdate(tx, input.id, input.tenantId)
    if (!updated) conflict()
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: input.schedule
          ? 'operational-update.updated-published'
          : 'operational-update.updated',
        targetType: 'OperationalUpdate',
        targetId: input.id,
        beforeState: toAuditState(existing),
        afterState: toAuditState(updated),
      },
      tx,
    )
    return { update: updated, preview: buildOperationalUpdatePreview(updated, now) }
  })
}

export async function scheduleOperationalUpdateAction(
  input: {
    tenantId: string
    actor: OperationalUpdateHumanActor
    id: string
    expectedUpdatedAt: Date
    now?: Date
  },
  client: OperationalUpdateActionClient = db,
): Promise<OperationalUpdateActionResult> {
  const now = input.now ?? new Date()
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await prepare(tx, input.actor, true)
    await lockContentVersionEntity(tx, {
      tenantId: input.tenantId,
      entityType: 'OPERATIONAL_UPDATE',
      entityId: input.id,
    })
    const existing = await findUpdate(tx, input.id, input.tenantId)
    if (!existing)
      throw new OperationalUpdateActionError('NOT_FOUND', 'Operational update not found')
    assertSchedulable(existing, now)
    await assertCapacity(tx, {
      tenantId: input.tenantId,
      venueId: existing.venueId,
      startsAt: existing.startsAt,
      expiresAt: existing.expiresAt,
      excludeId: existing.id,
    })
    const changed = await tx.operationalUpdate.updateMany({
      where: {
        id: input.id,
        tenantId: input.tenantId,
        status: 'DRAFT',
        updatedAt: input.expectedUpdatedAt,
      },
      data: {
        status: 'PUBLISHED',
        isActive: true,
        publishedBy: input.actor.id,
        publishedAt: now,
      },
    })
    if (changed.count !== 1) conflict()
    const scheduled = await findUpdate(tx, input.id, input.tenantId)
    if (!scheduled) conflict()
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'operational-update.published',
        targetType: 'OperationalUpdate',
        targetId: input.id,
        beforeState: toAuditState(existing),
        afterState: toAuditState(scheduled),
      },
      tx,
    )
    return { update: scheduled, preview: buildOperationalUpdatePreview(scheduled, now) }
  })
}

export async function expireOperationalUpdateAction(
  input: {
    tenantId: string
    actor: OperationalUpdateHumanActor
    id: string
    expectedUpdatedAt: Date
    now?: Date
  },
  client: OperationalUpdateActionClient = db,
): Promise<OperationalUpdateActionResult> {
  const now = input.now ?? new Date()
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await prepare(tx, input.actor, true)
    await lockContentVersionEntity(tx, {
      tenantId: input.tenantId,
      entityType: 'OPERATIONAL_UPDATE',
      entityId: input.id,
    })
    const existing = await findUpdate(tx, input.id, input.tenantId)
    if (!existing)
      throw new OperationalUpdateActionError('NOT_FOUND', 'Operational update not found')
    if (existing.status !== 'PUBLISHED' || !existing.isActive) {
      throw new OperationalUpdateActionError('CONFLICT', 'Operational update is not active')
    }
    const changed = await tx.operationalUpdate.updateMany({
      where: {
        id: input.id,
        tenantId: input.tenantId,
        status: 'PUBLISHED',
        isActive: true,
        updatedAt: input.expectedUpdatedAt,
      },
      data: { isActive: false },
    })
    if (changed.count !== 1) conflict()
    const expired = await findUpdate(tx, input.id, input.tenantId)
    if (!expired) conflict()
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'operational-update.deactivated',
        targetType: 'OperationalUpdate',
        targetId: input.id,
        beforeState: toAuditState(existing),
        afterState: toAuditState(expired),
      },
      tx,
    )
    return { update: expired, preview: buildOperationalUpdatePreview(expired, now) }
  })
}
