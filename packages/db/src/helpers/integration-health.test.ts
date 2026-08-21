import { describe, expect, it, vi } from 'vitest'

import { readUnifiedIntegrationHealth } from './integration-health'

describe('unified integration health', () => {
  it('returns bounded secret-free status from canonical scoped evidence', async () => {
    const now = new Date('2030-01-01T12:00:00.000Z')
    const client = {
      correspondenceProviderAccount: {
        findFirst: vi.fn().mockResolvedValue({
          connectionStatus: 'CONNECTED',
          deliveryEnabled: false,
          lastSuccessfulSyncAt: new Date('2030-01-01T11:00:00.000Z'),
          lastHealthCheckAt: now,
          healthErrorCode: null,
        }),
      },
      billingAccount: { findUnique: vi.fn().mockResolvedValue(null) },
      agentWorker: {
        findMany: vi
          .fn()
          .mockResolvedValue([
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
      expect.objectContaining({ where: { clientId: 'tenant-1', status: { not: 'REVOKED' } } }),
    )
  })
})
