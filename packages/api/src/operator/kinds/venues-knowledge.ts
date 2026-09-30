import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { bulkCreateLegacyKnowledgeAction } from '@pathfinder/db'

import type { OperatorDatabase } from '../audit'
import { assertVenueInGrant } from '../grants'
import type { OperatorApplyContext, OperatorKindContext, OperatorProposalKind } from '../proposals'

const input = OPERATOR_MCP_INPUTS['venues.propose_knowledge']
type KnowledgeArgs = ReturnType<typeof input.parse>

const DEFAULT_CATEGORY = 'General'

/**
 * Additions never conflict with each other, so the version is only the number of entries that
 * already carry one of the proposed titles: a duplicate added meanwhile makes the proposal stale.
 */
async function matchingTitles(database: OperatorDatabase, args: KnowledgeArgs) {
  return database.venueKnowledgeEntry.count({
    where: {
      tenantId: args.tenantId,
      venueId: args.venueId,
      title: { in: args.entries.map((entry) => entry.title) },
    },
  })
}

export const venuesKnowledgeKind: OperatorProposalKind<KnowledgeArgs> = {
  kind: 'venues.knowledge',
  tool: 'venues.propose_knowledge',
  capability: 'venues:propose',
  parse: (raw) => input.parse(raw),
  target: (args) => ({ tenantId: args.tenantId, venueId: args.venueId }),
  authorize: (args, context: OperatorKindContext) =>
    assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database),
  targetVersion: async (args, context) => String(await matchingTitles(context.database, args)),
  currentVersion: async (args, context) => String(await matchingTitles(context.database, args)),
  describe: (args) => ({
    title: `Add ${args.entries.length} knowledge ${args.entries.length === 1 ? 'entry' : 'entries'}`,
    lines: args.entries.map((entry) => `${entry.category ?? DEFAULT_CATEGORY}: ${entry.title}`),
  }),
  snapshot: async (args, context) =>
    ({
      venueId: args.venueId,
      existingWithSameTitles: await matchingTitles(context.database, args),
    }) as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    const entries = await bulkCreateLegacyKnowledgeAction(
      {
        tenantId: args.tenantId,
        venueId: args.venueId,
        actor: context.actor,
        entries: args.entries.map((entry) => ({
          title: entry.title,
          category: entry.category ?? DEFAULT_CATEGORY,
          content: entry.body,
          isEnabled: true,
        })),
      },
      context.database,
    )
    return {
      result: { venueId: args.venueId, count: entries.length, entryIds: entries.map((e) => e.id) },
      after: {
        venueId: args.venueId,
        entries: entries.map((entry) => ({
          id: entry.id,
          title: entry.title,
          updatedAt: entry.updatedAt.toISOString(),
        })),
      },
    }
  },
}
