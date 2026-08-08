import { createHash } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import { lockVenueContentMutation, writeAuditLogStrict } from '@pathfinder/db'

import {
  canonicalVenuePackagePayload,
  VenuePackageApprovalInput,
  VenuePackageAppliedEntities,
  VenuePackageByIdInput,
  VenuePackageDraftInput,
  VenuePackageLifecycleInput,
  VenuePackagePayload,
  VenuePackagePreviewInput,
} from '../schemas/venue-package'
import { router } from '../core'
import type { TRPCContext } from '../context'
import { withContentVersionActor } from '../middleware/content-version-actor'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

type DbClient = TRPCContext['db']
type PackagePayload = VenuePackagePayload

const venuePackageSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  draftKey: true,
  schemaVersion: true,
  payload: true,
  payloadHash: true,
  baseDigest: true,
  validationReport: true,
  previewPlan: true,
  status: true,
  createdBy: true,
  approvedBy: true,
  approvedAt: true,
  approvedCommandKey: true,
  approvalWarningDigest: true,
  approvedWarningCodes: true,
  appliedBy: true,
  appliedAt: true,
  appliedCommandKey: true,
  appliedEntities: true,
  revertedBy: true,
  revertedAt: true,
  revertedCommandKey: true,
  createdAt: true,
  updatedAt: true,
} as const

