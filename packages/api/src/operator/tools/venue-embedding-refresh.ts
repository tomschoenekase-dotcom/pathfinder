import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { getVenueEmbeddingRefresh, planVenueEmbeddingRefresh } from '@pathfinder/db'

import { assertVenueInGrant, OperatorNotFoundError } from '../grants'
import type { OperatorReadTool } from '../registry'

export const venueEmbeddingRefreshReadTools: readonly OperatorReadTool[] = [
  {
    name: 'venues.plan_embedding_refresh',
    capability: 'venues:read',
    async handler(raw, context) {
      const args = OPERATOR_MCP_INPUTS['venues.plan_embedding_refresh'].parse(raw)
      await assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
      const plan = await planVenueEmbeddingRefresh(args, context.database)
      const dispatcherDisabled = process.env.EMBEDDING_DISPATCH_ENABLED === 'false'
      return {
        venueId: args.venueId,
        planDigest: plan.planDigest,
        candidateCount: plan.candidateCount,
        scanned: plan.beforeAudit.scanned,
        blockedCount: plan.blockedCount,
        truncated: plan.truncated,
        eligible: plan.eligible && dispatcherDisabled,
        maxRecords: 1000,
        dispatcherDisabled,
        next:
          !plan.eligible || !dispatcherDisabled
            ? 'Refresh is blocked. Resolve the audit or venue eligibility issue; do not publish a draft or change global worker flags to bypass it.'
            : plan.candidateCount === 0
              ? 'No stale records were found. Re-run venues.check_package; freshness is separate from factual correctness.'
              : 'Call venues.propose_embedding_refresh with this planDigest, a new operationId and max at least candidateCount (at most 1000). Existing AI budgets apply; the record cap is not a dollar cap. Read the returned refreshId until its final audit proves freshness.',
      }
    },
  },
  {
    name: 'venues.get_embedding_refresh',
    capability: 'venues:read',
    async handler(raw, context) {
      const args = OPERATOR_MCP_INPUTS['venues.get_embedding_refresh'].parse(raw)
      await assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
      const receipt = await getVenueEmbeddingRefresh(args, context.database)
      if (!receipt) throw new OperatorNotFoundError()
      return {
        refreshId: receipt.id,
        venueId: receipt.venueId,
        status: receipt.status,
        freshnessProven: receipt.freshnessProven,
        maxRecords: receipt.maxRecords,
        stopCode: receipt.stopCode,
        records: receipt.records.map((record) => ({
          recordId: record.id,
          ordinal: record.ordinal,
          entityType: record.entityType,
          entityId: record.entityId,
          contentUpdatedAt: record.contentUpdatedAt.toISOString(),
          status: record.status,
          outcome: record.outcome,
        })),
        afterAudit: receipt.afterAudit
          ? {
              scanned: receipt.afterAudit.scanned,
              candidateCount: receipt.afterAudit.candidateCount,
              blockedCount: receipt.afterAudit.blockedCount,
              truncated: receipt.afterAudit.truncated,
            }
          : null,
        next: receipt.freshnessProven
          ? 'The final audit proved freshness at completion. Run venues.check_package again before importing; later content changes can make embeddings stale.'
          : receipt.status === 'QUEUED'
            ? 'Request accepted; freshness is not proven. Read this receipt again. If delivery stays unconfirmed, retain the original operationId for operator review.'
            : receipt.status === 'RUNNING' || receipt.status === 'OUTCOME_UNKNOWN'
              ? 'Freshness is not proven. If interrupted, this operation is held and will not restart automatically. Keep its receipts for operator review; never create another request to bypass the hold.'
              : 'Refresh stopped without automatic retries. Review per-record receipts and the final audit. Do not repeat attempted work blindly; only a settled operation permits a newly reviewed plan.',
      }
    },
  },
]
