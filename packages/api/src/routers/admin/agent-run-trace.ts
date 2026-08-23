import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { approvalState, tenantScopeInput } from './agent-operations-shared'

const traceKind = z.enum(['ACTION', 'EVENT', 'APPROVAL', 'OUTCOME'])
const traceCursor = z.object({
  createdAt: z.string().datetime(),
  kind: traceKind,
  id: z.string().min(1),
})
const input = tenantScopeInput.extend({
  agentRunId: z.string().min(1),
  cursor: traceCursor.optional(),
  limit: z.number().int().min(1).max(100).default(50),
})
type Kind = z.infer<typeof traceKind>
type Cursor = z.infer<typeof traceCursor>

function traceWhere(kind: Kind, cursor?: Cursor) {
  if (!cursor) return {}
  const createdAt = new Date(cursor.createdAt)
  const kindOrder = kind.localeCompare(cursor.kind)
  return {
    OR: [
      { createdAt: { lt: createdAt } },
      ...(kindOrder < 0
        ? [{ createdAt }]
        : kindOrder === 0
          ? [{ createdAt, id: { lt: cursor.id } }]
          : []),
    ],
  }
}

function compareTrace(
  left: { createdAt: Date; kind: Kind; id: string },
  right: { createdAt: Date; kind: Kind; id: string },
) {
  return (
    right.createdAt.getTime() - left.createdAt.getTime() ||
    right.kind.localeCompare(left.kind) ||
    right.id.localeCompare(left.id)
  )
}

export const adminAgentRunTraceRouter = router({
  listAgentRunTrace: adminProcedure.input(input).query(({ input: query }) =>
    withTenantIsolationBypass(async () => {
      const where = {
        tenantId: query.tenantId,
        agentRunId: query.agentRunId,
        ...(query.venueId ? { venueId: query.venueId } : {}),
      }
      const take = query.limit + 1
      const now = new Date()
      const [run, actions, events, approvals, outcomes] = await Promise.all([
        db.agentRun.findFirst({
          where: {
            id: query.agentRunId,
            tenantId: query.tenantId,
            ...(query.venueId ? { venueId: query.venueId } : {}),
          },
          select: { id: true },
        }),
        db.agentAction.findMany({
          where: { ...where, ...traceWhere('ACTION', query.cursor) },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          select: {
            id: true,
            createdAt: true,
            actorType: true,
            actorId: true,
            requestedOperation: true,
            actionName: true,
            inputSummary: true,
            modelProvider: true,
            modelName: true,
            costE8Usd: true,
            status: true,
            errorCode: true,
            beforeVersionRef: true,
            afterVersionRef: true,
            approvalDecisionId: true,
          },
        }),
        db.agentTimelineEvent.findMany({
          where: { ...where, ...traceWhere('EVENT', query.cursor) },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          select: {
            id: true,
            createdAt: true,
            actorType: true,
            actorId: true,
            agentActionId: true,
            eventType: true,
            message: true,
          },
        }),
        db.approvalRequest.findMany({
          where: { ...where, ...traceWhere('APPROVAL', query.cursor) },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          select: {
            id: true,
            createdAt: true,
            requestedByType: true,
            requestedById: true,
            proposedAction: true,
            reason: true,
            riskCategory: true,
            expiresAt: true,
            decision: {
              select: { id: true, decision: true, reason: true, createdAt: true },
            },
          },
        }),
        db.agentOutcomeObservation.findMany({
          where: { ...where, ...traceWhere('OUTCOME', query.cursor) },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          select: {
            id: true,
            createdAt: true,
            actorType: true,
            actorId: true,
            signalKind: true,
            verdict: true,
            summary: true,
            evidenceRef: true,
            taskClass: true,
            modelProvider: true,
            modelName: true,
          },
        }),
      ])
      if (!run) throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent run not found' })

      const items = [
        ...actions.map((action) => ({ kind: 'ACTION' as const, ...action })),
        ...events.map((event) => ({ kind: 'EVENT' as const, ...event })),
        ...approvals.map((approval) => ({
          kind: 'APPROVAL' as const,
          ...approval,
          state: approvalState(approval, now),
        })),
        ...outcomes.map((outcome) => ({ kind: 'OUTCOME' as const, ...outcome })),
      ].sort(compareTrace)
      const visible = items.slice(0, query.limit)
      const last = visible.at(-1)
      return {
        items: visible,
        nextCursor:
          items.length > query.limit && last
            ? { createdAt: last.createdAt.toISOString(), kind: last.kind, id: last.id }
            : null,
        bounded: true as const,
        excludes: [
          'RAW_ACTION_OUTPUT',
          'RAW_ACTION_INPUT_REFERENCE',
          'SCOPE_SNAPSHOT',
          'EXECUTION_LEASE',
        ] as const,
      }
    }),
  ),
})
