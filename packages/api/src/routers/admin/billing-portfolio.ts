import { z } from 'zod'

import { buildPaymentRecoveryContext } from '@pathfinder/billing'
import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

export const adminBillingPortfolioRouter = router({
  listBillingPortfolio: adminProcedure
    .input(
      z
        .object({
          search: z.string().trim().max(120).optional(),
          attentionOnly: z.boolean().default(false),
          limit: z.number().int().min(1).max(200).default(100),
        })
        .strict()
        .optional(),
    )
    .query(async ({ input }) =>
      withTenantIsolationBypass(async () => {
        const now = new Date()
        const search = input?.search?.trim()
        const accounts = await db.billingAccount.findMany({
          ...(search
            ? {
                where: {
                  OR: [
                    { displayNameSnapshot: { contains: search, mode: 'insensitive' } },
                    { billingEmail: { contains: search, mode: 'insensitive' } },
                    { tenant: { name: { contains: search, mode: 'insensitive' } } },
                  ],
                },
              }
            : {}),
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: input?.limit ?? 100,
          select: {
            id: true,
            tenantId: true,
            displayNameSnapshot: true,
            billingEmail: true,
            billingMode: true,
            currency: true,
            status: true,
            paidThroughAt: true,
            gracePeriodEndsAt: true,
            reconciliationHealth: true,
            lastReconciledAt: true,
            updatedAt: true,
            tenant: {
              select: {
                id: true,
                name: true,
                status: true,
                prospectCustomerRelationships: {
                  where: { status: 'ACTIVE' },
                  orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
                  take: 1,
                  select: {
                    startedAt: true,
                    organization: {
                      select: { id: true, canonicalName: true, relationshipTier: true },
                    },
                  },
                },
              },
            },
            commercialAgreements: {
              orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
              select: {
                id: true,
                isBase: true,
                internalPlanKey: true,
                status: true,
                billingMode: true,
                billingInterval: true,
                billingIntervalCount: true,
                agreedAmountMinor: true,
                currency: true,
                currentPeriodEndsAt: true,
                cancelAtPeriodEnd: true,
                coveredVenueCount: true,
              },
            },
            invoiceProjections: {
              // Recovery exposure must include older outstanding invoices; only the
              // returned display list is truncated below.
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              select: {
                id: true,
                status: true,
                amountDueMinor: true,
                amountPaidMinor: true,
                amountRemainingMinor: true,
                currency: true,
                dueAt: true,
                paidAt: true,
                failedAt: true,
                nextRetryAt: true,
                failureSummary: true,
              },
            },
            customerRequests: {
              where: { status: { in: ['OPEN', 'PROCESSING', 'FAILED'] } },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: 10,
              select: {
                id: true,
                kind: true,
                status: true,
                featureLabelSnapshot: true,
                reason: true,
                createdAt: true,
              },
            },
          },
        })

        const rows = accounts.map((account) => {
          const agreement =
            account.commercialAgreements.find((candidate) => candidate.isBase) ??
            account.commercialAgreements[0] ??
            null
          const latestInvoice = account.invoiceProjections[0] ?? null
          const relationship = account.tenant.prospectCustomerRelationships[0] ?? null
          const paymentRecovery = buildPaymentRecoveryContext({
            accountStatus: account.status,
            gracePeriodEndsAt: account.gracePeriodEndsAt,
            agreement: agreement
              ? {
                  agreedAmountMinor: agreement.agreedAmountMinor,
                  currency: agreement.currency,
                  billingInterval: agreement.billingInterval,
                  billingIntervalCount: agreement.billingIntervalCount,
                }
              : null,
            invoices: account.invoiceProjections,
            relationship: relationship
              ? {
                  organizationId: relationship.organization.id,
                  organizationName: relationship.organization.canonicalName,
                  relationshipTier: relationship.organization.relationshipTier,
                  relationshipStartedAt: relationship.startedAt,
                }
              : null,
            now,
          })
          const needsAttention =
            ['PAST_DUE', 'UNPAID', 'SUSPENDED', 'DISPUTED'].includes(account.status) ||
            ['DRIFT', 'ERROR', 'STALE'].includes(account.reconciliationHealth) ||
            latestInvoice?.status === 'OPEN' ||
            latestInvoice?.status === 'UNCOLLECTIBLE' ||
            Boolean(latestInvoice?.failedAt) ||
            account.customerRequests.length > 0
          return {
            ...account,
            commercialAgreements: undefined,
            agreement,
            latestInvoices: account.invoiceProjections.slice(0, 5),
            invoiceProjections: undefined,
            crmOrganization: relationship?.organization ?? null,
            tenant: {
              id: account.tenant.id,
              name: account.tenant.name,
              status: account.tenant.status,
            },
            needsAttention,
            paymentRecovery,
          }
        })
        const filtered = input?.attentionOnly ? rows.filter((row) => row.needsAttention) : rows
        return {
          rows: filtered,
          summary: {
            customers: rows.length,
            attention: rows.filter((row) => row.needsAttention).length,
            pastDue: rows.filter((row) => ['PAST_DUE', 'UNPAID'].includes(row.status)).length,
            unhealthy: rows.filter((row) =>
              ['DRIFT', 'ERROR', 'STALE'].includes(row.reconciliationHealth),
            ).length,
          },
          bounded: accounts.length === (input?.limit ?? 100),
        }
      }),
    ),
})
