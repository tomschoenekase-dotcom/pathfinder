import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { writeAuditLogStrict } from '@pathfinder/db'
import { enqueueGmailSync, GMAIL_SYNC_QUEUE } from '@pathfinder/jobs'

import { OperatorNotFoundError } from '../grants'
import type { OperatorReadTool } from '../registry'

function assertPlatformGrant(context: Parameters<OperatorReadTool['handler']>[1]) {
  if (!context.grant.allTenants || !context.config.allowedUserIds.has(context.grant.userId)) {
    throw new OperatorNotFoundError()
  }
}

export const mailReconciliationTools: readonly OperatorReadTool[] = [
  {
    name: 'crm.request_mail_reconciliation',
    capability: 'crm:propose',
    async handler(raw, context) {
      const input = OPERATOR_MCP_INPUTS['crm.request_mail_reconciliation'].parse(raw)
      assertPlatformGrant(context)
      const account = await context.database.correspondenceProviderAccount.findFirst({
        where: {
          id: input.providerAccountId,
          provider: 'GMAIL',
          connectionStatus: { in: ['CONNECTED', 'DEGRADED'] },
          credentialReferenceId: { not: null },
        },
        select: { id: true },
      })
      if (!account) throw new OperatorNotFoundError()
      await writeAuditLogStrict({
        actorType: 'AGENT',
        actorId: `operator-grant:${context.grant.grantId}`,
        actorRole: 'DELEGATED_OPERATOR',
        action: 'operator.gmail_reconciliation.requested',
        targetType: 'CorrespondenceProviderAccount',
        targetId: account.id,
        idempotencyKey: input.requestId,
        afterState: {
          trigger: 'SCHEDULED_RECONCILIATION',
          grantId: context.grant.grantId,
          requestId: context.requestId,
        },
      })
      const jobId = await enqueueGmailSync({
        providerAccountId: account.id,
        trigger: 'SCHEDULED_RECONCILIATION',
        requestId: input.requestId,
      })
      return { jobId, status: 'QUEUED' as const }
    },
  },
  {
    name: 'crm.get_mail_reconciliation',
    capability: 'crm:read',
    async handler(raw, context) {
      const input = OPERATOR_MCP_INPUTS['crm.get_mail_reconciliation'].parse(raw)
      assertPlatformGrant(context)
      const record = await context.database.jobRecord.findUnique({
        where: { queue_bullJobId: { queue: GMAIL_SYNC_QUEUE, bullJobId: input.jobId } },
        select: { status: true, payload: true, error: true, completedAt: true },
      })
      const details = record?.payload
      const result =
        details && typeof details === 'object' && !Array.isArray(details) ? details : {}
      if (record && result.providerAccountId !== input.providerAccountId) {
        throw new OperatorNotFoundError()
      }
      if (!record) {
        return {
          jobId: input.jobId,
          status: 'UNKNOWN',
          processed: null,
          complete: null,
          nextJobId: null,
          errorCode: null,
          completedAt: null,
        }
      }
      return {
        jobId: input.jobId,
        status: record.status,
        processed: typeof result.processed === 'number' ? result.processed : null,
        complete: typeof result.complete === 'boolean' ? result.complete : null,
        nextJobId: typeof result.nextJobId === 'string' ? result.nextJobId : null,
        errorCode: record.error,
        completedAt: record.completedAt?.toISOString() ?? null,
      }
    },
  },
]
