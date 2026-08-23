import { z } from 'zod'

import { db } from '../client'
import { readAiProviderHealthControl } from './ai-provider-health-control'

const request = z
  .object({
    clientId: z.string().trim().min(1).max(191),
    venueIds: z.array(z.string().trim().min(1).max(191)).max(500),
  })
  .strict()

type IntegrationHealthClient = Pick<
  typeof db,
  | 'correspondenceProviderAccount'
  | 'billingAccount'
  | 'agentWorker'
  | 'agentBridgeSession'
  | 'platformConfig'
  | 'embeddingDispatch'
  | 'embeddingWorkClaim'
  | 'intakeUpload'
  | 'intakeUploadVerificationReceipt'
  | 'analyticsEvent'
  | 'dailyRollup'
  | 'jobRecord'
  | 'nativeVenueDeploymentRelease'
  | 'aiUsageEvent'
  | 'externalAccessCredential'
>

type HealthState = 'HEALTHY' | 'DEGRADED' | 'OFFLINE' | 'DISABLED' | 'NOT_CONFIGURED'

function iso(value: Date | null | undefined) {
  return value?.toISOString() ?? null
}

function health(
  integration: string,
  state: HealthState,
  detail: {
    configured: boolean
    enabled: boolean
    lastSuccessAt?: Date | null | undefined
    lastFailureAt?: Date | null | undefined
    errorCategory?: string | null | undefined
    summary: string
  },
) {
  return {
    integration,
    state,
    configured: detail.configured,
    enabled: detail.enabled,
    lastSuccessAt: iso(detail.lastSuccessAt),
    lastFailureAt: iso(detail.lastFailureAt),
    errorCategory: detail.errorCategory ?? null,
    summary: detail.summary,
  }
}

function latest(values: Array<Date | null | undefined>) {
  return values
    .filter((value): value is Date => Boolean(value))
    .sort((left, right) => right.getTime() - left.getTime())[0]
}

