import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { createVenueAction, normalizeVenueSlug, setVenueAvailabilityAction } from '@pathfinder/db'

import type { OperatorDatabase } from '../audit'
import { OperatorNotFoundError } from '../grants'
import {
  OperatorStaleError,
  type OperatorApplyContext,
  type OperatorProposalKind,
  type StoredOperatorProposal,
} from '../proposals'
import { operatorReason, venueActor } from './shared'

const input = OPERATOR_MCP_INPUTS['venues.propose_create']
type CreateArgs = ReturnType<typeof input.parse>

type VenueState = { venueId: string; slug: string; isActive: boolean; updatedAt: string }

async function slugTaken(database: OperatorDatabase, tenantId: string, slug: string) {
  const existing = await database.venue.findFirst({
    where: { tenantId, slug },
    select: { id: true },
  })
  return existing !== null
}

/** With a caller-chosen slug the version is whether it is free; without one nothing can collide. */
async function slugVersion(database: OperatorDatabase, args: CreateArgs) {
  if (args.slug === undefined) return null
  return (await slugTaken(database, args.tenantId, args.slug)) ? 'taken' : 'free'
}

async function readVenue(
  database: OperatorDatabase,
  tenantId: string,
  venueId: string,
): Promise<VenueState | null> {
  const venue = await database.venue.findFirst({
    where: { id: venueId, tenantId },
    select: { id: true, slug: true, isActive: true, updatedAt: true },
  })
  return venue
    ? {
        venueId: venue.id,
        slug: venue.slug,
        isActive: venue.isActive,
        updatedAt: venue.updatedAt.toISOString(),
      }
    : null
}

/**
 * Creates a draft venue through the canonical create action, inactive from the first commit, so
 * nothing is offered to visitors until a separate publish proposal is approved.
 * City and region have no column of their own; they become the guide notes.
 */
export const venuesCreateKind: OperatorProposalKind<CreateArgs> = {
  kind: 'venues.create',
  tool: 'venues.propose_create',
  capability: 'venues:propose',
  parse: (raw) => input.parse(raw),
  target: (args) => ({ tenantId: args.tenantId }),
  targetVersion: async (args, context) => slugVersion(context.database, args),
  currentVersion: async (args, context) => slugVersion(context.database, args),
  describe: (args) => ({
    title: 'Create a draft venue (not available to visitors until published)',
    lines: [
      `name: ${args.name}`,
      ...(args.slug ? [`slug: ${args.slug}`] : []),
      ...(args.city || args.region
        ? [`location: ${[args.city, args.region].filter(Boolean).join(', ')}`]
        : []),
    ],
  }),
  snapshot: async (args, context) =>
    ({
      tenantId: args.tenantId,
      slugTaken:
        args.slug === undefined
          ? null
          : await slugTaken(context.database, args.tenantId, args.slug),
    }) as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    const place = [args.city, args.region].filter(Boolean).join(', ')
    // The venue is created inactive in the same transaction, so no moment exists in which a draft
    // is live. The operation id is the replay receipt: a retry returns the venue this operation
    // created, and a venue that merely shares the slug is refused, never adopted or changed.
    const created = await createVenueAction(
      {
        tenantId: args.tenantId,
        actor: venueActor(context.actor, 'OWNER'),
        name: args.name,
        baseSlug: args.slug ?? normalizeVenueSlug(args.name),
        callerSuppliedSlug: args.slug !== undefined,
        guideMode: 'non_location',
        initiallyActive: false,
        operationKey: context.operationId,
        ...(place ? { guideNotes: `Located in ${place}.` } : {}),
      },
      context.database,
    )
    const venueId = created.record.id
    const after = (await readVenue(context.database, args.tenantId, venueId))!
    // A first creation must end inactive. A replay reports the venue as it is now: if a person
    // has since published it, that is their decision and this retry must not undo it.
    if (after.isActive && !created.replayed) {
      throw Object.assign(new Error('The new venue could not be set to draft.'), {
        code: 'DRAFT_NOT_SET',
      })
    }
    return {
      result: {
        venueId,
        slug: after.slug,
        updatedAt: after.updatedAt,
        isActive: after.isActive,
        draft: !after.isActive,
        replayed: created.replayed,
      },
      after: after as unknown as JsonValue,
    }
  },
  /**
   * The create is one transaction that also writes an audit row carrying this operation's key, so
   * the presence of that row proves the venue exists and its absence proves nothing was created.
   */
  reconcile: async (args, context) => {
    const receipt = await context.database.auditLog.findFirst({
      where: {
        tenantId: args.tenantId,
        actorType: 'HUMAN',
        idempotencyKey: context.operationId,
        action: 'venue.created',
      },
      select: { targetId: true },
    })
    if (!receipt) return { state: 'not_applied' }
    const after = await readVenue(context.database, args.tenantId, receipt.targetId)
    if (!after) return { state: 'unknown' }
    return {
      state: 'applied',
      outcome: {
        result: {
          venueId: after.venueId,
          slug: after.slug,
          updatedAt: after.updatedAt,
          isActive: after.isActive,
          draft: !after.isActive,
          replayed: false,
        },
        after: after as unknown as JsonValue,
      },
    }
  },
  /** Archives the created venue by switching its availability off (nothing is deleted). */
  revert: async (original: StoredOperatorProposal, context: OperatorApplyContext) => {
    const after = original.afterSnapshot as VenueState | null
    if (!after?.venueId || !original.targetTenantId) {
      throw new OperatorStaleError('The original snapshot is incomplete.')
    }
    const current = await readVenue(context.database, original.targetTenantId, after.venueId)
    if (!current) throw new OperatorNotFoundError()
    if (current.updatedAt !== after.updatedAt) {
      throw new OperatorStaleError('The venue changed after it was created.')
    }
    if (current.isActive) {
      await setVenueAvailabilityAction(
        {
          tenantId: original.targetTenantId,
          venueId: after.venueId,
          expectedUpdatedAt: new Date(after.updatedAt),
          enabled: false,
          reason: `Archived. ${operatorReason(original.id)}`,
          actor: venueActor(context.actor, 'MANAGER'),
        },
        context.database,
      )
    }
    const now = (await readVenue(context.database, original.targetTenantId, after.venueId))!
    return {
      result: { venueId: now.venueId, isActive: now.isActive, updatedAt: now.updatedAt },
      after: now as unknown as JsonValue,
    }
  },
}
