import { TRPCError } from '@trpc/server'
import {
  lockContentVersionEntity,
  lockOperationalUpdateCapacity,
  writeAuditLogStrict,
} from '@pathfinder/db'

import {
  CreateOperationalUpdateInput,
  DeactivateOperationalUpdateInput,
  MAX_GUEST_OPERATIONAL_UPDATES,
  OperationalUpdateLifecycleInput,
  UpdateOperationalUpdateInput,
} from '../schemas/operational-update'
import { router } from '../core'
import type { TRPCContext } from '../context'
import { withContentVersionActor } from '../middleware/content-version-actor'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

type DbClient = TRPCContext['db']

const operationalUpdateSelect = {
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

type SelectedUpdate = {
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

function toAuditState(update: SelectedUpdate) {
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

async function assertVenueBelongsToTenant(db: DbClient, venueId: string, tenantId: string) {
  const venue = await db.venue.findFirst({
    where: { id: venueId, tenantId },
    select: { id: true },
  })
  if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
}

async function assertPlaceBelongsToVenue(
  db: DbClient,
  placeId: string | null | undefined,
  venueId: string,
  tenantId: string,
) {
  if (!placeId) return
  const place = await db.place.findFirst({
    where: { id: placeId, venueId, tenantId },
    select: { id: true },
  })
  if (!place) throw new TRPCError({ code: 'NOT_FOUND', message: 'Place not found' })
}

function assertPublishable(update: Pick<SelectedUpdate, 'status' | 'expiresAt'>, now: Date) {
  if (update.status !== 'DRAFT') {
    throw new TRPCError({ code: 'CONFLICT', message: 'Only a draft can be published' })
  }
  if (update.expiresAt.getTime() <= now.getTime()) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Expired updates cannot be published' })
  }
}

async function findUpdate(db: DbClient, id: string, tenantId: string) {
  return db.operationalUpdate.findFirst({
    where: { id, tenantId },
    select: operationalUpdateSelect,
  })
}

async function assertGuestPromptCapacity(
  db: DbClient,
  input: {
    tenantId: string
    venueId: string
    startsAt: Date
    expiresAt: Date
    excludeId?: string
  },
) {
  await lockOperationalUpdateCapacity(db, {
    tenantId: input.tenantId,
    venueId: input.venueId,
  })
  const overlapping = await db.operationalUpdate.count({
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
  if (overlapping >= MAX_GUEST_OPERATIONAL_UPDATES) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `A venue can have at most ${MAX_GUEST_OPERATIONAL_UPDATES} overlapping published updates`,
    })
  }
}

function conflict(): never {
  throw new TRPCError({
    code: 'CONFLICT',
    message: 'Operational update changed after this page loaded; refresh and try again',
  })
}

export const operationalUpdateRouter = router({
  list: tenantProcedure.query(({ ctx }) =>
    ctx.db.operationalUpdate.findMany({
      where: { tenantId: ctx.session.activeTenantId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 500,
      select: operationalUpdateSelect,
    }),
  ),

  getById: tenantProcedure
    .input(OperationalUpdateLifecycleInput.pick({ id: true }))
    .query(async ({ ctx, input }) => {
      const update = await findUpdate(ctx.db, input.id, ctx.session.activeTenantId)
      if (!update)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Operational update not found' })
      return update
    }),

  create: tenantProcedure
    .use(requireRole('MANAGER'))
    .use(withContentVersionActor)
    .input(CreateOperationalUpdateInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      await assertVenueBelongsToTenant(ctx.db, input.venueId, tenantId)
      await assertPlaceBelongsToVenue(ctx.db, input.placeId, input.venueId, tenantId)

      const now = new Date()
      if (input.publish && input.expiresAt.getTime() <= now.getTime()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Expired updates cannot be published' })
      }
      if (input.publish) {
        await assertGuestPromptCapacity(ctx.db, {
          tenantId,
          venueId: input.venueId,
          startsAt: input.startsAt,
          expiresAt: input.expiresAt,
        })
      }

      const created = await ctx.db.operationalUpdate.create({
        data: {
          tenantId,
          venueId: input.venueId,
          placeId: input.placeId ?? null,
          updateType: input.updateType,
          severity: input.severity,
          priority: input.priority,
          title: input.title,
          body: input.body ?? null,
          redirectTo: input.redirectTo ?? null,
          startsAt: input.startsAt,
          expiresAt: input.expiresAt,
          status: input.publish ? 'PUBLISHED' : 'DRAFT',
          isActive: input.publish,
          createdBy: ctx.session.userId,
          publishedBy: input.publish ? ctx.session.userId : null,
          publishedAt: input.publish ? now : null,
        },
        select: operationalUpdateSelect,
      })

      await writeAuditLogStrict(
        {
          tenantId,
          actorId: ctx.session.userId,
          actorRole: ctx.session.role ?? 'MANAGER',
          action: input.publish
            ? 'operational-update.created-published'
            : 'operational-update.created-draft',
          targetType: 'OperationalUpdate',
          targetId: created.id,
          afterState: toAuditState(created),
        },
        ctx.db,
      )
      return created
    }),

  update: tenantProcedure
    .use(requireRole('MANAGER'))
    .use(withContentVersionActor)
    .input(UpdateOperationalUpdateInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      await lockContentVersionEntity(ctx.db, {
        tenantId,
        entityType: 'OPERATIONAL_UPDATE',
        entityId: input.id,
      })
      const existing = await findUpdate(ctx.db, input.id, tenantId)
      if (!existing)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Operational update not found' })
      await assertVenueBelongsToTenant(ctx.db, input.venueId, tenantId)
      await assertPlaceBelongsToVenue(ctx.db, input.placeId, input.venueId, tenantId)
      const now = new Date()
      if (input.publish) assertPublishable(existing, now)
      if (input.publish || (existing.status === 'PUBLISHED' && existing.isActive)) {
        await assertGuestPromptCapacity(ctx.db, {
          tenantId,
          venueId: input.venueId,
          startsAt: input.startsAt,
          expiresAt: input.expiresAt,
          excludeId: input.id,
        })
      }

      const changed = await ctx.db.operationalUpdate.updateMany({
        where: {
          id: input.id,
          tenantId,
          updatedAt: input.expectedUpdatedAt,
          ...(input.publish ? { status: 'DRAFT' as const } : {}),
        },
        data: {
          venueId: input.venueId,
          placeId: input.placeId ?? null,
          updateType: input.updateType,
          severity: input.severity,
          priority: input.priority,
          title: input.title,
          body: input.body ?? null,
          redirectTo: input.redirectTo ?? null,
          startsAt: input.startsAt,
          expiresAt: input.expiresAt,
          ...(input.publish
            ? {
                status: 'PUBLISHED' as const,
                isActive: true,
                publishedBy: ctx.session.userId,
                publishedAt: now,
              }
            : {}),
        },
      })
      if (changed.count !== 1) conflict()
      const updated = await findUpdate(ctx.db, input.id, tenantId)
      if (!updated) conflict()

      await writeAuditLogStrict(
        {
          tenantId,
          actorId: ctx.session.userId,
          actorRole: ctx.session.role ?? 'MANAGER',
          action: input.publish
            ? 'operational-update.updated-published'
            : 'operational-update.updated',
          targetType: 'OperationalUpdate',
          targetId: input.id,
          beforeState: toAuditState(existing),
          afterState: toAuditState(updated),
        },
        ctx.db,
      )
      return updated
    }),

  publish: tenantProcedure
    .use(requireRole('MANAGER'))
    .use(withContentVersionActor)
    .input(OperationalUpdateLifecycleInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      await lockContentVersionEntity(ctx.db, {
        tenantId,
        entityType: 'OPERATIONAL_UPDATE',
        entityId: input.id,
      })
      const existing = await findUpdate(ctx.db, input.id, tenantId)
      if (!existing)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Operational update not found' })
      const now = new Date()
      assertPublishable(existing, now)
      await assertGuestPromptCapacity(ctx.db, {
        tenantId,
        venueId: existing.venueId,
        startsAt: existing.startsAt,
        expiresAt: existing.expiresAt,
        excludeId: existing.id,
      })

      const changed = await ctx.db.operationalUpdate.updateMany({
        where: {
          id: input.id,
          tenantId,
          status: 'DRAFT',
          updatedAt: input.expectedUpdatedAt,
        },
        data: {
          status: 'PUBLISHED',
          isActive: true,
          publishedBy: ctx.session.userId,
          publishedAt: now,
        },
      })
      if (changed.count !== 1) conflict()
      const published = await findUpdate(ctx.db, input.id, tenantId)
      if (!published) conflict()

      await writeAuditLogStrict(
        {
          tenantId,
          actorId: ctx.session.userId,
          actorRole: ctx.session.role ?? 'MANAGER',
          action: 'operational-update.published',
          targetType: 'OperationalUpdate',
          targetId: input.id,
          beforeState: toAuditState(existing),
          afterState: toAuditState(published),
        },
        ctx.db,
      )
      return published
    }),

  deactivate: tenantProcedure
    .use(requireRole('MANAGER'))
    .use(withContentVersionActor)
    .input(DeactivateOperationalUpdateInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      await lockContentVersionEntity(ctx.db, {
        tenantId,
        entityType: 'OPERATIONAL_UPDATE',
        entityId: input.id,
      })
      const existing = await findUpdate(ctx.db, input.id, tenantId)
      if (!existing)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Operational update not found' })
      if (existing.status !== 'PUBLISHED' || !existing.isActive) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Operational update is not active' })
      }

      const changed = await ctx.db.operationalUpdate.updateMany({
        where: {
          id: input.id,
          tenantId,
          status: 'PUBLISHED',
          isActive: true,
          updatedAt: input.expectedUpdatedAt,
        },
        data: { isActive: false },
      })
      if (changed.count !== 1) conflict()
      const deactivated = await findUpdate(ctx.db, input.id, tenantId)
      if (!deactivated) conflict()

      await writeAuditLogStrict(
        {
          tenantId,
          actorId: ctx.session.userId,
          actorRole: ctx.session.role ?? 'MANAGER',
          action: 'operational-update.deactivated',
          targetType: 'OperationalUpdate',
          targetId: input.id,
          beforeState: toAuditState(existing),
          afterState: toAuditState(deactivated),
        },
        ctx.db,
      )
      return deactivated
    }),
})
