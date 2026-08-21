import { z } from 'zod'

import { db } from '../client'

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
  | 'embeddingDispatch'
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

/** Safe, secret-free projection assembled only from canonical persisted evidence. */
export async function readUnifiedIntegrationHealth(
  rawInput: z.input<typeof request>,
  client: IntegrationHealthClient = db,
  now = new Date(),
) {
  const input = request.parse(rawInput)
  const venueWhere = input.venueIds.length > 0 ? { venueId: { in: input.venueIds } } : {}
  const [
    gmail,
    billing,
    workers,
    sessions,
    embeddingBacklog,
    embeddingFailure,
    deployment,
    aiSuccess,
    aiFailure,
    credentials,
  ] = await Promise.all([
    client.correspondenceProviderAccount.findFirst({
      where: { provider: 'GMAIL' },
      orderBy: { updatedAt: 'desc' },
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
      where: { clientId: input.clientId, status: { not: 'REVOKED' } },
      take: 100,
      select: { status: true, leaseExpiresAt: true, lastHeartbeatAt: true },
    }),
    client.agentBridgeSession.findMany({
      where: { tenantId: input.clientId, ...venueWhere, status: { not: 'REVOKED' } },
      take: 100,
      select: { status: true, expiresAt: true, lastHeartbeatAt: true },
    }),
    client.embeddingDispatch.count({ where: { tenantId: input.clientId, ...venueWhere } }),
    client.embeddingDispatch.findFirst({
      where: { tenantId: input.clientId, ...venueWhere, lastError: { not: null } },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
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
      take: 100,
      select: { enabled: true, revokedAt: true, expiresAt: true, lastUsedAt: true },
    }),
  ])

  const onlineWorkers = workers.filter(
    (worker) => worker.status === 'ONLINE' && worker.leaseExpiresAt.getTime() > now.getTime(),
  )
  const onlineSessions = sessions.filter(
    (session) => session.status === 'ONLINE' && session.expiresAt.getTime() > now.getTime(),
  )
  const activeCredentials = credentials.filter(
    (credential) =>
      credential.enabled &&
      !credential.revokedAt &&
      (!credential.expiresAt || credential.expiresAt.getTime() > now.getTime()),
  )
  const latestWorkerSuccess = [...onlineWorkers, ...onlineSessions]
    .map((entry) => entry.lastHeartbeatAt)
    .sort((left, right) => right.getTime() - left.getTime())[0]
  const gmailState: HealthState = !gmail
    ? 'NOT_CONFIGURED'
    : gmail.connectionStatus === 'CONNECTED' && !gmail.healthErrorCode
      ? 'HEALTHY'
      : gmail.connectionStatus === 'DISCONNECTED'
        ? 'OFFLINE'
        : 'DEGRADED'
  const billingState: HealthState = !billing
    ? 'NOT_CONFIGURED'
    : !billing.billingMode.startsWith('STRIPE_')
      ? 'DISABLED'
      : billing.reconciliationHealth === 'CURRENT'
        ? 'HEALTHY'
        : billing.reconciliationHealth === 'ERROR' || billing.reconciliationHealth === 'DRIFT'
          ? 'DEGRADED'
          : 'DEGRADED'

  return {
    schemaVersion: 'integration-health.v1',
    observedAt: now.toISOString(),
    scope: { clientId: input.clientId, venueIds: input.venueIds },
    integrations: [
      health('GMAIL', gmailState, {
        configured: Boolean(gmail),
        enabled: Boolean(gmail?.deliveryEnabled),
        lastSuccessAt: gmail?.lastSuccessfulSyncAt,
        lastFailureAt: gmail?.healthErrorCode ? gmail.lastHealthCheckAt : null,
        errorCategory: gmail?.healthErrorCode,
        summary: gmail
          ? `Mailbox connection is ${gmail.connectionStatus.toLowerCase()}.`
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
        onlineWorkers.length + onlineSessions.length > 0
          ? 'HEALTHY'
          : workers.length + sessions.length > 0
            ? 'OFFLINE'
            : 'NOT_CONFIGURED',
        {
          configured: workers.length + sessions.length > 0,
          enabled: onlineWorkers.length + onlineSessions.length > 0,
          lastSuccessAt: latestWorkerSuccess,
          summary: `${onlineWorkers.length} portable worker(s) and ${onlineSessions.length} bridge session(s) online.`,
        },
      ),
      health(
        'AI_PROVIDERS',
        aiFailure && (!aiSuccess || aiFailure.createdAt > aiSuccess.createdAt)
          ? 'DEGRADED'
          : aiSuccess
            ? 'HEALTHY'
            : 'NOT_CONFIGURED',
        {
          configured: Boolean(aiSuccess || aiFailure),
          enabled: Boolean(aiSuccess || aiFailure),
          lastSuccessAt: aiSuccess?.createdAt,
          lastFailureAt: aiFailure?.createdAt,
          errorCategory: aiFailure?.errorCode,
          summary:
            aiSuccess || aiFailure
              ? 'Derived from persisted AI usage outcomes.'
              : 'No provider outcome has been observed.',
        },
      ),
      health('EMBEDDINGS', embeddingFailure ? 'DEGRADED' : 'HEALTHY', {
        configured: true,
        enabled: true,
        lastFailureAt: embeddingFailure?.updatedAt,
        errorCategory: embeddingFailure ? 'DISPATCH_FAILURE' : null,
        summary: `${embeddingBacklog} embedding dispatch(es) pending.`,
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
        activeCredentials.length > 0
          ? 'HEALTHY'
          : credentials.length > 0
            ? 'DISABLED'
            : 'NOT_CONFIGURED',
        {
          configured: credentials.length > 0,
          enabled: activeCredentials.length > 0,
          lastSuccessAt: activeCredentials
            .map((entry) => entry.lastUsedAt)
            .filter((value): value is Date => Boolean(value))
            .sort((left, right) => right.getTime() - left.getTime())[0],
          summary: `${activeCredentials.length} active scoped machine credential(s).`,
        },
      ),
    ],
  }
}
