import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { parseChatAppearance } from '@pathfinder/contracts/chat-appearance'
import {
  GuestActionCatalog,
  readStoredGuestActions,
} from '@pathfinder/contracts/guest-action-links'
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
 * Replaces a venue's approved guest actions and/or its two presentation switches through the same
 * audited chat design action the dashboard uses. Unlike appearance.update this changes links that
 * guests follow, so it is not a routine automatic kind and opts out of job grants.
 */
const input = OPERATOR_MCP_INPUTS['appearance.propose_guest_actions']
type GuestActionsArgs = ReturnType<typeof input.parse>

type GuestActionsSnapshot = {
  venueId: string
  actionLinks: boolean
  actionButtons: boolean
  guestActions: JsonValue
  updatedAt: string
}

async function readGuestActions(
  database: OperatorDatabase,
  tenantId: string,
  venueId: string,
): Promise<GuestActionsSnapshot | null> {
  const venue = await database.venue.findFirst({
    where: { id: venueId, tenantId },
    select: venueChatDesignSelect,
  })
  if (!venue) return null
  const appearance = parseChatAppearance(venue.chatAppearance)
  return {
    venueId,
    actionLinks: appearance.actionLinks ?? false,
    actionButtons: appearance.actionButtons ?? false,
    guestActions: readStoredGuestActions(venue.chatAppearance) as JsonValue,
    updatedAt: venue.updatedAt.toISOString(),
  }
}

async function applyGuestActions(
  context: OperatorApplyContext,
  tenantId: string,
  venueId: string,
  expectedUpdatedAt: string,
  change: {
    guestActions?: GuestActionCatalog
    actionLinks?: boolean
    actionButtons?: boolean
  },
) {
  const current = await context.database.venue.findFirst({
    where: { id: venueId, tenantId },
    select: { chatAppearance: true },
  })
  if (!current) throw new OperatorStaleError('The venue is no longer available.')
  const switches = change.actionLinks !== undefined || change.actionButtons !== undefined
  const saved = await updateVenueChatDesignAction(
    {
      tenantId,
      venueId,
      expectedUpdatedAt: new Date(expectedUpdatedAt),
      actor: context.actor,
      fields: {
        ...(switches
          ? {
              chatAppearance: {
                ...parseChatAppearance(current.chatAppearance),
                ...(change.actionLinks !== undefined ? { actionLinks: change.actionLinks } : {}),
                ...(change.actionButtons !== undefined
                  ? { actionButtons: change.actionButtons }
                  : {}),
              },
            }
          : {}),
        ...(change.guestActions !== undefined ? { guestActions: change.guestActions } : {}),
      },
    },
    context.database,
  )
  const after = await readGuestActions(context.database, tenantId, venueId)
  return {
    result: { venueId, updatedAt: saved.updatedAt.toISOString() },
    after: after as unknown as JsonValue,
  }
}

function change(args: GuestActionsArgs) {
  return {
    ...(args.guestActions !== undefined ? { guestActions: args.guestActions } : {}),
    ...(args.actionLinks !== undefined ? { actionLinks: args.actionLinks } : {}),
    ...(args.actionButtons !== undefined ? { actionButtons: args.actionButtons } : {}),
  }
}

export const appearanceGuestActionsKind: OperatorProposalKind<GuestActionsArgs> = {
  kind: 'appearance.guest-actions',
  tool: 'appearance.propose_guest_actions',
  capability: 'appearance:propose',
  parse: (raw) => input.parse(raw),
  target: (args) => ({ tenantId: args.tenantId, venueId: args.venueId }),
  authorize: (args, context: OperatorKindContext) =>
    assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database),
  targetVersion: async (args) =>
    args.expectedUpdatedAt ? new Date(args.expectedUpdatedAt).toISOString() : null,
  currentVersion: async (args, context) =>
    (await readGuestActions(context.database, args.tenantId, args.venueId))?.updatedAt ?? null,
  describe: (args) => ({
    title: 'Update official guest actions',
    lines: [
      ...(args.actionLinks !== undefined
        ? [`Links inside answers → ${args.actionLinks ? 'on' : 'off'}`]
        : []),
      ...(args.actionButtons !== undefined
        ? [`Action button → ${args.actionButtons ? 'on' : 'off'}`]
        : []),
      ...(args.guestActions !== undefined
        ? args.guestActions.length
          ? args.guestActions.map(
              (action) =>
                `${action.enabled ? '' : '(off) '}${action.label} [${action.id}] → ${action.url}`,
            )
          : ['Remove every guest action']
        : []),
    ],
  }),
  snapshot: async (args, context) =>
    (await readGuestActions(context.database, args.tenantId, args.venueId)) as unknown as JsonValue,
  apply: async (args, context) => {
    // Without an expected version the change applies to the venue as it is now.
    const expected =
      args.expectedUpdatedAt ??
      (await readGuestActions(context.database, args.tenantId, args.venueId))?.updatedAt
    if (!expected) throw new OperatorStaleError('The venue is no longer available.')
    return applyGuestActions(context, args.tenantId, args.venueId, expected, change(args))
  },
  revert: async (original: StoredOperatorProposal, context) => {
    const before = original.beforeSnapshot as GuestActionsSnapshot | null
    const after = original.afterSnapshot as GuestActionsSnapshot | null
    if (!before || !after || !original.targetTenantId || !original.targetVenueId) {
      throw new OperatorStaleError('The original snapshot is incomplete.')
    }
    return applyGuestActions(
      context,
      original.targetTenantId,
      original.targetVenueId,
      after.updatedAt,
      {
        guestActions: GuestActionCatalog.parse(before.guestActions),
        actionLinks: before.actionLinks,
        actionButtons: before.actionButtons,
      },
    )
  },
}
