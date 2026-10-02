import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import { operatorUntrustedText } from '../crm-projection'
import { assertTenantInGrant, OperatorNotFoundError } from '../grants'
import type { OperatorReadTool } from '../registry'
import { decodeKeysetCursor, encodeKeysetCursor, pageResult, requireCursorInScope } from './page'

const memberships: OperatorReadTool = {
  name: 'access.list_memberships',
  capability: 'access:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['access.list_memberships'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    const base = { tenantId: input.tenantId, ...(input.status ? { status: input.status } : {}) }
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    await requireCursorInScope(after?.id, (id) =>
      context.database.tenantMembership.findFirst({
        where: { ...base, id, updatedAt: after!.at },
        select: { id: true },
      }),
    )
    const rows = await context.database.tenantMembership.findMany({
      where: {
        ...base,
        ...(after
          ? { OR: [{ updatedAt: { lt: after.at } }, { updatedAt: after.at, id: { lt: after.id } }] }
          : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        joinedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    const page = rows.slice(0, input.limit)
    return pageResult(
      page.map((row) => ({
        membershipId: row.id,
        userId: row.userId,
        role: row.role,
        status: row.status,
        joinedAt: row.joinedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      rows.length > input.limit
        ? encodeKeysetCursor(page.at(-1)!.updatedAt, page.at(-1)!.id)
        : null,
    )
  },
}

const offboardingPlanList: OperatorReadTool = {
  name: 'offboarding.list_plans',
  capability: 'access:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['offboarding.list_plans'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    const base = { tenantId: input.tenantId, ...(input.status ? { status: input.status } : {}) }
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    await requireCursorInScope(after?.id, (id) =>
      context.database.offboardingPlan.findFirst({
        where: { ...base, id, requestedAt: after!.at },
        select: { id: true },
      }),
    )
    const rows = await context.database.offboardingPlan.findMany({
      where: {
        ...base,
        ...(after
          ? {
              OR: [
                { requestedAt: { lt: after.at } },
                { requestedAt: after.at, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: {
        id: true,
        status: true,
        revocationTargets: true,
        exportKinds: true,
        effectiveAt: true,
        requestedBy: true,
        requestedAt: true,
        updatedAt: true,
        _count: { select: { venueTargets: { where: { tenantId: input.tenantId } } } },
      },
    })
    const page = rows.slice(0, input.limit)
    return pageResult(
      page.map((row) => ({
        planId: row.id,
        status: row.status,
        revocationTargets: row.revocationTargets,
        exportKinds: row.exportKinds,
        effectiveAt: row.effectiveAt?.toISOString() ?? null,
        requestedBy: operatorUntrustedText(row.requestedBy),
        requestedAt: row.requestedAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        venueTargetCount: row._count.venueTargets,
      })),
      rows.length > input.limit
        ? encodeKeysetCursor(page.at(-1)!.requestedAt, page.at(-1)!.id)
        : null,
    )
  },
}

async function requirePlan(
  context: Parameters<OperatorReadTool['handler']>[1],
  tenantId: string,
  planId: string,
) {
  const plan = await context.database.offboardingPlan.findFirst({
    where: { id: planId, tenantId },
    select: { id: true },
  })
  if (!plan) throw new OperatorNotFoundError()
  return plan
}

const offboardingTargets: OperatorReadTool = {
  name: 'offboarding.list_targets',
  capability: 'access:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['offboarding.list_targets'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    await requirePlan(context, input.tenantId, input.planId)
    const base = { tenantId: input.tenantId, planId: input.planId }
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    await requireCursorInScope(after?.id, (id) =>
      context.database.offboardingVenueTarget.findFirst({
        where: { ...base, id, createdAt: after!.at },
        select: { id: true },
      }),
    )
    const rows = await context.database.offboardingVenueTarget.findMany({
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
        createdAt: true,
        _count: {
          select: {
            revocationEvidence: { where: { tenantId: input.tenantId } },
            exportArtifacts: { where: { tenantId: input.tenantId } },
          },
        },
      },
    })
    const page = rows.slice(0, input.limit)
    return pageResult(
      page.map((row) => ({
        targetId: row.id,
        venueId: row.venueId,
        createdAt: row.createdAt.toISOString(),
        revocationEvidenceCount: row._count.revocationEvidence,
        exportArtifactCount: row._count.exportArtifacts,
      })),
      rows.length > input.limit
        ? encodeKeysetCursor(page.at(-1)!.createdAt, page.at(-1)!.id)
        : null,
    )
  },
}

const offboardingEvidence: OperatorReadTool = {
  name: 'offboarding.list_evidence',
  capability: 'access:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['offboarding.list_evidence'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    await requirePlan(context, input.tenantId, input.planId)
    const base = { tenantId: input.tenantId, planId: input.planId }
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    await requireCursorInScope(after?.id, (id) =>
      context.database.offboardingRevocationEvidence.findFirst({
        where: { ...base, id, recordedAt: after!.at },
        select: { id: true },
      }),
    )
    const rows = await context.database.offboardingRevocationEvidence.findMany({
      where: {
        ...base,
        ...(after
          ? {
              OR: [
                { recordedAt: { lt: after.at } },
                { recordedAt: after.at, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: {
        id: true,
        venueId: true,
        target: true,
        outcome: true,
        errorCode: true,
        recordedAt: true,
      },
    })
    const page = rows.slice(0, input.limit)
    return pageResult(
      page.map((row) => ({
        evidenceId: row.id,
        venueId: row.venueId,
        target: row.target,
        outcome: row.outcome,
        errorCode: row.errorCode ? operatorUntrustedText(row.errorCode) : null,
        recordedAt: row.recordedAt.toISOString(),
      })),
      rows.length > input.limit
        ? encodeKeysetCursor(page.at(-1)!.recordedAt, page.at(-1)!.id)
        : null,
    )
  },
}

const offboardingArtifacts: OperatorReadTool = {
  name: 'offboarding.list_artifacts',
  capability: 'access:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['offboarding.list_artifacts'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    await requirePlan(context, input.tenantId, input.planId)
    const base = { tenantId: input.tenantId, planId: input.planId }
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    await requireCursorInScope(after?.id, (id) =>
      context.database.offboardingExportArtifact.findFirst({
        where: { ...base, id, createdAt: after!.at },
        select: { id: true },
      }),
    )
    const rows = await context.database.offboardingExportArtifact.findMany({
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
        kind: true,
        contentHash: true,
        createdBy: true,
        createdAt: true,
      },
    })
    const page = rows.slice(0, input.limit)
    return pageResult(
      page.map((row) => ({
        artifactId: row.id,
        venueId: row.venueId,
        kind: row.kind,
        contentHash: row.contentHash,
        createdBy: operatorUntrustedText(row.createdBy),
        createdAt: row.createdAt.toISOString(),
      })),
      rows.length > input.limit
        ? encodeKeysetCursor(page.at(-1)!.createdAt, page.at(-1)!.id)
        : null,
    )
  },
}

export const accessReadTools: readonly OperatorReadTool[] = [
  memberships,
  offboardingPlanList,
  offboardingTargets,
  offboardingEvidence,
  offboardingArtifacts,
]
