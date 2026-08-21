import {
  StripeBillingProvider,
  createStripeClient,
  parseBillingEnvironment,
  reconcileBillingAccount,
} from '@pathfinder/billing'
import {
  db,
  publishOperationalEvent,
  withTenantIsolationBypass,
  writeAuditLogStrict,
} from '@pathfinder/db'
import type { BillingReconciliationJobPayload } from '@pathfinder/jobs'

export async function processBillingReconciliationJob(payload: BillingReconciliationJobPayload) {
  const environment = parseBillingEnvironment()
  if (!environment.STRIPE_RECONCILIATION_ENABLED) return { skipped: true, accountsProcessed: 0 }
  const provider = new StripeBillingProvider(createStripeClient(environment))
  const tenantIds = payload.tenantId
    ? [payload.tenantId]
    : await withTenantIsolationBypass(async () => {
        const accounts = await db.billingAccount.findMany({
          where: {
            billingMode: 'STRIPE_SUBSCRIPTION',
            stripeMode: environment.STRIPE_MODE === 'live' ? 'LIVE' : 'TEST',
            stripeAccountId: environment.STRIPE_ACCOUNT_NAMESPACE,
            commercialAgreements: { some: { stripeSubscriptionId: { not: null } } },
          },
          select: { tenantId: true },
          orderBy: [{ lastReconciledAt: 'asc' }, { tenantId: 'asc' }],
          take: 100,
        })
        return accounts.map((account) => account.tenantId)
      })
  for (const tenantId of tenantIds) {
    await reconcileBillingAccount({
      tenantId,
      actorId: 'billing-reconciliation-worker',
      trigger: 'SCHEDULED',
      provider,
      environment,
    })
  }
  const now = new Date()
  const warningHorizon = new Date(now.getTime() + 2 * 86_400_000)
  const [graceAccounts, expiringOverrides] = await withTenantIsolationBypass(() =>
    Promise.all([
      db.billingAccount.findMany({
        where: { status: 'PAST_DUE', gracePeriodEndsAt: { lte: warningHorizon } },
        select: { id: true, tenantId: true, gracePeriodEndsAt: true },
        take: 100,
      }),
      db.billingAccessOverride.findMany({
        where: { expiresAt: { gt: now, lte: warningHorizon } },
        select: { id: true, tenantId: true, expiresAt: true },
        take: 100,
      }),
    ]),
  )
  for (const account of graceAccounts) {
    if (!account.gracePeriodEndsAt) continue
    const expired = account.gracePeriodEndsAt <= now
    const event = await publishOperationalEvent({
      event: {
        tenantId: account.tenantId,
        eventType: expired
          ? 'billing.entitlements-suspended'
          : 'billing.grace-period-nearing-expiration',
        sourceSubsystem: 'billing',
        severity: expired ? 'ERROR' : 'WARNING',
        title: expired
          ? 'Paid entitlements suspended by billing policy'
          : 'Billing grace period is nearing expiration',
        summary: expired
          ? 'The configured payment grace period ended. Paid entitlements are suspended without deleting venue data.'
          : `The payment recovery grace period ends on ${account.gracePeriodEndsAt.toISOString()}.`,
        actionRequired: true,
        linkedObjectType: 'BillingAccount',
        linkedObjectId: account.id,
        recommendedAction:
          'Review payment recovery status, notify the customer, and reconcile before taking further action.',
        deduplicationKey: `billing-grace:${account.id}:${account.gracePeriodEndsAt.toISOString()}:${expired ? 'expired' : 'warning'}`,
      },
    })
    if (expired && event.occurrenceCount === 1)
      await writeAuditLogStrict({
        tenantId: account.tenantId,
        actorId: 'billing-reconciliation-worker',
        actorRole: 'SYSTEM',
        action: 'billing.entitlements-suspension-effective',
        targetType: 'BillingAccount',
        targetId: account.id,
        afterState: {
          gracePeriodEndsAt: account.gracePeriodEndsAt.toISOString(),
          dataDeleted: false,
        },
      })
  }
  for (const override of expiringOverrides)
    await publishOperationalEvent({
      event: {
        tenantId: override.tenantId,
        eventType: 'billing.manual-override-nearing-expiration',
        sourceSubsystem: 'billing',
        severity: 'WARNING',
        title: 'Manual billing override is nearing expiration',
        summary: `The audited override expires on ${override.expiresAt.toISOString()}.`,
        actionRequired: true,
        linkedObjectType: 'BillingAccessOverride',
        linkedObjectId: override.id,
        recommendedAction:
          'Review the agreement and either recover payment or create a new justified, expiring override.',
        deduplicationKey: `billing-override-expiry:${override.id}:${override.expiresAt.toISOString()}`,
      },
    })
  return { skipped: false, accountsProcessed: tenantIds.length }
}
