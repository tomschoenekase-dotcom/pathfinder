import { describe, expect, it, vi } from 'vitest'

import { readUnifiedIntegrationHealth } from './integration-health'

describe('unified integration health', () => {
  it('returns bounded secret-free status from canonical scoped evidence', async () => {
    const now = new Date('2030-01-01T12:00:00.000Z')
    const client = {
      correspondenceProviderAccount: {
        findMany: vi.fn().mockResolvedValue([
          {
            connectionStatus: 'CONNECTED',
            deliveryEnabled: false,
            lastSuccessfulSyncAt: new Date('2030-01-01T11:00:00.000Z'),
            lastHealthCheckAt: now,
            healthErrorCode: null,
          },
        ]),
      },
      billingAccount: { findUnique: vi.fn().mockResolvedValue(null) },
      agentWorker: {
        findMany: vi.fn().mockResolvedValue([
          {
            status: 'ONLINE',
            leaseExpiresAt: new Date('2030-01-01T12:01:00.000Z'),
            lastHeartbeatAt: now,
          },
        ]),
      },
      agentBridgeSession: { findMany: vi.fn().mockResolvedValue([]) },
      embeddingDispatch: {
        count: vi.fn().mockResolvedValue(2),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      embeddingWorkClaim: { findFirst: vi.fn().mockResolvedValue(null) },
      intakeUpload: { findFirst: vi.fn().mockResolvedValue(null) },
      intakeUploadVerificationReceipt: { findFirst: vi.fn().mockResolvedValue(null) },
      analyticsEvent: { findFirst: vi.fn().mockResolvedValue(null) },
      dailyRollup: { findFirst: vi.fn().mockResolvedValue(null) },
      jobRecord: { findFirst: vi.fn().mockResolvedValue(null) },
      nativeVenueDeploymentRelease: { findFirst: vi.fn().mockResolvedValue(null) },
      aiUsageEvent: {
        findFirst: vi.fn().mockResolvedValueOnce({ createdAt: now }).mockResolvedValueOnce(null),
      },
      externalAccessCredential: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { enabled: true, revokedAt: null, expiresAt: null, lastUsedAt: now },
          ]),
      },
      platformConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    }

    const result = await readUnifiedIntegrationHealth(
      { clientId: 'tenant-1', venueIds: ['venue-1'] },
      client as never,
      now,
    )

    expect(result.integrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ integration: 'GMAIL', state: 'HEALTHY' }),
        expect.objectContaining({ integration: 'AGENT_RUNTIME', state: 'HEALTHY' }),
        expect.objectContaining({ integration: 'EXTERNAL_WORKER_ACCESS', state: 'HEALTHY' }),
      ]),
    )
    expect(JSON.stringify(result)).not.toMatch(/mailboxAddress|credentialReference|secret|token/iu)
    expect(client.agentWorker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant-1',
          clientId: 'tenant-1',
          status: { not: 'REVOKED' },
        },
      }),
    )
    expect(client.billingAccount.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'tenant-1' } }),
    )
    expect(client.agentBridgeSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant-1', venueId: { in: ['venue-1'] } }),
      }),
    )
    expect(client.embeddingDispatch.count).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', venueId: { in: ['venue-1'] } },
    })
    expect(client.embeddingWorkClaim.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          venueId: { in: ['venue-1'] },
          status: 'COMPLETE',
        }),
      }),
    )
    expect(client.nativeVenueDeploymentRelease.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-1', venueId: { in: ['venue-1'] } },
      }),
    )
    expect(client.aiUsageEvent.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { tenantId: 'tenant-1', venueId: { in: ['venue-1'] }, success: true },
      }),
    )
    expect(client.externalAccessCredential.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          clientId: 'tenant-1',
          venueId: { in: ['venue-1'] },
        }),
      }),
    )
  })

  it('does not hide a failed shared mailbox behind a newer healthy mailbox', async () => {
    const now = new Date('2030-01-01T12:00:00.000Z')
    const client = healthClient({
      correspondenceProviderAccount: {
        findMany: vi.fn().mockResolvedValue([
          {
            connectionStatus: 'CONNECTED',
            deliveryEnabled: true,
            lastSuccessfulSyncAt: now,
            lastHealthCheckAt: now,
            healthErrorCode: null,
          },
          {
            connectionStatus: 'CONNECTED',
            deliveryEnabled: false,
            lastSuccessfulSyncAt: null,
            lastHealthCheckAt: now,
            healthErrorCode: 'AUTH_REVOKED',
          },
        ]),
      },
    })

    const result = await readUnifiedIntegrationHealth(
      { clientId: 'tenant-1', venueIds: [] },
      client as never,
      now,
    )

    expect(result.integrations).toContainEqual(
      expect.objectContaining({
        integration: 'GMAIL',
        state: 'DEGRADED',
        configured: true,
        enabled: true,
        errorCategory: 'PROVIDER_ACCOUNT_HEALTH',
      }),
    )
    expect(JSON.stringify(result)).not.toContain('AUTH_REVOKED')
  })

  it('reports absent embedding evidence as not configured and honors central provider exclusions', async () => {
    const now = new Date('2030-01-01T12:00:00.000Z')
    const client = healthClient({
      aiUsageEvent: {
        findFirst: vi.fn().mockResolvedValueOnce({ createdAt: now }).mockResolvedValueOnce(null),
      },
      platformConfig: {
        findUnique: vi.fn().mockResolvedValue({
          value: {
            schemaVersion: 1,
            overrides: [
              {
                provider: 'anthropic',
                reason: 'Bounded outage drill',
                expiresAt: '2030-01-01T13:00:00.000Z',
              },
            ],
          },
          updatedAt: now,
          updatedBy: 'founder-1',
        }),
      },
    })

    const result = await readUnifiedIntegrationHealth(
      { clientId: 'tenant-1', venueIds: ['venue-1'] },
      client as never,
      now,
    )

    expect(result.integrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integration: 'AI_PROVIDERS',
          state: 'DEGRADED',
          enabled: true,
          errorCategory: 'HEALTH_OVERRIDE_ACTIVE',
        }),
        expect.objectContaining({
          integration: 'EMBEDDINGS',
          state: 'NOT_CONFIGURED',
          configured: false,
          enabled: false,
        }),
      ]),
    )
  })

  it('degrades bounded inventories instead of presenting truncated health as complete', async () => {
    const now = new Date('2030-01-01T12:00:00.000Z')
    const client = healthClient({
      agentWorker: {
        findMany: vi.fn().mockResolvedValue(
          Array.from({ length: 101 }, () => ({
            status: 'ONLINE',
            leaseExpiresAt: new Date('2030-01-01T13:00:00.000Z'),
            lastHeartbeatAt: now,
          })),
        ),
      },
      externalAccessCredential: {
        findMany: vi.fn().mockResolvedValue(
          Array.from({ length: 101 }, () => ({
            enabled: true,
            revokedAt: null,
            expiresAt: null,
            lastUsedAt: now,
          })),
        ),
      },
    })

    const result = await readUnifiedIntegrationHealth(
      { clientId: 'tenant-1', venueIds: [] },
      client as never,
      now,
    )

    expect(result.integrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integration: 'AGENT_RUNTIME',
          state: 'DEGRADED',
          errorCategory: 'INVENTORY_TRUNCATED',
        }),
        expect.objectContaining({
          integration: 'EXTERNAL_WORKER_ACCESS',
          state: 'DEGRADED',
          errorCategory: 'INVENTORY_TRUNCATED',
        }),
      ]),
    )
  })

  it('reports scoped storage proof and degrades the latest failed analytics pipeline', async () => {
    const now = new Date('2030-01-01T12:00:00.000Z')
    const client = healthClient({
      intakeUpload: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ updatedAt: new Date('2030-01-01T10:00:00.000Z') })
          .mockResolvedValueOnce({ updatedAt: new Date('2030-01-01T10:00:00.000Z') }),
      },
      intakeUploadVerificationReceipt: {
        findFirst: vi.fn().mockResolvedValue({
          recordedAt: new Date('2030-01-01T11:00:00.000Z'),
        }),
      },
      analyticsEvent: {
        findFirst: vi.fn().mockResolvedValue({ receivedAt: now }),
      },
      jobRecord: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({
            status: 'FAILED',
            startedAt: new Date('2030-01-01T11:50:00.000Z'),
            completedAt: new Date('2030-01-01T11:55:00.000Z'),
            failureDisposition: 'ATTEMPTS_EXHAUSTED',
          })
          .mockResolvedValueOnce({
            status: 'COMPLETE',
            startedAt: new Date('2030-01-01T11:40:00.000Z'),
            completedAt: new Date('2030-01-01T11:45:00.000Z'),
            failureDisposition: null,
          }),
      },
    })

    const result = await readUnifiedIntegrationHealth(
      { clientId: 'tenant-1', venueIds: ['venue-1'] },
      client as never,
      now,
    )

    expect(result.integrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integration: 'OBJECT_STORAGE',
          state: 'HEALTHY',
          lastSuccessAt: '2030-01-01T11:00:00.000Z',
        }),
        expect.objectContaining({
          integration: 'ANALYTICS_PIPELINE',
          state: 'DEGRADED',
          errorCategory: 'ATTEMPTS_EXHAUSTED',
        }),
      ]),
    )
    expect(JSON.stringify(result)).not.toContain('private-version-id')
    expect(client.intakeUpload.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          tenantId: 'tenant-1',
          venueId: { in: ['venue-1'] },
          storageVersionId: { not: null },
        },
        select: { updatedAt: true },
      }),
    )
    expect(client.intakeUploadVerificationReceipt.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-1', venueId: { in: ['venue-1'] } },
      }),
    )
    expect(client.analyticsEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-1', venueId: { in: ['venue-1'] } },
      }),
    )
  })

  it('degrades a stale analytics job without exposing its payload or error', async () => {
    const now = new Date('2030-01-01T12:00:00.000Z')
    const client = healthClient({
      jobRecord: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({
            status: 'RUNNING',
            startedAt: new Date('2030-01-01T11:00:00.000Z'),
            completedAt: null,
            failureDisposition: null,
          })
          .mockResolvedValueOnce(null),
      },
    })

    const result = await readUnifiedIntegrationHealth(
      { clientId: 'tenant-1', venueIds: [] },
      client as never,
      now,
    )

    expect(result.integrations).toContainEqual(
      expect.objectContaining({
        integration: 'ANALYTICS_PIPELINE',
        state: 'DEGRADED',
        enabled: false,
        errorCategory: 'STALE_JOB',
      }),
    )
  })
})

