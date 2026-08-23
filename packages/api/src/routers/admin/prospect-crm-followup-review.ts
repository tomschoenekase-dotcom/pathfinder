import { db } from '@pathfinder/db'

export async function getProspectOutreachReadinessProjection() {
  const now = new Date()
  const [control, accounts, followupRows] = await Promise.all([
    db.prospectDeliveryControl.findUnique({ where: { id: 'global' } }),
    db.correspondenceProviderAccount.findMany({
      where: { provider: 'GMAIL' },
      select: {
        id: true,
        mailboxAddress: true,
        connectionStatus: true,
        deliveryEnabled: true,
        pausedAt: true,
        lastSuccessfulSyncAt: true,
        lastReconciliationAt: true,
        watchExpiration: true,
        healthErrorCode: true,
        healthErrorSummary: true,
      },
      orderBy: { mailboxAddress: 'asc' },
    }),
    db.prospectFollowup.findMany({
      where: { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: 101,
      select: {
        id: true,
        organizationId: true,
        dueAt: true,
        sequenceNumber: true,
        status: true,
        reason: true,
        policyApprovedAt: true,
        readinessCheckedAt: true,
        organization: { select: { canonicalName: true, relationshipTier: true } },
        opportunity: { select: { stage: true, priority: true, lastActivityAt: true } },
        campaignMember: { select: { status: true } },
        triggerSendItem: { select: { sentAt: true } },
      },
    }),
  ])
  const followups = followupRows.slice(0, 100).map((followup) => ({
    ...followup,
    due: followup.dueAt <= now,
    policyApproved: Boolean(followup.policyApprovedAt),
  }))

  return {
    deliveryEnabled:
      process.env.PROSPECT_OUTREACH_DELIVERY_ENABLED === 'true' &&
      Boolean(control?.deliveryEnabled),
    internalOnly: control?.internalOnly ?? true,
    providerConfigured: accounts.some(
      (account) => account.connectionStatus === 'CONNECTED' && account.deliveryEnabled,
    ),
    provider: 'GMAIL' as const,
    accounts,
    limits: { cohort: 5000, batch: 500 },
    policy: { agentsMayDraft: true, agentsMayApprove: false, agentsMaySend: false },
    followupReview: {
      generatedAt: now,
      evidenceBounded: followupRows.length > 100,
      policy: {
        automaticSchedulingAuthorized: false,
        automaticSendingAuthorized: false,
        alternateContactAuthorized: false,
        cadencePolicy: 'UNRESOLVED' as const,
      },
      counts: {
        due: followups.filter((item) => item.due).length,
        scheduled: followups.filter((item) => !item.due).length,
        readyForDraft: followups.filter((item) => item.status === 'READY_FOR_DRAFT').length,
        held: followups.filter((item) => item.status.startsWith('ON_HOLD_')).length,
      },
      items: followups,
    },
  }
}
