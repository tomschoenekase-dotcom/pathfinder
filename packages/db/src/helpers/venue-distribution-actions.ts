import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { normalizeVenueWebsiteOrigin } from './venue-distribution'

/**
 * Canonical visitor-distribution change for non-dashboard callers (the operator MCP).
 * Same rules as the admin Visitor access screen: exact HTTPS origins, at most 20 active
 * origins, platform-admin actor, strict audit. Every change is bound to the revision the
 * caller read, so a proposal reviewed against an older state cannot apply.
 */
export type VenueDistributionChange =
  | { kind: 'SET_SURFACE'; surface: 'WEBSITE' | 'APP'; enabled: boolean }
  | { kind: 'ADD_ORIGIN'; origin: string }
  | { kind: 'REVOKE_ORIGIN'; origin: string }

export type VenueDistributionAdminActor = { type: 'HUMAN'; id: string; role: 'PLATFORM_ADMIN' }

export class VenueDistributionActionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message)
    this.name = 'VenueDistributionActionError'
  }
}

type DistributionClient = Pick<typeof db, '$transaction'>
const MAX_ACTIVE_ORIGINS = 20

export async function readVenueDistributionState(
  client: Pick<typeof db, 'venueDistribution' | 'venueWebsiteOrigin'>,
  tenantId: string,
  venueId: string,
) {
  const [distribution, origins] = await Promise.all([
    client.venueDistribution.findFirst({
      where: { tenantId, venueId },
      select: { websiteState: true, appState: true, revision: true },
    }),
    client.venueWebsiteOrigin.findMany({
      where: { tenantId, venueId },
      orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
      take: 100,
      select: { origin: true, state: true, addedAt: true, revokedAt: true },
    }),
  ])
  return {
    websiteState: distribution?.websiteState ?? ('DISABLED' as const),
    appState: distribution?.appState ?? ('DISABLED' as const),
    revision: distribution?.revision ?? 0,
    origins: origins.map((origin) => ({
      origin: origin.origin,
      state: origin.state,
      addedAt: origin.addedAt.toISOString(),
      revokedAt: origin.revokedAt?.toISOString() ?? null,
    })),
  }
}

