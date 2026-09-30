import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { setVenueAvailabilityAction } from '@pathfinder/db'

import type { OperatorDatabase } from '../audit'
import { assertVenueInGrant, OperatorNotFoundError } from '../grants'
import {
  OperatorStaleError,
  type OperatorApplyContext,
  type OperatorKindContext,
  type OperatorProposalKind,
  type StoredOperatorProposal,
} from '../proposals'
import { operatorReason, venueActor } from './shared'

const input = OPERATOR_MCP_INPUTS['venues.propose_publish']
type PublishArgs = ReturnType<typeof input.parse>

type AvailabilitySnapshot = { venueId: string; isActive: boolean; updatedAt: string }

async function readAvailability(
  database: OperatorDatabase,
  tenantId: string,
  venueId: string,
): Promise<AvailabilitySnapshot | null> {
  const venue = await database.venue.findFirst({
    where: { id: venueId, tenantId },
    select: { id: true, isActive: true, updatedAt: true },
  })
  return venue
    ? { venueId: venue.id, isActive: venue.isActive, updatedAt: venue.updatedAt.toISOString() }
    : null
}

/**
 * Publishing makes the venue available to visitors through the canonical availability action. The
 * website and app distribution surfaces are separate and have no domain action, so they stay as
 * they are; a human enables them in Visitor access.
 */
export const venuesPublishKind: OperatorProposalKind<PublishArgs> = {
  kind: 'venues.publish',
  tool: 'venues.propose_publish',
  capability: 'venues:propose',
  parse: (raw) => input.parse(raw),
  target: (args) => ({ tenantId: args.tenantId, venueId: args.venueId }),
  authorize: (args, context: OperatorKindContext) =>
    assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database),
  targetVersion: async (args) => new Date(args.expectedUpdatedAt).toISOString(),
  currentVersion: async (args, context) =>
    (await readAvailability(context.database, args.tenantId, args.venueId))?.updatedAt ?? null,
  describe: () => ({
    title: 'Make the venue available to visitors',
    lines: ['isActive → true'],
  }),
  snapshot: async (args, context) =>
    (await readAvailability(context.database, args.tenantId, args.venueId)) as unknown as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    await setVenueAvailabilityAction(
      {
        tenantId: args.tenantId,
        venueId: args.venueId,
        expectedUpdatedAt: new Date(args.expectedUpdatedAt),
        enabled: true,
        reason: `Published. ${operatorReason(context.proposalId)}`,
        actor: venueActor(context.actor, 'MANAGER'),
      },
      context.database,
    )
    const after = (await readAvailability(context.database, args.tenantId, args.venueId))!
    return {
      result: { venueId: args.venueId, isActive: after.isActive, updatedAt: after.updatedAt },
      after: after as unknown as JsonValue,
    }
  },
  /** Restores the availability the venue had before publishing. */
  revert: async (original: StoredOperatorProposal, context: OperatorApplyContext) => {
    const before = original.beforeSnapshot as AvailabilitySnapshot | null
    const after = original.afterSnapshot as AvailabilitySnapshot | null
    if (!before || !after || !original.targetTenantId) {
      throw new OperatorStaleError('The original snapshot is incomplete.')
    }
    await setVenueAvailabilityAction(
      {
        tenantId: original.targetTenantId,
        venueId: after.venueId,
        expectedUpdatedAt: new Date(after.updatedAt),
        enabled: before.isActive,
        reason: `Unpublished. ${operatorReason(original.id)}`,
        actor: venueActor(context.actor, 'MANAGER'),
      },
      context.database,
    )
    const now = await readAvailability(context.database, original.targetTenantId, after.venueId)
    if (!now) throw new OperatorNotFoundError()
    return {
      result: { venueId: now.venueId, isActive: now.isActive, updatedAt: now.updatedAt },
      after: now as unknown as JsonValue,
    }
  },
}
