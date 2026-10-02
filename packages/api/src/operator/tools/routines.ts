import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import { operatorUntrustedText } from '../crm-projection'
import { assertTenantInGrant, assertVenueInGrant } from '../grants'
import type { OperatorReadTool } from '../registry'
import { decodeKeysetCursor, encodeKeysetCursor, pageResult, requireCursorInScope } from './page'

const routinesList: OperatorReadTool = {
  name: 'routines.list',
  capability: 'routines:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['routines.list'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    if (input.venueId)
      await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
    const base = { tenantId: input.tenantId, ...(input.venueId ? { venueId: input.venueId } : {}) }
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    await requireCursorInScope(after?.id, (id) =>
      context.database.agentRoutine.findFirst({
        where: { ...base, id, createdAt: after!.at },
        select: { id: true },
      }),
    )
    const rows = await context.database.agentRoutine.findMany({
      where: {
        ...base,
        ...(after
          ? { OR: [{ createdAt: { lt: after.at } }, { createdAt: after.at, id: { lt: after.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: {
        id: true,
        venueId: true,
        routineKey: true,
        requestedOperation: true,
        intervalSeconds: true,
        maxAttempts: true,
        maxRunsPerDay: true,
        requiredWorkerRoles: true,
        requiredWorkerCapabilities: true,
        enabled: true,
        nextRunAt: true,
        lastRunAt: true,
        lastSkipReason: true,
        createdAt: true,
        updatedAt: true,
        agentIdentity: { select: { id: true, name: true, enabled: true } },
        dispatches: {
          where: { tenantId: input.tenantId },
          orderBy: [{ scheduledFor: 'desc' }, { id: 'desc' }],
          take: 1,
          select: { agentRunId: true, scheduledFor: true, agentRun: { select: { status: true } } },
        },
      },
    })
    const page = rows.slice(0, input.limit)
    return pageResult(
      page.map((row) => ({
        routineId: row.id,
        venueId: row.venueId,
        routineKey: operatorUntrustedText(row.routineKey),
        requestedOperation: operatorUntrustedText(row.requestedOperation),
        intervalSeconds: row.intervalSeconds,
        maxAttempts: row.maxAttempts,
        maxRunsPerDay: row.maxRunsPerDay,
        requiredWorkerRoles: row.requiredWorkerRoles.map((value) => operatorUntrustedText(value)),
        requiredWorkerCapabilities: row.requiredWorkerCapabilities.map((value) =>
          operatorUntrustedText(value),
        ),
        enabled: row.enabled,
        nextRunAt: row.nextRunAt?.toISOString() ?? null,
        lastRunAt: row.lastRunAt?.toISOString() ?? null,
        lastSkipReason: row.lastSkipReason ? operatorUntrustedText(row.lastSkipReason) : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        agentIdentity: {
          identityId: row.agentIdentity.id,
          name: operatorUntrustedText(row.agentIdentity.name),
          enabled: row.agentIdentity.enabled,
        },
        latestDispatch: row.dispatches[0]
          ? {
              runId: row.dispatches[0].agentRunId,
              scheduledFor: row.dispatches[0].scheduledFor.toISOString(),
              runStatus: row.dispatches[0].agentRun.status,
            }
          : null,
      })),
      rows.length > input.limit
        ? encodeKeysetCursor(page.at(-1)!.createdAt, page.at(-1)!.id)
        : null,
    )
  },
}

export const routineReadTools: readonly OperatorReadTool[] = [routinesList]