export async function applyVenueDistributionChangeAction(
  input: {
    tenantId: string
    venueId: string
    expectedRevision: number
    change: VenueDistributionChange
    reason: string
    actor: VenueDistributionAdminActor
  },
  client: DistributionClient = db,
) {
  if (input.actor.type !== 'HUMAN' || input.actor.role !== 'PLATFORM_ADMIN' || !input.actor.id)
    throw new VenueDistributionActionError('INVALID_INPUT', 'A platform administrator is required')
  const reason = input.reason.trim()
  if (!reason || reason.length > 500)
    throw new VenueDistributionActionError('INVALID_INPUT', 'A reason is required')
  const change = input.change
  const origin =
    change.kind === 'SET_SURFACE' ? null : normalizeVenueWebsiteOrigin(change.origin)
  if (change.kind !== 'SET_SURFACE' && (!origin || origin !== change.origin))
    throw new VenueDistributionActionError('INVALID_INPUT', 'Use an exact normalized HTTPS origin')
  try {
    return await client.$transaction(
      async (rawTx) => {
        const tx = rawTx as unknown as typeof db
        const venue = await tx.venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: { id: true },
        })
        if (!venue) throw new VenueDistributionActionError('NOT_FOUND', 'Venue not found')
        const before = await tx.venueDistribution.findFirst({
          where: { tenantId: input.tenantId, venueId: input.venueId },
          select: { websiteState: true, appState: true, revision: true },
        })
        if ((before?.revision ?? 0) !== input.expectedRevision)
          throw new VenueDistributionActionError(
            'CONFLICT',
            'Distribution changed since it was read. Read it again and propose a new change.',
          )
        // The revision upsert is the per-venue write lock (the admin screen relies on it too).
        const surfaceField =
          change.kind === 'SET_SURFACE'
            ? change.surface === 'WEBSITE'
              ? 'websiteState'
              : 'appState'
            : null
        const bumped = await tx.venueDistribution.upsert({
          where: { venueId_tenantId: { venueId: input.venueId, tenantId: input.tenantId } },
          create: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            updatedBy: input.actor.id,
            ...(surfaceField && change.kind === 'SET_SURFACE'
              ? { [surfaceField]: change.enabled ? 'ENABLED' : 'DISABLED' }
              : {}),
          },
          update: {
            revision: { increment: 1 },
            updatedBy: input.actor.id,
            ...(surfaceField && change.kind === 'SET_SURFACE'
              ? { [surfaceField]: change.enabled ? 'ENABLED' : 'DISABLED' }
              : {}),
          },
          select: { websiteState: true, appState: true, revision: true },
        })
        let action: string
        let targetType = 'VenueDistribution'
        let targetId = input.venueId
        let beforeState: Record<string, unknown> = { revision: before?.revision ?? 0 }
        let afterState: Record<string, unknown>
        if (change.kind === 'SET_SURFACE') {
          const field = surfaceField!
          action = `operator.venue-distribution.${change.surface.toLowerCase()}.${change.enabled ? 'enabled' : 'disabled'}`
          beforeState = { ...beforeState, state: before?.[field] ?? 'DISABLED' }
          afterState = { state: bumped[field], revision: bumped.revision, reason }
        } else if (change.kind === 'ADD_ORIGIN') {
          const existing = await tx.venueWebsiteOrigin.findFirst({
            where: { tenantId: input.tenantId, venueId: input.venueId, origin: origin!, state: 'ACTIVE' },
            select: { id: true },
          })
          if (existing)
            throw new VenueDistributionActionError('CONFLICT', 'This origin is already active.')
          const active = await tx.venueWebsiteOrigin.count({
            where: { tenantId: input.tenantId, venueId: input.venueId, state: 'ACTIVE' },
          })
          if (active >= MAX_ACTIVE_ORIGINS)
            throw new VenueDistributionActionError(
              'INVALID_INPUT',
              `A venue can have at most ${MAX_ACTIVE_ORIGINS} active origins.`,
            )
          const created = await tx.venueWebsiteOrigin.create({
            data: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              origin: origin!,
              addedBy: input.actor.id,
              addedReason: reason,
            },
            select: { id: true },
          })
          action = 'operator.venue-distribution.origin.added'
          targetType = 'VenueWebsiteOrigin'
          targetId = created.id
          afterState = { origin, reason, revision: bumped.revision }
        } else {
          const active = await tx.venueWebsiteOrigin.findFirst({
            where: { tenantId: input.tenantId, venueId: input.venueId, origin: origin!, state: 'ACTIVE' },
            select: { id: true },
          })
          if (!active)
            throw new VenueDistributionActionError('NOT_FOUND', 'No active origin matches.')
          const changed = await tx.venueWebsiteOrigin.updateMany({
            where: { id: active.id, tenantId: input.tenantId, venueId: input.venueId, state: 'ACTIVE' },
            data: { state: 'REVOKED', revokedAt: new Date(), revokedBy: input.actor.id, revokedReason: reason },
          })
          if (changed.count !== 1)
            throw new VenueDistributionActionError('CONFLICT', 'Origin changed; read it again.')
          action = 'operator.venue-distribution.origin.revoked'
          targetType = 'VenueWebsiteOrigin'
          targetId = active.id
          beforeState = { origin, state: 'ACTIVE' }
          afterState = { origin, state: 'REVOKED', reason, revision: bumped.revision }
        }
        await writeAuditLogStrict(
          {
            tenantId: input.tenantId,
            actorId: input.actor.id,
            actorRole: input.actor.role,
            action,
            targetType,
            targetId,
            beforeState,
            afterState,
          },
          tx,
        )
        return { revision: bumped.revision, websiteState: bumped.websiteState, appState: bumped.appState }
      },
      { isolationLevel: 'Serializable' },
    )
  } catch (error) {
    if (error instanceof VenueDistributionActionError) throw error
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
    if (code === 'P2034' || code === 'P2002')
      throw new VenueDistributionActionError('CONFLICT', 'Distribution changed; read it again.')
    throw error
  }
}