function conflict(message = 'Venue package changed; refresh and review it again'): never {
  throw new TRPCError({ code: 'CONFLICT', message })
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function jsonValue(value: unknown): object {
  return JSON.parse(JSON.stringify(value)) as object
}

function normalizeLabel(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
}

async function assertVenue(db: DbClient, tenantId: string, venueId: string) {
  const venue = await db.venue.findFirst({
    where: { id: venueId, tenantId },
    select: { id: true, guideMode: true },
  })
  if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
  return venue
}

async function contentState(db: DbClient, tenantId: string, venueId: string) {
  const [places, knowledgeEntries] = await Promise.all([
    db.place.findMany({
      where: { tenantId, venueId },
      select: {
        id: true,
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
      },
      orderBy: { id: 'asc' },
    }),
    db.venueKnowledgeEntry.findMany({
      where: { tenantId, venueId },
      select: { id: true, title: true, category: true, content: true, isEnabled: true },
      orderBy: { id: 'asc' },
    }),
  ])
  return { places, knowledgeEntries }
}

async function contentStateDigest(db: DbClient, tenantId: string, venueId: string) {
  return digest(await contentState(db, tenantId, venueId))
}

function duplicateWarnings(
  payload: PackagePayload,
  current: Awaited<ReturnType<typeof contentState>>,
) {
  const warnings: Array<{ code: string; path: string; message: string }> = []
  const existingPlaceNames = new Set(
    current.places.filter((place) => place.isActive).map((place) => normalizeLabel(place.name)),
  )
  const existingKnowledgeTitles = new Set(
    current.knowledgeEntries.map((entry) => normalizeLabel(entry.title)),
  )

  const seenPlaces = new Set<string>()
  payload.places.forEach((place, index) => {
    const normalized = normalizeLabel(place.name)
    if (seenPlaces.has(normalized)) {
      warnings.push({
        code: 'DUPLICATE_IN_PACKAGE',
        path: `places.${index}.name`,
        message: `Another package place has the normalized name “${normalized}”.`,
      })
    } else if (existingPlaceNames.has(normalized)) {
      warnings.push({
        code: 'DUPLICATE_EXISTING_CONTENT',
        path: `places.${index}.name`,
        message: `An active venue place already has the normalized name “${normalized}”.`,
      })
    }
    seenPlaces.add(normalized)
  })

  const seenKnowledge = new Set<string>()
  payload.knowledgeEntries.forEach((entry, index) => {
    const normalized = normalizeLabel(entry.title)
    if (seenKnowledge.has(normalized)) {
      warnings.push({
        code: 'DUPLICATE_IN_PACKAGE',
        path: `knowledgeEntries.${index}.title`,
        message: `Another package knowledge entry has the normalized title “${normalized}”.`,
      })
    } else if (existingKnowledgeTitles.has(normalized)) {
      warnings.push({
        code: 'DUPLICATE_EXISTING_CONTENT',
        path: `knowledgeEntries.${index}.title`,
        message: `Venue knowledge already has the normalized title “${normalized}”.`,
      })
    }
    seenKnowledge.add(normalized)
  })

  return warnings.sort((left, right) =>
    `${left.path}\u0000${left.code}`.localeCompare(`${right.path}\u0000${right.code}`, 'en-US'),
  )
}

async function buildPreview(
  db: DbClient,
  tenantId: string,
  venueId: string,
  payload: PackagePayload,
) {
  const venue = await assertVenue(db, tenantId, venueId)
  const current = await contentState(db, tenantId, venueId)
  const errors: Array<{ code: string; path: string; message: string }> = []
  if (
    venue.guideMode === 'location_aware' &&
    payload.places.some((place) => place.lat === undefined || place.lng === undefined)
  ) {
    payload.places.forEach((place, index) => {
      if (place.lat === undefined || place.lng === undefined) {
        errors.push({
          code: 'LOCATION_REQUIRED',
          path: `places.${index}`,
          message: 'Latitude and longitude are required for this location-aware venue.',
        })
      }
    })
  }

  const baseDigest = digest(current)
  const payloadHash = digest(canonicalVenuePackagePayload(venueId, payload))
  const report = { errors, warnings: duplicateWarnings(payload, current) }
  return {
    schemaVersion: payload.schemaVersion,
    payloadHash,
    baseDigest,
    mode: 'ADDITIVE_V1' as const,
    warningDigest: digest(report.warnings),
    report,
    changes: {
      places: { add: payload.places, change: [], remove: [], unchanged: current.places.length },
      knowledgeEntries: {
        add: payload.knowledgeEntries,
        change: [],
        remove: [],
        unchanged: current.knowledgeEntries.length,
      },
    },
  }
}

async function findPackage(db: DbClient, tenantId: string, id: string) {
  return db.venuePackage.findFirst({ where: { id, tenantId }, select: venuePackageSelect })
}

function auditState(pkg: NonNullable<Awaited<ReturnType<typeof findPackage>>>) {
  return {
    id: pkg.id,
    venueId: pkg.venueId,
    schemaVersion: pkg.schemaVersion,
    payloadHash: pkg.payloadHash,
    baseDigest: pkg.baseDigest,
    approvalWarningDigest: pkg.approvalWarningDigest,
    approvedWarningCodes: pkg.approvedWarningCodes,
    status: pkg.status,
    createdBy: pkg.createdBy,
    approvedBy: pkg.approvedBy,
    approvedAt: pkg.approvedAt?.toISOString() ?? null,
    appliedBy: pkg.appliedBy,
    appliedAt: pkg.appliedAt?.toISOString() ?? null,
    revertedBy: pkg.revertedBy,
    revertedAt: pkg.revertedAt?.toISOString() ?? null,
    createdAt: pkg.createdAt.toISOString(),
    updatedAt: pkg.updatedAt.toISOString(),
  }
}

function parsePayload(value: unknown): PackagePayload {
  const result = VenuePackagePayload.safeParse(value)
  if (!result.success) conflict('Stored venue package payload is invalid')
  return result.data
}

function matchesPlace(
  current: Awaited<ReturnType<typeof contentState>>['places'][number],
  expected: VenuePackageAppliedEntities['places'][number],
) {
  return (
    current.id === expected.id &&
    current.name === expected.name &&
    current.type === expected.type &&
    current.itemType === (expected.itemType ?? null) &&
    current.shortDescription === (expected.shortDescription ?? null) &&
    current.longDescription === (expected.longDescription ?? null) &&
    current.lat === (expected.lat ?? null) &&
    current.lng === (expected.lng ?? null) &&
    JSON.stringify(current.tags) === JSON.stringify(expected.tags) &&
    current.importanceScore === expected.importanceScore &&
    current.areaName === (expected.areaName ?? null) &&
    current.hours === (expected.hours ?? null) &&
    current.photoUrl === (expected.photoUrl ?? null) &&
    current.isActive
  )
}

function matchesKnowledge(
  current: Awaited<ReturnType<typeof contentState>>['knowledgeEntries'][number],
  expected: VenuePackageAppliedEntities['knowledgeEntries'][number],
) {
  return (
    current.id === expected.id &&
    current.title === expected.title &&
    current.category === expected.category &&
    current.content === expected.content &&
    current.isEnabled === expected.isEnabled
  )
}

export const venuePackageRouter = router({
  preview: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(VenuePackagePreviewInput)
    .mutation(({ ctx, input }) =>
      buildPreview(ctx.db, ctx.session.activeTenantId, input.venueId, input.payload),
    ),

  list: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(VenuePackagePreviewInput.pick({ venueId: true }))
    .query(async ({ ctx, input }) => {
      await assertVenue(ctx.db, ctx.session.activeTenantId, input.venueId)
      return ctx.db.venuePackage.findMany({
        where: { tenantId: ctx.session.activeTenantId, venueId: input.venueId },
        select: venuePackageSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: 100,
      })
    }),

  getById: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(VenuePackageByIdInput)
    .query(async ({ ctx, input }) => {
      const pkg = await findPackage(ctx.db, ctx.session.activeTenantId, input.id)
      if (!pkg) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue package not found' })
      return pkg
    }),

  createDraft: tenantProcedure
    .use(requireRole('MANAGER'))
    .use(withContentVersionActor)
    .input(VenuePackageDraftInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      await lockVenueContentMutation(ctx.db, { tenantId, venueId: input.venueId })
      const preview = await buildPreview(ctx.db, tenantId, input.venueId, input.payload)

      const key = {
        tenantId,
        venueId: input.venueId,
        draftKey: input.draftKey,
      }
      const claimed = await ctx.db.venuePackage.createMany({
        data: [
          {
            ...key,
            schemaVersion: input.payload.schemaVersion,
            payload: jsonValue(input.payload),
            payloadHash: preview.payloadHash,
            baseDigest: preview.baseDigest,
            validationReport: jsonValue(preview.report),
            previewPlan: jsonValue(preview),
            createdBy: ctx.session.userId,
          },
        ],
        skipDuplicates: true,
      })
      const pkg = await ctx.db.venuePackage.findFirst({ where: key, select: venuePackageSelect })
      if (!pkg) conflict('Venue package draft claim was lost')
      if (pkg.payloadHash !== preview.payloadHash || pkg.baseDigest !== preview.baseDigest) {
        conflict('Draft key was already used for different venue-package content')
      }

      if (claimed.count === 1) {
        await writeAuditLogStrict(
          {
            tenantId,
            actorId: ctx.session.userId,
            actorRole: ctx.session.role ?? 'MANAGER',
            action: 'venue-package.created-draft',
            targetType: 'VenuePackage',
            targetId: pkg.id,
            afterState: auditState(pkg),
          },
          ctx.db,
        )
      }
      return { ...pkg, preview, replayed: claimed.count === 0 }
    }),

  approve: tenantProcedure
    .use(requireRole('OWNER'))
    .use(withContentVersionActor)
    .input(VenuePackageApprovalInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      let existing = await findPackage(ctx.db, tenantId, input.id)
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue package not found' })
      await lockVenueContentMutation(ctx.db, { tenantId, venueId: existing.venueId })
      existing = await findPackage(ctx.db, tenantId, input.id)
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue package not found' })
      if (existing.status !== 'DRAFT') {
        if (existing.approvedCommandKey === input.commandKey) return existing
        conflict('Only a draft venue package can be approved')
      }
      const payload = parsePayload(existing.payload)
      const preview = await buildPreview(ctx.db, tenantId, existing.venueId, payload)
      if (preview.baseDigest !== existing.baseDigest)
        conflict('Venue content changed; create a new preview')
      if (preview.report.errors.length > 0) conflict('Venue package no longer validates')
      if (preview.payloadHash !== input.acknowledgedPayloadHash) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The acknowledged venue-package payload does not match this immutable draft',
        })
      }
      if (preview.warningDigest !== input.acknowledgedWarningDigest) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Review and acknowledge the current venue-package warnings before approval',
        })
      }

      const now = new Date()
      const changed = await ctx.db.venuePackage.updateMany({
        where: {
          id: input.id,
          tenantId,
          status: 'DRAFT',
          updatedAt: input.expectedUpdatedAt,
        },
        data: {
          status: 'APPROVED',
          approvedBy: ctx.session.userId,
          approvedAt: now,
          approvedCommandKey: input.commandKey,
          approvalWarningDigest: preview.warningDigest,
          approvedWarningCodes: jsonValue(
            [...new Set(preview.report.warnings.map((warning) => warning.code))].sort(),
          ),
        },
      })
      if (changed.count !== 1) conflict()
      const approved = await findPackage(ctx.db, tenantId, input.id)
      if (!approved) conflict()
      await writeAuditLogStrict(
        {
          tenantId,
          actorId: ctx.session.userId,
          actorRole: ctx.session.role ?? 'MANAGER',
          action: 'venue-package.approved',
          targetType: 'VenuePackage',
          targetId: input.id,
          beforeState: auditState(existing),
          afterState: auditState(approved),
        },
        ctx.db,
      )
      return approved
    }),

  applyPackage: tenantProcedure
    .use(requireRole('OWNER'))
    .use(withContentVersionActor)
    .input(VenuePackageLifecycleInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      let existing = await findPackage(ctx.db, tenantId, input.id)
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue package not found' })
      await lockVenueContentMutation(ctx.db, { tenantId, venueId: existing.venueId })
      existing = await findPackage(ctx.db, tenantId, input.id)
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue package not found' })
      if (existing.status !== 'APPROVED') {
        if (existing.appliedCommandKey === input.commandKey) return existing
        conflict('Only an approved venue package can be applied')
      }
      const payload = parsePayload(existing.payload)
      const preview = await buildPreview(ctx.db, tenantId, existing.venueId, payload)
      if (preview.baseDigest !== existing.baseDigest)
        conflict('Venue content changed; create a new preview')
      if (preview.report.errors.length > 0) conflict('Venue package no longer validates')

      try {
        const places =
          payload.places.length === 0
            ? []
            : await ctx.db.place.createManyAndReturn({
                data: payload.places.map((place) => ({
                  tenantId,
                  venueId: existing.venueId,
                  name: place.name,
                  type: place.type,
                  ...(place.itemType !== undefined ? { itemType: place.itemType } : {}),
                  ...(place.shortDescription !== undefined
                    ? { shortDescription: place.shortDescription }
                    : {}),
                  ...(place.longDescription !== undefined
                    ? { longDescription: place.longDescription }
                    : {}),
                  ...(place.lat !== undefined ? { lat: place.lat } : {}),
                  ...(place.lng !== undefined ? { lng: place.lng } : {}),
                  tags: place.tags,
                  importanceScore: place.importanceScore,
                  ...(place.areaName !== undefined ? { areaName: place.areaName } : {}),
                  ...(place.hours !== undefined ? { hours: place.hours } : {}),
                  ...(place.photoUrl !== undefined ? { photoUrl: place.photoUrl } : {}),
                })),
                select: {
                  id: true,
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
                },
              })
        const knowledgeEntries =
          payload.knowledgeEntries.length === 0
            ? []
            : await ctx.db.venueKnowledgeEntry.createManyAndReturn({
                data: payload.knowledgeEntries.map((entry) => ({
                  tenantId,
                  venueId: existing.venueId,
                  title: entry.title,
                  category: entry.category,
                  content: entry.content,
                  isEnabled: entry.isEnabled,
                })),
                select: { id: true, title: true, category: true, content: true, isEnabled: true },
              })
        const appliedEntities = VenuePackageAppliedEntities.parse({
          postApplyDigest: await contentStateDigest(ctx.db, tenantId, existing.venueId),
          places,
          knowledgeEntries,
        })
        const now = new Date()
        const changed = await ctx.db.venuePackage.updateMany({
          where: {
            id: input.id,
            tenantId,
            status: 'APPROVED',
            updatedAt: input.expectedUpdatedAt,
          },
          data: {
            status: 'APPLIED',
            appliedBy: ctx.session.userId,
            appliedAt: now,
            appliedCommandKey: input.commandKey,
            appliedEntities: jsonValue(appliedEntities),
          },
        })
        if (changed.count !== 1) conflict()
        const applied = await findPackage(ctx.db, tenantId, input.id)
        if (!applied) conflict()
        await writeAuditLogStrict(
          {
            tenantId,
            actorId: ctx.session.userId,
            actorRole: ctx.session.role ?? 'MANAGER',
            action: 'venue-package.applied',
            targetType: 'VenuePackage',
            targetId: input.id,
            beforeState: auditState(existing),
            afterState: auditState(applied),
          },
          ctx.db,
        )
        return applied
      } catch (error) {
        if (
          error instanceof TRPCError ||
          (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002')
        ) {
          if (error instanceof TRPCError) throw error
          conflict('Venue-package command key was already used')
        }
        throw error
      }
    }),

  revertPackage: tenantProcedure
    .use(requireRole('OWNER'))
    .use(withContentVersionActor)
    .input(VenuePackageLifecycleInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      let existing = await findPackage(ctx.db, tenantId, input.id)
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue package not found' })
      await lockVenueContentMutation(ctx.db, { tenantId, venueId: existing.venueId })
      existing = await findPackage(ctx.db, tenantId, input.id)
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue package not found' })
      if (existing.status !== 'APPLIED') {
        if (existing.revertedCommandKey === input.commandKey) return existing
        conflict('Only an applied venue package can be reverted')
      }
      const manifestResult = VenuePackageAppliedEntities.safeParse(existing.appliedEntities)
      if (!manifestResult.success) conflict('Venue package rollback manifest is invalid')
      const manifest = manifestResult.data
      const current = await contentState(ctx.db, tenantId, existing.venueId)
      if (digest(current) !== manifest.postApplyDigest) {
        conflict('Venue content changed after apply; automatic package rollback is unsafe')
      }

      const currentPlaces = new Map(current.places.map((place) => [place.id, place]))
      const currentKnowledge = new Map(current.knowledgeEntries.map((entry) => [entry.id, entry]))
      if (
        manifest.places.some((place) => {
          const row = currentPlaces.get(place.id)
          return !row || !matchesPlace(row, place)
        }) ||
        manifest.knowledgeEntries.some((entry) => {
          const row = currentKnowledge.get(entry.id)
          return !row || !matchesKnowledge(row, entry)
        })
      ) {
        conflict('Applied package content changed; automatic rollback is unsafe')
      }

      const removedKnowledge = await ctx.db.venueKnowledgeEntry.deleteMany({
        where: {
          tenantId,
          venueId: existing.venueId,
          id: { in: manifest.knowledgeEntries.map((entry) => entry.id) },
        },
      })
      if (removedKnowledge.count !== manifest.knowledgeEntries.length) conflict()
      const removedPlaces = await ctx.db.place.deleteMany({
        where: {
          tenantId,
          venueId: existing.venueId,
          id: { in: manifest.places.map((place) => place.id) },
        },
      })
      if (removedPlaces.count !== manifest.places.length) conflict()
      if ((await contentStateDigest(ctx.db, tenantId, existing.venueId)) !== existing.baseDigest) {
        conflict('Venue package rollback did not restore the approved base state')
      }

      const now = new Date()
      const changed = await ctx.db.venuePackage.updateMany({
        where: {
          id: input.id,
          tenantId,
          status: 'APPLIED',
          updatedAt: input.expectedUpdatedAt,
        },
        data: {
          status: 'REVERTED',
          revertedBy: ctx.session.userId,
          revertedAt: now,
          revertedCommandKey: input.commandKey,
        },
      })
      if (changed.count !== 1) conflict()
      const reverted = await findPackage(ctx.db, tenantId, input.id)
      if (!reverted) conflict()
      await writeAuditLogStrict(
        {
          tenantId,
          actorId: ctx.session.userId,
          actorRole: ctx.session.role ?? 'MANAGER',
          action: 'venue-package.reverted',
          targetType: 'VenuePackage',
          targetId: input.id,
          beforeState: auditState(existing),
          afterState: auditState(reverted),
        },
        ctx.db,
      )
      return reverted
    }),
})
