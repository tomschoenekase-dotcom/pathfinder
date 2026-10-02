import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import { operatorUntrustedText } from '../crm-projection'
import { assertTenantInGrant } from '../grants'
import type { OperatorReadTool } from '../registry'
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  OperatorInvalidCursorError,
  pageResult,
} from './page'

const billingGetStatus: OperatorReadTool = {
  name: 'billing.get_status',
  capability: 'billing:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['billing.get_status'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    const [account, agreementGroups, baseAgreement, invoiceCount] = await Promise.all([
      context.database.billingAccount.findFirst({
        where: { tenantId: input.tenantId },
        select: {
          id: true,
          billingMode: true,
          currency: true,
          status: true,
          gracePeriodEndsAt: true,
          paidThroughAt: true,
          reconciliationHealth: true,
          lastReconciledAt: true,
          providerStateChangedAt: true,
          updatedAt: true,
        },
      }),
      context.database.commercialAgreement.groupBy({
        by: ['status'],
        where: { tenantId: input.tenantId },
        _count: { _all: true },
      }),
      context.database.commercialAgreement.findFirst({
        where: { tenantId: input.tenantId, isBase: true },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          internalPlanKey: true,
          status: true,
          billingMode: true,
          billingInterval: true,
          quantity: true,
          coveredVenueCount: true,
          agreedAmountMinor: true,
          currency: true,
          startsAt: true,
          accessStartsAt: true,
          accessEndsAt: true,
          currentPeriodEndsAt: true,
          trialEndsAt: true,
          cancelAtPeriodEnd: true,
          cancellationEffectiveAt: true,
          endedAt: true,
          updatedAt: true,
        },
      }),
      context.database.billingInvoiceProjection.count({ where: { tenantId: input.tenantId } }),
    ])
    return {
      tenantId: input.tenantId,
      account: account
        ? {
            billingAccountId: account.id,
            billingMode: account.billingMode,
            currency: account.currency,
            status: account.status,
            gracePeriodEndsAt: account.gracePeriodEndsAt?.toISOString() ?? null,
            paidThroughAt: account.paidThroughAt?.toISOString() ?? null,
            reconciliationHealth: account.reconciliationHealth,
            lastReconciledAt: account.lastReconciledAt?.toISOString() ?? null,
            providerStateChangedAt: account.providerStateChangedAt?.toISOString() ?? null,
            updatedAt: account.updatedAt.toISOString(),
          }
        : null,
      agreementCounts: Object.fromEntries(
        agreementGroups.map((group) => [group.status.toLowerCase(), group._count._all]),
      ),
      baseAgreement: baseAgreement
        ? {
            agreementId: baseAgreement.id,
            planKey: baseAgreement.internalPlanKey,
            status: baseAgreement.status,
            billingMode: baseAgreement.billingMode,
            billingInterval: baseAgreement.billingInterval,
            quantity: baseAgreement.quantity,
            coveredVenueCount: baseAgreement.coveredVenueCount,
            agreedAmountMinor: baseAgreement.agreedAmountMinor?.toString() ?? null,
            currency: baseAgreement.currency,
            startsAt: baseAgreement.startsAt.toISOString(),
            accessStartsAt: baseAgreement.accessStartsAt?.toISOString() ?? null,
            serviceThroughAt: baseAgreement.accessEndsAt?.toISOString() ?? null,
            currentPeriodEndsAt: baseAgreement.currentPeriodEndsAt?.toISOString() ?? null,
            trialEndsAt: baseAgreement.trialEndsAt?.toISOString() ?? null,
            cancelAtPeriodEnd: baseAgreement.cancelAtPeriodEnd,
            cancellationEffectiveAt: baseAgreement.cancellationEffectiveAt?.toISOString() ?? null,
            endedAt: baseAgreement.endedAt?.toISOString() ?? null,
            updatedAt: baseAgreement.updatedAt.toISOString(),
          }
        : null,
      invoiceCount,
    }
  },
}

const billingListInvoices: OperatorReadTool = {
  name: 'billing.list_invoices',
  capability: 'billing:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['billing.list_invoices'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    const baseWhere = { tenantId: input.tenantId }
    const where = {
      ...baseWhere,
      ...(after
        ? { OR: [{ createdAt: { lt: after.at } }, { createdAt: after.at, id: { lt: after.id } }] }
        : {}),
    }
    if (after) {
      const anchor = await context.database.billingInvoiceProjection.findFirst({
        where: { ...baseWhere, id: after.id, createdAt: after.at },
        select: { id: true },
      })
      if (!anchor) throw new OperatorInvalidCursorError()
    }
    const rows = await context.database.billingInvoiceProjection.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: {
        id: true,
        commercialAgreementId: true,
        source: true,
        status: true,
        amountDueMinor: true,
        amountPaidMinor: true,
        amountRemainingMinor: true,
        currency: true,
        dueAt: true,
        paidAt: true,
        failedAt: true,
        voidedAt: true,
        nextRetryAt: true,
        failureCode: true,
        failureSummary: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    const items = rows.slice(0, input.limit)
    return pageResult(
      items.map((invoice) => ({
        invoiceId: invoice.id,
        agreementId: invoice.commercialAgreementId,
        source: invoice.source,
        status: invoice.status,
        amountDueMinor: invoice.amountDueMinor.toString(),
        amountPaidMinor: invoice.amountPaidMinor.toString(),
        amountRemainingMinor: invoice.amountRemainingMinor.toString(),
        currency: invoice.currency,
        dueAt: invoice.dueAt?.toISOString() ?? null,
        paidAt: invoice.paidAt?.toISOString() ?? null,
        failedAt: invoice.failedAt?.toISOString() ?? null,
        voidedAt: invoice.voidedAt?.toISOString() ?? null,
        nextRetryAt: invoice.nextRetryAt?.toISOString() ?? null,
        failureCode: invoice.failureCode,
        failureSummary:
          invoice.failureSummary === null ? null : operatorUntrustedText(invoice.failureSummary),
        createdAt: invoice.createdAt.toISOString(),
        updatedAt: invoice.updatedAt.toISOString(),
      })),
      rows.length > input.limit
        ? encodeKeysetCursor(items.at(-1)!.createdAt, items.at(-1)!.id)
        : null,
    )
  },
}

export const billingReadTools: readonly OperatorReadTool[] = [billingGetStatus, billingListInvoices]
