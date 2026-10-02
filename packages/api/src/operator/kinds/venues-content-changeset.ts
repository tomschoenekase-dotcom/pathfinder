import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import {
  applyChangeset,
  changesetProblems,
  ChangesetRefusal,
  currentChangesetVersion,
  describeChangeset,
  expectedChangesetVersion,
  pendingChangesetChanges,
  resolveChangeset,
} from '../content-changeset'
import { assertVenueInGrant } from '../grants'
import {
  OperatorStaleError,
  type OperatorApplyContext,
  type OperatorKindContext,
  type OperatorProposalKind,
} from '../proposals'

const input = OPERATOR_MCP_INPUTS['venues.propose_content_changeset']
type ChangesetArgs = ReturnType<typeof input.parse>

/**
 * Corrections that retire or update the row they correct. The checks run when the changeset is
 * proposed (a stale or invalid one is refused and creates nothing) and again when it is applied,
 * where each canonical content action re-checks its expected revision under its own lock.
 */
export const venuesContentChangesetKind: OperatorProposalKind<ChangesetArgs> = {
  kind: 'venues.content-changeset',
  tool: 'venues.propose_content_changeset',
  capability: 'venues:propose',
  parse: (raw) => input.parse(raw),
  target: (args) => ({ tenantId: args.tenantId, venueId: args.venueId }),
  authorize: async (args, context: OperatorKindContext) => {
    await assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
    const resolved = await resolveChangeset(context.database, args, context.now)
    const problems = changesetProblems(resolved)
    if (problems.length === 0) return
    const message = problems.join(' | ').slice(0, 1_500)
    if (resolved.ops.some((op) => op.stale)) throw new OperatorStaleError(message)
    throw new ChangesetRefusal('CHANGESET_INVALID', message)
  },
  targetVersion: async (args) => expectedChangesetVersion(args.ops),
  currentVersion: async (args, context) =>
    currentChangesetVersion(context.database, args, context.now),
  describe: (args) => ({
    title: `Change venue content (${args.ops.length} ${args.ops.length === 1 ? 'operation' : 'operations'})`,
    lines: [
      ...describeChangeset(args.ops),
      'Each operation applies only if its expected revision is still current; otherwise nothing applies.',
      'Corrections update or retire the row they name. No audience changes and nothing is published.',
    ],
  }),
  pendingChanges: (args, database) => pendingChangesetChanges(database, args, new Date()),
  snapshot: async (args, context) => {
    const resolved = await resolveChangeset(context.database, args, context.now)
    return {
      venueId: args.venueId,
      targets: resolved.ops.map((op) => ({
        index: op.index,
        representation: op.representation,
        id: op.targetId,
        revision: op.currentRevision,
      })),
    } as unknown as JsonValue
  },
  apply: async (args, context: OperatorApplyContext) => applyChangeset(args, context),
}
