import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  applyVenueDistributionChangeAction,
  normalizeVenueWebsiteOrigin,
  readVenueDistributionState,
  VenueDistributionActionError,
} from '@pathfinder/db'

import { assertVenueInGrant, OperatorNotFoundError } from '../grants'
import { OperatorStaleError, type OperatorKindContext, type OperatorProposalKind } from '../proposals'
import { operatorReason } from './shared'

const schema = OPERATOR_MCP_INPUTS['venues.propose_distribution_change']
type Args = ReturnType<typeof schema.parse>
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonValue

/**
 * Visitor distribution (website/app embedding and allowed origins) through the canonical
 * revision-bound action. Like the dashboard's Visitor access screen, only an allowlisted
 * platform administrator may change it; an origin is an access boundary, not content.
 */
export const venueDistributionChangeKind: OperatorProposalKind<Args> = {
  kind: 'venues.distribution-change',
  tool: 'venues.propose_distribution_change',
  capability: 'venues:propose',
  parse(raw) {
    const args = schema.parse(raw)
    if (args.change.kind !== 'SET_SURFACE' && normalizeVenueWebsiteOrigin(args.change.origin) !== args.change.origin)
      throw new Error('Use an exact normalized HTTPS origin such as https://www.example.org')
    return args
  },
  target: (args) => ({ tenantId: args.tenantId, venueId: args.venueId }),
  async authorize(args, context: OperatorKindContext) {
    if (!context.allowedUserIds?.has(context.grant.userId)) throw new OperatorNotFoundError()
    await assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
  },
  targetVersion: async (args) => String(args.expectedRevision),
  currentVersion: async (args, context) =>
    String((await readVenueDistributionState(context.database, args.tenantId, args.venueId)).revision),
  snapshot: async (args, context) =>
    json(await readVenueDistributionState(context.database, args.tenantId, args.venueId)),
  describe: (args) => ({
    title: 'Change visitor distribution',
    lines: [
      args.change.kind === 'SET_SURFACE'
        ? `${args.change.surface === 'WEBSITE' ? 'Website embedding' : 'App embedding'} → ${args.change.enabled ? 'enabled' : 'disabled'}`
        : `${args.change.kind === 'ADD_ORIGIN' ? 'Allow' : 'Revoke'} website origin ${args.change.origin}`,
      `At distribution revision ${args.expectedRevision}. Reason: ${args.reason}`,
    ],
  }),
  async apply(args, context) {
    try {
      const after = await applyVenueDistributionChangeAction(
        {
          tenantId: args.tenantId,
          venueId: args.venueId,
          expectedRevision: args.expectedRevision,
          change: args.change,
          reason: `${args.reason} ${operatorReason(context.proposalId)}`.slice(0, 500),
          actor: { type: 'HUMAN', id: context.actor.id, role: 'PLATFORM_ADMIN' },
        },
        context.database,
      )
      const state = await readVenueDistributionState(context.database, args.tenantId, args.venueId)
      return { result: { venueId: args.venueId, revision: after.revision, websiteState: after.websiteState, appState: after.appState }, after: json(state) }
    } catch (error) {
      if (error instanceof VenueDistributionActionError && error.code === 'CONFLICT')
        throw new OperatorStaleError(error.message)
      if (error instanceof VenueDistributionActionError && error.code === 'NOT_FOUND')
        throw new OperatorNotFoundError()
      throw error
    }
  },
}
