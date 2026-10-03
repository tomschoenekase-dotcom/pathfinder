import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { updateVenueChatDesignAction, venueChatDesignSelect } from '@pathfinder/db'

import type { OperatorDatabase } from '../audit'
import { assertVenueInGrant } from '../grants'
import {
  OperatorStaleError,
  type OperatorApplyContext,
  type OperatorKindContext,
  type OperatorProposalKind,
  type StoredOperatorProposal,
} from '../proposals'

/**
 * Reference proposal kind. Every other kind copies this shape: parse with the P2 contract, check
 * scope, bind a target version, snapshot, apply through the canonical domain action with the
 * approving human as actor, and undo by restoring the before snapshot.
 */
const input = OPERATOR_MCP_INPUTS['appearance.propose_update']
type AppearanceArgs = ReturnType<typeof input.parse>

type DesignSnapshot = {
  venueId: string
  chatTheme: string | null
  chatAccentColor: string | null
  chatFont: string | null
  chatAppearance: JsonValue
  updatedAt: string
}

async function readDesign(
  database: OperatorDatabase,
  tenantId: string,
  venueId: string,
): Promise<DesignSnapshot | null> {
  const venue = await database.venue.findFirst({
    where: { id: venueId, tenantId },
    select: venueChatDesignSelect,
  })
  if (!venue) return null
  return {
    venueId,
    chatTheme: venue.chatTheme,
    chatAccentColor: venue.chatAccentColor,
    chatFont: venue.chatFont,
    chatAppearance: (venue.chatAppearance ?? null) as JsonValue,
    updatedAt: venue.updatedAt.toISOString(),
  }
}

function fields(args: AppearanceArgs) {
  return {
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.chatTheme !== undefined ? { chatTheme: args.chatTheme } : {}),
    ...(args.chatAccentColor !== undefined ? { chatAccentColor: args.chatAccentColor } : {}),
    ...(args.chatFont !== undefined ? { chatFont: args.chatFont } : {}),
    ...(args.chatAppearance !== undefined ? { chatAppearance: args.chatAppearance } : {}),
  }
}

async function applyDesign(
  context: OperatorApplyContext,
  tenantId: string,
  venueId: string,
  expectedUpdatedAt: string,
  design: Parameters<typeof updateVenueChatDesignAction>[0]['fields'],
) {
  const saved = await updateVenueChatDesignAction(
    {
      tenantId,
      venueId,
      expectedUpdatedAt: new Date(expectedUpdatedAt),
      actor: context.actor,
      fields: design,
    },
    context.database,
  )
  const after = await readDesign(context.database, tenantId, venueId)
  return {
    result: { venueId, updatedAt: saved.updatedAt.toISOString() },
    after: after as unknown as JsonValue,
  }
}

export const appearanceUpdateKind: OperatorProposalKind<AppearanceArgs> = {
  kind: 'appearance.update',
  tool: 'appearance.propose_update',
  capability: 'appearance:propose',
  // The one kind that opts in to bounded job grants: a reversible, internal look-and-feel change
  // with no recipient, no cost and no external effect. Every kind that mails, invites or bills
  // stays non-grantable (and the always-ask kinds are refused by the grant service regardless).
  jobGrant: {},
  parse: (raw) => input.parse(raw),
  target: (args) => ({ tenantId: args.tenantId, venueId: args.venueId }),
  authorize: (args, context: OperatorKindContext) =>
    assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database),
  targetVersion: async (args) => new Date(args.expectedUpdatedAt).toISOString(),
  currentVersion: async (args, context) =>
    (await readDesign(context.database, args.tenantId, args.venueId))?.updatedAt ?? null,
  describe: (args) => ({
    title: 'Update visitor chat appearance',
    lines: Object.entries(fields(args)).map(
      ([field, value]) => `${field} → ${value === null ? 'cleared' : JSON.stringify(value)}`,
    ),
  }),
  snapshot: async (args, context) =>
    (await readDesign(context.database, args.tenantId, args.venueId)) as unknown as JsonValue,
  apply: (args, context) =>
    applyDesign(context, args.tenantId, args.venueId, args.expectedUpdatedAt, fields(args)),
  revert: async (original: StoredOperatorProposal, context) => {
    const before = original.beforeSnapshot as DesignSnapshot | null
    const after = original.afterSnapshot as DesignSnapshot | null
    if (!before || !after || !original.targetTenantId || !original.targetVenueId) {
      throw new OperatorStaleError('The original snapshot is incomplete.')
    }
    return applyDesign(context, original.targetTenantId, original.targetVenueId, after.updatedAt, {
      ...(before.chatTheme !== null ? { chatTheme: before.chatTheme as never } : {}),
      chatAccentColor: before.chatAccentColor,
      ...(before.chatFont !== null ? { chatFont: before.chatFont as never } : {}),
      chatAppearance: before.chatAppearance as never,
    })
  },
}