function healthClient(overrides: Record<string, unknown> = {}) {
  return {
    correspondenceProviderAccount: { findMany: vi.fn().mockResolvedValue([]) },
    billingAccount: { findUnique: vi.fn().mockResolvedValue(null) },
    agentWorker: { findMany: vi.fn().mockResolvedValue([]) },
    agentBridgeSession: { findMany: vi.fn().mockResolvedValue([]) },
    embeddingDispatch: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    embeddingWorkClaim: { findFirst: vi.fn().mockResolvedValue(null) },
    intakeUpload: { findFirst: vi.fn().mockResolvedValue(null) },
    intakeUploadVerificationReceipt: { findFirst: vi.fn().mockResolvedValue(null) },
    analyticsEvent: { findFirst: vi.fn().mockResolvedValue(null) },
    dailyRollup: { findFirst: vi.fn().mockResolvedValue(null) },
    jobRecord: { findFirst: vi.fn().mockResolvedValue(null) },
    nativeVenueDeploymentRelease: { findFirst: vi.fn().mockResolvedValue(null) },
    aiUsageEvent: { findFirst: vi.fn().mockResolvedValue(null) },
    externalAccessCredential: { findMany: vi.fn().mockResolvedValue([]) },
    platformConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    ...overrides,
  }
}
