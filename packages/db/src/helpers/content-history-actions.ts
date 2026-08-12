import { z } from 'zod'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import {
  lockContentVersionEntity,
  lockOperationalUpdateCapacity,
  setContentVersionContext,
} from './content-version-context'
import { lockVenueContentMutation } from './venue-content-lock'
import {
  IncompatibleContentSnapshotError,
  knowledgeSnapshotData,
  operationalUpdateSnapshotData,
  placeSnapshotData,
  venueSnapshotData,
} from './content-history-snapshots'

const EntityType = z.enum(['VENUE', 'PLACE', 'KNOWLEDGE_ENTRY', 'OPERATIONAL_UPDATE'])
export type ContentHistoryEntityType = z.infer<typeof EntityType>

export const contentHistoryVersionSelect = {
  id: true,
  sequence: true,
  tenantId: true,
  venueId: true,
  entityType: true,
  entityId: true,
  operation: true,
  beforeState: true,
  afterState: true,
  actorId: true,
  revertedFromId: true,
  snapshotSchemaVersion: true,
  createdAt: true,
} as const

export type ContentHistoryHumanActor = {
  type: 'HUMAN'
  id: string
  role: 'OWNER' | 'MANAGER'
}

export type ContentHistoryActionErrorCode = 'BAD_REQUEST' | 'CONFLICT' | 'FORBIDDEN' | 'NOT_FOUND'

export class ContentHistoryActionError extends Error {
  constructor(
    readonly code: ContentHistoryActionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ContentHistoryActionError'
  }
}

export type ContentHistoryActionClient = Pick<typeof db, '$transaction'>

function fail(code: ContentHistoryActionErrorCode, message: string): never {
  throw new ContentHistoryActionError(code, message)
}

function invalidSnapshot(): never {
  return fail('CONFLICT', 'The selected historical snapshot is incompatible with current content')
}

function mapPersistenceError(error: unknown): never {
  if (error instanceof ContentHistoryActionError) throw error
  if (error instanceof IncompatibleContentSnapshotError) invalidSnapshot()
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if (error.code === 'P2002') {
      throw new ContentHistoryActionError(
        'CONFLICT',
        'That historical state conflicts with current content',
        { cause: error },
      )
    }
    if (error.code === 'P2003') {
      throw new ContentHistoryActionError(
        'CONFLICT',
        'Dependent records prevent restoring that historical deletion',
        { cause: error },
      )
    }
  }
  throw error
}

