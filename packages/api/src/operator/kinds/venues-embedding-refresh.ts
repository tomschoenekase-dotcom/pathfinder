import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  findVenueEmbeddingRefreshByOperation,
  requestVenueEmbeddingRefresh,
  VenueEmbeddingRefreshError,
} from '@pathfinder/db'
import { enqueueVenueEmbeddingRefresh } from '@pathfinder/jobs'

import { assertVenueInGrant } from '../grants'
import type { OperatorApplyContext, OperatorProposalKind } from '../proposals'

const input = OPERATOR_MCP_INPUTS['venues.propose_embedding_refresh']
type Args = ReturnType<typeof input.parse>
type Receipt = NonNullable<Awaited<ReturnType<typeof findVenueEmbeddingRefreshByOperation>>>

function accepted(receipt: Receipt) {
  return {
    result: {
      refreshId: receipt.id,
      venueId: receipt.venueId,
      accepted: true,
      freshnessProven: false,
      summary:
        'The refresh request is recorded. Read venues.get_embedding_refresh with refreshId for execution receipts and the final freshness audit. APPLIED here means acceptance only.',
    },
    after: { refreshId: receipt.id, venueId: receipt.venueId },
  }
}

const find = (args: Args, context: OperatorApplyContext) =>
  findVenueEmbeddingRefreshByOperation(
    { tenantId: args.tenantId, venueId: args.venueId, operationKey: context.proposalId },
    context.database,
  )

export const venuesEmbeddingRefreshKind: OperatorProposalKind<Args> = {
  kind: 'venues.embedding-refresh',
  tool: 'venues.propose_embedding_refresh',
  capability: 'venues:propose',
  parse: (raw) => input.parse(raw),
  target: (args) => ({ tenantId: args.tenantId, venueId: args.venueId }),
  authorize: (args, context) =>
    assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database),
  targetVersion: async () => null,
  currentVersion: async () => null,
  describe: (args) => ({
    title: 'Refresh one venue’s stale embeddings',
    lines: [
      `At most ${args.max} records; one provider attempt per record, serial execution.`,
      `Exact reviewed plan: ${args.planDigest}`,
      'Stops on the first failure. The record cap is not a dollar cap; existing AI budgets apply.',
      'Acceptance is separate from completion. Global worker flags remain unchanged.',
    ],
  }),
  snapshot: async (args) => ({
    venueId: args.venueId,
    planDigest: args.planDigest,
    max: args.max,
  }),
  apply: async (args, context) => {
    // Recheck at the domain entry, even when called independently of the proposal registry.
    await assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
    if (process.env.EMBEDDING_DISPATCH_ENABLED !== 'false') {
      throw Object.assign(new Error('The dispatcher must remain explicitly disabled.'), {
        code: 'REFRESH_DISABLED',
        provedNoEffect: true,
        summary:
          'Refresh refused: EMBEDDING_DISPATCH_ENABLED must already be false. Do not change global flags to run this tool.',
      })
    }
    const receipt = await requestVenueEmbeddingRefresh(
      {
        tenantId: args.tenantId,
        venueId: args.venueId,
        operationKey: context.proposalId,
        planDigest: args.planDigest,
        max: args.max,
        requestedBy: context.actor.id,
      },
      context.database,
    ).catch((error: unknown) => {
      // These domain refusals precede creation or roll back its transaction.
      if (
        error instanceof VenueEmbeddingRefreshError &&
        [
          'INVALID_MAX',
          'NOT_FOUND',
          'INELIGIBLE',
          'AUDIT_BLOCKED',
          'PLAN_CHANGED',
          'MAX_EXCEEDED',
          'ACTIVE_REFRESH',
          'DISPATCHER_ENABLED',
        ].includes(error.code)
      ) {
        Object.assign(error, {
          provedNoEffect: true,
          summary: `Refresh refused (${error.code}); this request created no refresh and made no provider call. Review any earlier refresh receipts, then read a new plan. Do not change global flags or publish a draft to bypass a blocker.`,
        })
      }
      throw error
    })
    if (receipt.status === 'QUEUED') {
      try {
        await enqueueVenueEmbeddingRefresh({
          tenantId: args.tenantId,
          venueId: args.venueId,
          refreshId: receipt.id,
        })
      } catch {
        throw Object.assign(new Error('Refresh delivery is unconfirmed.'), {
          code: 'REFRESH_DELIVERY_UNKNOWN',
          summary:
            'The refresh request was recorded but queue delivery is unconfirmed. Keep the original operationId; inspect operator.get_operation and recover that operation. Never start another refresh to bypass this receipt.',
        })
      }
    }
    return accepted(receipt)
  },
  reconcile: async (args, context) => {
    await assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
    const receipt = await find(args, context)
    if (!receipt) return { state: 'not_applied' }
    // Safe delivery replay only; the immutable run CAS forbids replaying provider work.
    if (receipt.status === 'QUEUED') {
      await enqueueVenueEmbeddingRefresh({
        tenantId: args.tenantId,
        venueId: args.venueId,
        refreshId: receipt.id,
      })
    }
    return { state: 'applied', outcome: accepted(receipt) }
  },
  resolveUnknown: async (args, context) => {
    await assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
    const receipt = await find(args, context)
    // This resolver is read-only by contract. An uncertain queued delivery stays held.
    if (!receipt || receipt.status === 'QUEUED') {
      return {
        state: 'unknown',
        summary:
          'Queue delivery is not proven. Retain this operation and request receipt for operator review; do not start another refresh.',
      }
    }
    return { state: 'applied', outcome: accepted(receipt) }
  },
}
