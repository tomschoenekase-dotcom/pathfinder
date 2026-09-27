import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  db,
  getVenueDistributionSessionCounts,
  normalizeVenueWebsiteOrigin,
  resolveVenueDistribution,
  writeAuditLogStrict,
} from '@pathfinder/db'

import { mergeRouters, router } from '../../core'
import { adminProcedure } from '../../trpc'
import {
  bumpDistribution,
  distributionProposalAction,
  proposalSnapshot,
  Reason,
  targetInput,
} from './venue-distribution-shared'
import { venueDistributionProposalRouter } from './venue-distribution-proposal'

const venueDistributionCoreRouter = router({
  get: adminProcedure.input(targetInput).query(async ({ input }) => {
    const venue = await db.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: {
        id: true,
        slug: true,
        name: true,
        isActive: true,
        chatTheme: true,
        chatAccentColor: true,
      },
    })
    if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
    const [resolved, distribution, origins, sessions30d, pendingProposals] = await Promise.all([
      resolveVenueDistribution({
        client: db,
        venueSlug: venue.slug,
        venueTarget: { venueId: venue.id, tenantId: input.tenantId },
      }),
      db.venueDistribution.findFirst({
        where: { tenantId: input.tenantId, venueId: venue.id },
        select: { websiteState: true, appState: true, revision: true },
      }),
      db.venueWebsiteOrigin.findMany({
        where: { tenantId: input.tenantId, venueId: venue.id },
        orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          origin: true,
          state: true,
          addedBy: true,
          addedReason: true,
          addedAt: true,
          revokedBy: true,
          revokedReason: true,
          revokedAt: true,
        },
      }),
      getVenueDistributionSessionCounts(db, input.tenantId, venue.id),
      db.approvalRequest.findMany({
        where: {
          tenantId: input.tenantId,
          venueId: venue.id,
          proposedAction: distributionProposalAction,
          decision: { is: null },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        orderBy: { createdAt: 'asc' },
        take: 50,
        select: { id: true, scopeSnapshot: true, reason: true, createdAt: true },
      }),
    ])
    if (!resolved || resolved.venueId !== venue.id || resolved.tenantId !== input.tenantId) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
    }
    return {
      venue,
      website: { ...resolved.website, state: distribution?.websiteState ?? 'DISABLED' },
      app: { ...resolved.app, state: distribution?.appState ?? 'DISABLED' },
      revision: distribution?.revision ?? 0,
      origins,
      sessions30d,
      proposals: pendingProposals.flatMap((proposal) => {
        const snapshot = proposalSnapshot.safeParse(proposal.scopeSnapshot)
        return snapshot.success &&
          snapshot.data.tenantId === input.tenantId &&
          snapshot.data.venueId === venue.id
          ? [
              {
                approvalRequestId: proposal.id,
                reason: proposal.reason,
                createdAt: proposal.createdAt,
                change: snapshot.data.change,
                expectedRevision: snapshot.data.expectedRevision,
              },
            ]
          : []
      }),
    }
  }),

  setSurfaceState: adminProcedure
    .input(
      targetInput
        .extend({
          surface: z.enum(['website', 'app']),
          state: z.enum(['ENABLED', 'DISABLED']),
          reason: Reason,
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) =>
      db.$transaction(async (tx) => {
        const venue = await tx.venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: { id: true },
        })
        if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
        const before = await tx.venueDistribution.findFirst({
          where: { tenantId: input.tenantId, venueId: input.venueId },
          select: { websiteState: true, appState: true, revision: true },
        })
        const field = input.surface === 'website' ? 'websiteState' : 'appState'
        const after = await bumpDistribution(
          tx,
          {
            tenantId: input.tenantId,
            venueId: input.venueId,
            actorId: ctx.session.userId,
          },
          { [field]: input.state },
        )
        await writeAuditLogStrict(
          {
            tenantId: input.tenantId,
            actorId: ctx.session.userId,
            actorRole: 'PLATFORM_ADMIN',
            action: `admin.venue-distribution.${input.surface}.${input.state.toLowerCase()}`,
            targetType: 'VenueDistribution',
            targetId: input.venueId,
            beforeState: { state: before?.[field] ?? 'DISABLED', revision: before?.revision ?? 0 },
            afterState: { state: after[field], revision: after.revision, reason: input.reason },
          },
          tx,
        )
        return { ...after, replayed: before?.[field] === input.state }
      }),
    ),

  addOrigin: adminProcedure
    .input(targetInput.extend({ origin: z.string().min(1).max(255), reason: Reason }).strict())
    .mutation(async ({ ctx, input }) => {
      const origin = normalizeVenueWebsiteOrigin(input.origin)
      if (!origin)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Enter an exact HTTPS origin.' })
      return db
        .$transaction(
          async (tx) => {
            const venue = await tx.venue.findFirst({
              where: { id: input.venueId, tenantId: input.tenantId },
              select: { id: true },
            })
            if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
            // The revision upsert is the per-venue write lock. Take it before any
            // active-origin check so concurrent additions cannot both pass the cap.
            const bumped = await bumpDistribution(tx, {
              tenantId: input.tenantId,
              venueId: input.venueId,
              actorId: ctx.session.userId,
            })
            const existing = await tx.venueWebsiteOrigin.findFirst({
              where: { tenantId: input.tenantId, venueId: input.venueId, origin, state: 'ACTIVE' },
              select: { id: true },
            })
            if (existing)
              throw new TRPCError({ code: 'CONFLICT', message: 'This origin is already active.' })
            const activeCount = await tx.venueWebsiteOrigin.count({
              where: { tenantId: input.tenantId, venueId: input.venueId, state: 'ACTIVE' },
            })
            if (activeCount >= 20)
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'A venue can have at most 20 active origins.',
              })
            const after = await tx.venueWebsiteOrigin.create({
              data: {
                tenantId: input.tenantId,
                venueId: input.venueId,
                origin,
                addedBy: ctx.session.userId,
                addedReason: input.reason,
              },
              select: { id: true, origin: true },
            })
            await writeAuditLogStrict(
              {
                tenantId: input.tenantId,
                actorId: ctx.session.userId,
                actorRole: 'PLATFORM_ADMIN',
                action: 'admin.venue-distribution.origin.added',
                targetType: 'VenueWebsiteOrigin',
                targetId: after.id,
                afterState: { origin, reason: input.reason, revision: bumped.revision },
              },
              tx,
            )
            return { ...after, revision: bumped.revision, replayed: false }
          },
          { isolationLevel: 'Serializable' },
        )
        .catch((error: unknown) => {
          if (error instanceof TRPCError) throw error
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error.code === 'P2034' || error.code === 'P2002')
          ) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Distribution changed; refresh and try again.',
            })
          }
          throw error
        })
    }),

  revokeOrigin: adminProcedure
    .input(targetInput.extend({ originId: z.string().min(1).max(128), reason: Reason }).strict())
    .mutation(async ({ ctx, input }) =>
      db.$transaction(async (tx) => {
        const before = await tx.venueWebsiteOrigin.findFirst({
          where: { id: input.originId, tenantId: input.tenantId, venueId: input.venueId },
          select: { id: true, origin: true, state: true, revokedAt: true },
        })
        if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'Origin not found' })
        if (before.state === 'REVOKED')
          throw new TRPCError({ code: 'CONFLICT', message: 'This origin is already revoked.' })
        const revokedAt = new Date()
        const changed = await tx.venueWebsiteOrigin.updateMany({
          where: {
            id: before.id,
            tenantId: input.tenantId,
            venueId: input.venueId,
            state: 'ACTIVE',
          },
          data: {
            state: 'REVOKED',
            revokedAt,
            revokedBy: ctx.session.userId,
            revokedReason: input.reason,
          },
        })
        if (changed.count !== 1)
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Origin changed; refresh and try again.',
          })
        const bumped = await bumpDistribution(tx, {
          tenantId: input.tenantId,
          venueId: input.venueId,
          actorId: ctx.session.userId,
        })
        await writeAuditLogStrict(
          {
            tenantId: input.tenantId,
            actorId: ctx.session.userId,
            actorRole: 'PLATFORM_ADMIN',
            action: 'admin.venue-distribution.origin.revoked',
            targetType: 'VenueWebsiteOrigin',
            targetId: before.id,
            beforeState: { origin: before.origin, state: before.state },
            afterState: {
              origin: before.origin,
              state: 'REVOKED',
              reason: input.reason,
              revision: bumped.revision,
            },
          },
          tx,
        )
        return { id: before.id, origin: before.origin, revision: bumped.revision, replayed: false }
      }),
    ),
})

const venueDistributionProcedures = mergeRouters(
  venueDistributionCoreRouter,
  venueDistributionProposalRouter,
)

export const adminVenueDistributionRouter = router({
  venueDistribution: venueDistributionProcedures,
})