export async function revertContentHistoryAction(
  input: {
    tenantId: string
    versionId: string
    expectedCurrentVersionId: string
    snapshotSide: 'BEFORE' | 'AFTER'
    actor: ContentHistoryHumanActor
  },
  client: ContentHistoryActionClient = db,
) {
  if (
    input.actor.type !== 'HUMAN' ||
    !input.actor.id ||
    !['OWNER', 'MANAGER'].includes(input.actor.role)
  ) {
    fail('FORBIDDEN', 'A human venue manager is required')
  }

  try {
    return await client.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof db
      const target = await tx.contentVersion.findFirst({
        where: { id: input.versionId, tenantId: input.tenantId },
        select: contentHistoryVersionSelect,
      })
      if (!target) fail('NOT_FOUND', 'Content version not found')

      const entityType = EntityType.safeParse(target.entityType)
      if (!entityType.success) invalidSnapshot()
      if (target.entityType !== 'OPERATIONAL_UPDATE') {
        await lockVenueContentMutation(tx, {
          tenantId: input.tenantId,
          venueId: target.venueId,
        })
      }
      await lockContentVersionEntity(tx, {
        tenantId: input.tenantId,
        entityType: entityType.data,
        entityId: target.entityId,
      })

      const latest = await tx.contentVersion.findFirst({
        where: {
          tenantId: input.tenantId,
          entityType: target.entityType,
          entityId: target.entityId,
        },
        select: { id: true },
        orderBy: { sequence: 'desc' },
      })
      if (!latest || latest.id !== input.expectedCurrentVersionId) {
        fail(
          'CONFLICT',
          'Content changed after this history view was loaded; refresh and try again',
        )
      }

      await setContentVersionContext(tx, {
        actorId: input.actor.id,
        revertedFromId: target.id,
      })
      const isDirectProvenanceSnapshot =
        target.snapshotSchemaVersion === 2 &&
        (target.entityType === 'PLACE' || target.entityType === 'KNOWLEDGE_ENTRY')
      if (target.snapshotSchemaVersion !== 1 && !isDirectProvenanceSnapshot) invalidSnapshot()
      const targetState = input.snapshotSide === 'BEFORE' ? target.beforeState : target.afterState

      if (target.entityType === 'VENUE') {
        const current = await tx.venue.findFirst({
          where: { id: target.entityId, tenantId: input.tenantId },
          select: { id: true },
        })
        if ((current === null || targetState === null) && input.actor.role !== 'OWNER') {
          fail('FORBIDDEN', 'Only an owner can restore or remove a venue')
        }
        if (targetState === null) {
          if (!current) fail('BAD_REQUEST', 'Venue is already deleted')
          const removed = await tx.venue.deleteMany({
            where: { id: target.entityId, tenantId: input.tenantId },
          })
          if (removed.count !== 1) fail('CONFLICT', 'Venue changed during revert')
        } else {
          const snapshot = venueSnapshotData(targetState, {
            tenantId: input.tenantId,
            entityId: target.entityId,
          })
          if (current) {
            const updated = await tx.venue.updateMany({
              where: { id: target.entityId, tenantId: input.tenantId },
              data: snapshot.mutable,
            })
            if (updated.count !== 1) fail('CONFLICT', 'Venue changed during revert')
          } else {
            await tx.venue.create({ data: snapshot.create })
          }
        }
      } else if (target.entityType === 'PLACE') {
        const current = await tx.place.findFirst({
          where: { id: target.entityId, tenantId: input.tenantId },
          select: { id: true, venueId: true },
        })
        if (current && current.venueId !== target.venueId) invalidSnapshot()
        if (targetState === null) {
          if (!current) fail('BAD_REQUEST', 'Place is already deleted')
          const removed = await tx.place.deleteMany({
            where: { id: target.entityId, tenantId: input.tenantId },
          })
          if (removed.count !== 1) fail('CONFLICT', 'Place changed during revert')
        } else {
          const parent = await tx.venue.findFirst({
            where: { id: target.venueId, tenantId: input.tenantId },
            select: { id: true },
          })
          if (!parent) invalidSnapshot()
          const snapshot = placeSnapshotData(targetState, isDirectProvenanceSnapshot ? 2 : 1, {
            tenantId: input.tenantId,
            entityId: target.entityId,
            venueId: target.venueId,
          })
          if (current) {
            const updated = await tx.place.updateMany({
              where: { id: target.entityId, tenantId: input.tenantId },
              data: snapshot.mutable,
            })
            if (updated.count !== 1) fail('CONFLICT', 'Place changed during revert')
          } else {
            await tx.place.create({ data: snapshot.create })
          }
        }
      } else if (target.entityType === 'KNOWLEDGE_ENTRY') {
        const current = await tx.venueKnowledgeEntry.findFirst({
          where: { id: target.entityId, tenantId: input.tenantId },
          select: { id: true, venueId: true },
        })
        if (current && current.venueId !== target.venueId) invalidSnapshot()
        if (targetState === null) {
          if (!current) fail('BAD_REQUEST', 'Knowledge entry is already deleted')
          const removed = await tx.venueKnowledgeEntry.deleteMany({
            where: { id: target.entityId, tenantId: input.tenantId },
          })
          if (removed.count !== 1) fail('CONFLICT', 'Knowledge entry changed during revert')
        } else {
          const parent = await tx.venue.findFirst({
            where: { id: target.venueId, tenantId: input.tenantId },
            select: { id: true },
          })
          if (!parent) invalidSnapshot()
          const snapshot = knowledgeSnapshotData(targetState, isDirectProvenanceSnapshot ? 2 : 1, {
            tenantId: input.tenantId,
            entityId: target.entityId,
            venueId: target.venueId,
          })
          if (current) {
            const updated = await tx.venueKnowledgeEntry.updateMany({
              where: { id: target.entityId, tenantId: input.tenantId },
              data: snapshot.mutable,
            })
            if (updated.count !== 1) fail('CONFLICT', 'Knowledge entry changed during revert')
          } else {
            await tx.venueKnowledgeEntry.create({ data: snapshot.create })
          }
        }
      } else {
        const current = await tx.operationalUpdate.findFirst({
          where: { id: target.entityId, tenantId: input.tenantId },
          select: { id: true },
        })
        if (targetState === null) {
          if (!current) fail('BAD_REQUEST', 'Operational update is already deleted')
          const removed = await tx.operationalUpdate.deleteMany({
            where: { id: target.entityId, tenantId: input.tenantId },
          })
          if (removed.count !== 1) fail('CONFLICT', 'Operational update changed during revert')
        } else {
          const resolved = operationalUpdateSnapshotData(targetState, {
            tenantId: input.tenantId,
            entityId: target.entityId,
          })
          const { snapshot } = resolved
          const parent = await tx.venue.findFirst({
            where: { id: snapshot.venueId, tenantId: input.tenantId },
            select: { id: true },
          })
          if (!parent) invalidSnapshot()
          if (snapshot.placeId !== null) {
            const place = await tx.place.findFirst({
              where: {
                id: snapshot.placeId,
                tenantId: input.tenantId,
                venueId: snapshot.venueId,
              },
              select: { id: true },
            })
            if (!place) invalidSnapshot()
          }
          if (snapshot.status === 'PUBLISHED' && snapshot.isActive) {
            await lockOperationalUpdateCapacity(tx, {
              tenantId: input.tenantId,
              venueId: snapshot.venueId,
            })
            const overlapping = await tx.operationalUpdate.count({
              where: {
                tenantId: input.tenantId,
                venueId: snapshot.venueId,
                status: 'PUBLISHED',
                isActive: true,
                startsAt: { lt: snapshot.expiresAt },
                expiresAt: { gt: snapshot.startsAt },
                id: { not: target.entityId },
              },
            })
            if (overlapping >= 20) {
              fail('CONFLICT', 'A venue can have at most 20 overlapping published updates')
            }
          }
          if (current) {
            const updated = await tx.operationalUpdate.updateMany({
              where: { id: target.entityId, tenantId: input.tenantId },
              data: resolved.mutable,
            })
            if (updated.count !== 1) fail('CONFLICT', 'Operational update changed during revert')
          } else {
            await tx.operationalUpdate.create({ data: resolved.create })
          }
        }
      }

      const appliedVersion = await tx.contentVersion.findFirst({
        where: {
          tenantId: input.tenantId,
          entityType: target.entityType,
          entityId: target.entityId,
        },
        select: contentHistoryVersionSelect,
        orderBy: { sequence: 'desc' },
      })
      if (!appliedVersion || appliedVersion.id === latest.id) {
        fail('BAD_REQUEST', 'The selected version already matches current content')
      }
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'content-history.reverted',
          targetType: target.entityType,
          targetId: target.entityId,
          beforeState: {
            versionId: latest.id,
            venueId: target.venueId,
          },
          afterState: {
            versionId: appliedVersion.id,
            revertedFromId: target.id,
            snapshotSide: input.snapshotSide,
            venueId: target.venueId,
          },
        },
        tx,
      )
      return appliedVersion
    })
  } catch (error) {
    mapPersistenceError(error)
  }
}