/** Safe, secret-free projection assembled only from canonical persisted evidence. */
export async function readUnifiedIntegrationHealth(
  rawInput: z.input<typeof request>,
  client: IntegrationHealthClient = db,
  now = new Date(),
) {
  const input = request.parse(rawInput)
  const venueWhere = input.venueIds.length > 0 ? { venueId: { in: input.venueIds } } : {}
  const [
    gmailAccountRows,
    billing,
    workers,
    sessions,
    embeddingBacklog,
    embeddingFailure,
    embeddingSuccess,
    latestUpload,
    latestVersionedUpload,
    storageVerification,
    latestAnalyticsEvent,
    latestRollup,
    latestDailyRollupJob,
    latestEnrichmentJob,
    deployment,
    aiSuccess,
    aiFailure,
    credentials,
    providerControl,
  ] = await Promise.all([
    client.correspondenceProviderAccount.findMany({
      // CRM mailboxes are platform-shared and have no tenant relation. Aggregate only bounded,
      // secret-free health evidence; never expose account identity through this tenant projection.
      where: { provider: 'GMAIL' },
      orderBy: { updatedAt: 'desc' },
      take: 101,
      select: {
        connectionStatus: true,
        deliveryEnabled: true,
        lastSuccessfulSyncAt: true,
        lastHealthCheckAt: true,
        healthErrorCode: true,
      },
    }),
    client.billingAccount.findUnique({
      where: { tenantId: input.clientId },
      select: {
        billingMode: true,
        status: true,
        reconciliationHealth: true,
        lastReconciledAt: true,
        lastReconciliationError: true,
        updatedAt: true,
      },
    }),
    client.agentWorker.findMany({
      where: {
        tenantId: input.clientId,
        clientId: input.clientId,
        status: { not: 'REVOKED' },
      },
      take: 101,
      select: { status: true, leaseExpiresAt: true, lastHeartbeatAt: true },
    }),
    client.agentBridgeSession.findMany({
      where: { tenantId: input.clientId, ...venueWhere, status: { not: 'REVOKED' } },
      take: 101,
      select: { status: true, expiresAt: true, lastHeartbeatAt: true },
    }),
    client.embeddingDispatch.count({ where: { tenantId: input.clientId, ...venueWhere } }),
    client.embeddingDispatch.findFirst({
      where: { tenantId: input.clientId, ...venueWhere, lastError: { not: null } },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    }),
    client.embeddingWorkClaim.findFirst({
      where: { tenantId: input.clientId, ...venueWhere, status: 'COMPLETE' },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    }),
    client.intakeUpload.findFirst({
      where: { tenantId: input.clientId, ...venueWhere },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    }),
    client.intakeUpload.findFirst({
      where: { tenantId: input.clientId, ...venueWhere, storageVersionId: { not: null } },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    }),
    client.intakeUploadVerificationReceipt.findFirst({
      where: { tenantId: input.clientId, ...venueWhere },
      orderBy: { recordedAt: 'desc' },
      select: { recordedAt: true },
    }),
    client.analyticsEvent.findFirst({
      where: { tenantId: input.clientId, ...venueWhere },
      orderBy: { receivedAt: 'desc' },
      select: { receivedAt: true },
    }),
    client.dailyRollup.findFirst({
      where: { tenantId: input.clientId, ...venueWhere },
      orderBy: { date: 'desc' },
      select: { date: true },
    }),
    client.jobRecord.findFirst({
      where: { tenantId: input.clientId, jobName: 'daily-rollup-process' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        status: true,
        startedAt: true,
        completedAt: true,
        failureDisposition: true,
      },
    }),
    client.jobRecord.findFirst({
      where: { tenantId: input.clientId, jobName: 'analytics-enrichment-process' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        status: true,
        startedAt: true,
        completedAt: true,
        failureDisposition: true,
      },
    }),
    client.nativeVenueDeploymentRelease.findFirst({
      where: { tenantId: input.clientId, ...venueWhere },
      orderBy: { updatedAt: 'desc' },
      select: { status: true, updatedAt: true, appliedAt: true },
    }),
    client.aiUsageEvent.findFirst({
      where: { tenantId: input.clientId, ...venueWhere, success: true },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
    client.aiUsageEvent.findFirst({
      where: { tenantId: input.clientId, ...venueWhere, success: false },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, errorCode: true },
    }),
    client.externalAccessCredential.findMany({
      where: { tenantId: input.clientId, clientId: input.clientId, ...venueWhere },
      take: 101,
      select: { enabled: true, revokedAt: true, expiresAt: true, lastUsedAt: true },
    }),
    readAiProviderHealthControl(client, now),
  ])

  const gmailInventoryTruncated = gmailAccountRows.length > 100
  const workerInventoryTruncated = workers.length > 100
  const sessionInventoryTruncated = sessions.length > 100
  const credentialInventoryTruncated = credentials.length > 100
  const gmailAccounts = gmailAccountRows.slice(0, 100)
  const boundedWorkers = workers.slice(0, 100)
  const boundedSessions = sessions.slice(0, 100)
  const boundedCredentials = credentials.slice(0, 100)
  const onlineWorkers = boundedWorkers.filter(
    (worker) => worker.status === 'ONLINE' && worker.leaseExpiresAt.getTime() > now.getTime(),
  )
  const onlineSessions = boundedSessions.filter(
    (session) => session.status === 'ONLINE' && session.expiresAt.getTime() > now.getTime(),
  )
  const activeCredentials = boundedCredentials.filter(
    (credential) =>
      credential.enabled &&
      !credential.revokedAt &&
      (!credential.expiresAt || credential.expiresAt.getTime() > now.getTime()),
  )
  const latestWorkerSuccess = latest(
    [...onlineWorkers, ...onlineSessions].map((entry) => entry.lastHeartbeatAt),
  )
  const connectedGmailAccounts = gmailAccounts.filter(
    (account) => account.connectionStatus === 'CONNECTED',
  )
  const unhealthyGmailAccounts = gmailAccounts.filter((account) => account.healthErrorCode)
  const gmailState: HealthState =
    gmailAccounts.length === 0
      ? 'NOT_CONFIGURED'
      : gmailInventoryTruncated || unhealthyGmailAccounts.length > 0
        ? 'DEGRADED'
        : connectedGmailAccounts.length > 0
          ? 'HEALTHY'
          : 'OFFLINE'
  const billingState: HealthState = !billing
    ? 'NOT_CONFIGURED'
    : !billing.billingMode.startsWith('STRIPE_')
      ? 'DISABLED'
      : billing.reconciliationHealth === 'CURRENT'
        ? 'HEALTHY'
        : billing.reconciliationHealth === 'ERROR' || billing.reconciliationHealth === 'DRIFT'
          ? 'DEGRADED'
          : 'DEGRADED'
  const analyticsJobs = [latestDailyRollupJob, latestEnrichmentJob].filter(
    (job): job is NonNullable<typeof job> => Boolean(job),
  )
  const staleAnalyticsJob = analyticsJobs.find(
    (job) => job.status === 'RUNNING' && now.getTime() - job.startedAt.getTime() > 15 * 60 * 1000,
  )
  const failedAnalyticsJob = analyticsJobs.find((job) => job.status === 'FAILED')
  const analyticsConfigured = Boolean(
    latestAnalyticsEvent || latestRollup || latestDailyRollupJob || latestEnrichmentJob,
  )
  const analyticsState: HealthState =
    staleAnalyticsJob || failedAnalyticsJob
      ? 'DEGRADED'
      : analyticsConfigured
        ? 'HEALTHY'
        : 'NOT_CONFIGURED'
  const storageSuccessAt = latest([
    storageVerification?.recordedAt,
    latestVersionedUpload?.updatedAt,
  ])
  const storageConfigured = Boolean(latestUpload || storageVerification)

  return {
    schemaVersion: 'integration-health.v1',
    observedAt: now.toISOString(),
    scope: { clientId: input.clientId, venueIds: input.venueIds },
    integrations: [
      health('GMAIL', gmailState, {
        configured: gmailAccounts.length > 0,
        enabled: gmailAccounts.some(
          (account) => account.connectionStatus === 'CONNECTED' && account.deliveryEnabled,
        ),
        lastSuccessAt: latest(gmailAccounts.map((account) => account.lastSuccessfulSyncAt)),
        lastFailureAt: latest(unhealthyGmailAccounts.map((account) => account.lastHealthCheckAt)),
        errorCategory: gmailInventoryTruncated
          ? 'INVENTORY_TRUNCATED'
          : unhealthyGmailAccounts.length > 0
            ? 'PROVIDER_ACCOUNT_HEALTH'
            : null,
        summary:
          gmailAccounts.length > 0
            ? `${connectedGmailAccounts.length} of ${gmailAccounts.length}${gmailInventoryTruncated ? '+' : ''} mailbox account(s) connected; ${unhealthyGmailAccounts.length} report health errors.`
            : 'No mailbox is configured.',
      }),
      health('STRIPE', billingState, {
        configured: Boolean(billing),
        enabled: Boolean(billing?.billingMode.startsWith('STRIPE_')),
        lastSuccessAt: billing?.lastReconciledAt,
        lastFailureAt: billing?.lastReconciliationError ? billing.updatedAt : null,
        errorCategory: billing?.lastReconciliationError ? 'RECONCILIATION' : null,
        summary: billing
          ? `Billing account is ${billing.status.toLowerCase()}.`
          : 'No billing account is configured.',
      }),
      health(
        'AGENT_RUNTIME',
        workerInventoryTruncated || sessionInventoryTruncated
          ? 'DEGRADED'
          : onlineWorkers.length + onlineSessions.length > 0
            ? 'HEALTHY'
            : boundedWorkers.length + boundedSessions.length > 0
              ? 'OFFLINE'
              : 'NOT_CONFIGURED',
        {
          configured: boundedWorkers.length + boundedSessions.length > 0,
          enabled: onlineWorkers.length + onlineSessions.length > 0,
          lastSuccessAt: latestWorkerSuccess,
          errorCategory:
            workerInventoryTruncated || sessionInventoryTruncated ? 'INVENTORY_TRUNCATED' : null,
          summary: `${onlineWorkers.length} portable worker(s) and ${onlineSessions.length} bridge session(s) online${workerInventoryTruncated || sessionInventoryTruncated ? '; inventory exceeds the bounded projection' : ''}.`,
        },
      ),
      health(
        'AI_PROVIDERS',
        providerControl.malformed || providerControl.activeUnhealthyProviders.length > 0
          ? 'DEGRADED'
          : aiFailure && (!aiSuccess || aiFailure.createdAt > aiSuccess.createdAt)
            ? 'DEGRADED'
            : aiSuccess
              ? 'HEALTHY'
              : 'NOT_CONFIGURED',
        {
          configured: providerControl.configured || Boolean(aiSuccess || aiFailure),
          enabled: !providerControl.malformed && Boolean(aiSuccess || aiFailure),
          lastSuccessAt: aiSuccess?.createdAt,
          lastFailureAt: aiFailure?.createdAt,
          errorCategory: providerControl.malformed
            ? 'HEALTH_CONTROL_MALFORMED'
            : providerControl.activeUnhealthyProviders.length > 0
              ? 'HEALTH_OVERRIDE_ACTIVE'
              : aiFailure?.errorCode,
          summary: providerControl.malformed
            ? 'The central provider-health control is malformed; provider eligibility fails closed.'
            : providerControl.activeUnhealthyProviders.length > 0
              ? `${providerControl.activeUnhealthyProviders.length} provider health exclusion(s) are active.`
              : aiSuccess || aiFailure
                ? 'Derived from persisted AI usage outcomes and central provider-health control.'
                : 'No provider outcome has been observed.',
        },
      ),
      health(
        'EMBEDDINGS',
        embeddingFailure
          ? 'DEGRADED'
          : embeddingBacklog > 0 || embeddingSuccess
            ? 'HEALTHY'
            : 'NOT_CONFIGURED',
        {
          configured: embeddingBacklog > 0 || Boolean(embeddingFailure || embeddingSuccess),
          enabled: embeddingBacklog > 0 || Boolean(embeddingSuccess),
          lastSuccessAt: embeddingSuccess?.updatedAt,
          lastFailureAt: embeddingFailure?.updatedAt,
          errorCategory: embeddingFailure ? 'DISPATCH_FAILURE' : null,
          summary:
            embeddingBacklog > 0 || embeddingSuccess || embeddingFailure
              ? `${embeddingBacklog} embedding dispatch(es) pending.`
              : 'No embedding dispatch or completed work has been observed.',
        },
      ),
      health(
        'OBJECT_STORAGE',
        storageSuccessAt ? 'HEALTHY' : storageConfigured ? 'DEGRADED' : 'NOT_CONFIGURED',
        {
          configured: storageConfigured,
          enabled: Boolean(storageSuccessAt),
          lastSuccessAt: storageSuccessAt,
          errorCategory: storageConfigured && !storageSuccessAt ? 'NO_VERIFIED_OBJECT' : null,
          summary: storageSuccessAt
            ? 'A versioned object or immutable storage verification receipt has been observed in scope.'
            : storageConfigured
              ? 'An upload workflow exists in scope, but no versioned object has been verified.'
              : 'No object-storage workflow has been observed in scope.',
        },
      ),
      health('ANALYTICS_PIPELINE', analyticsState, {
        configured: analyticsConfigured,
        enabled: analyticsConfigured && !staleAnalyticsJob,
        lastSuccessAt: latest([
          latestAnalyticsEvent?.receivedAt,
          latestRollup?.date,
          ...analyticsJobs.map((job) => (job.status === 'COMPLETE' ? job.completedAt : null)),
        ]),
        lastFailureAt: latest(
          analyticsJobs.map((job) => (job.status === 'FAILED' ? job.completedAt : null)),
        ),
        errorCategory: staleAnalyticsJob
          ? 'STALE_JOB'
          : (failedAnalyticsJob?.failureDisposition ?? (failedAnalyticsJob ? 'JOB_FAILURE' : null)),
        summary: analyticsConfigured
          ? 'Derived from persisted event intake, rollups, and the latest tenant pipeline jobs.'
          : 'No analytics event, rollup, or pipeline job has been observed.',
      }),
      health(
        'DEPLOYMENT',
        deployment ? (deployment.status === 'APPLIED' ? 'HEALTHY' : 'DISABLED') : 'NOT_CONFIGURED',
        {
          configured: Boolean(deployment),
          enabled: deployment?.status === 'APPLIED',
          lastSuccessAt: deployment?.appliedAt,
          lastFailureAt: null,
          errorCategory: null,
          summary: deployment
            ? `Latest deployment is ${deployment.status.toLowerCase()}.`
            : 'No deployment exists in scope.',
        },
      ),
      health(
        'EXTERNAL_WORKER_ACCESS',
        credentialInventoryTruncated
          ? 'DEGRADED'
          : activeCredentials.length > 0
            ? 'HEALTHY'
            : boundedCredentials.length > 0
              ? 'DISABLED'
              : 'NOT_CONFIGURED',
        {
          configured: boundedCredentials.length > 0,
          enabled: activeCredentials.length > 0,
          lastSuccessAt: activeCredentials
            .map((entry) => entry.lastUsedAt)
            .filter((value): value is Date => Boolean(value))
            .sort((left, right) => right.getTime() - left.getTime())[0],
          errorCategory: credentialInventoryTruncated ? 'INVENTORY_TRUNCATED' : null,
          summary: `${activeCredentials.length} active scoped machine credential(s)${credentialInventoryTruncated ? '; inventory exceeds the bounded projection' : ''}.`,
        },
      ),
    ],
  }
}
