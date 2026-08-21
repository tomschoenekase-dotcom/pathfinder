import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getCompactAccountContext } from './account-context'
import { refreshAccountSummaryAction } from './account-summary-actions'

vi.mock('./account-context', () => ({ getCompactAccountContext: vi.fn() }))

const context = {
  identity: {
    organizationId: 'org_1',
    canonicalName: 'Museum Y',
    organizationType: 'MUSEUM',
    lifecycle: 'CUSTOMER',
    clientStatus: 'ACTIVE',
    relationshipTier: 'ACTIVE_CLIENT',
    tenantId: 'tenant_1',
    tenantName: 'Museum Y',
    tenantStatus: 'ACTIVE',
    venueCount: 1,
    primaryLocation: { city: 'Chicago', region: 'IL', country: 'US' },
    provenance: { kind: 'DETERMINISTIC', source: 'ProspectCustomerRelationship' },
  },
  contacts: {
    primaryContactId: 'contact_1',
    items: [
      {
        id: 'contact_1',
        name: 'Jane Curator',
        role: 'Director',
        email: 'jane@example.test',
        phone: null,
        preferredCommunication: 'EMAIL',
        suppressed: false,
        suppressionReason: null,
        lastUpdatedAt: '2030-01-01T12:00:00.000Z',
        provenance: { kind: 'DETERMINISTIC', source: 'ProspectContact' },
      },
    ],
  },
  commercial: { planTier: 'STARTER', billing: null, agreements: [], opportunity: null },
  operations: {
    venues: [
      {
        id: 'venue_1',
        name: 'Museum Y',
        category: 'MUSEUM',
        active: true,
        secondLayerEnabled: false,
        onboarding: null,
        openSupportCount: 1,
        updatedAt: '2030-01-01T12:00:00.000Z',
      },
    ],
    openSupport: [],
  },
  openLoops: [{ id: 'loop_1', title: 'Upload map' }],
  commitments: [],
  warnings: [],
} as unknown as Awaited<ReturnType<typeof getCompactAccountContext>>

function harness() {
  const tx = {
    accountSummary: {
      findFirst: vi.fn().mockResolvedValue(null),
      aggregate: vi.fn().mockResolvedValue({ _max: { version: 2 } }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({
        id: 'summary_3',
        version: 3,
        inputDigest: 'digest',
        summary: 'Museum Y summary',
      }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
  }
  const client = {
    prospectOrganization: { findFirst: vi.fn() },
    $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
  }
  return { tx, client: client as never }
}

describe('account summary refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCompactAccountContext).mockResolvedValue(context)
  })

  it('refreshes from a deterministic bounded projection and supersedes the prior current row', async () => {
    const { tx, client } = harness()
    tx.accountSummary.findFirst.mockResolvedValue({
      id: 'summary_2',
      version: 2,
      inputDigest: 'old',
      summary: 'Old summary',
    })
    const result = await refreshAccountSummaryAction(
      {
        clientId: 'tenant_1',
        organizationId: 'org_1',
        actor: { type: 'SYSTEM', actorId: 'summary-worker', role: 'SYSTEM', systemJobId: 'job_1' },
      },
      client,
    )
    expect(result.replayed).toBe(false)
    expect(tx.accountSummary.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'SUPERSEDED' } }),
    )
    expect(tx.accountSummary.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          version: 3,
          status: 'CURRENT',
          generatedByType: 'SYSTEM',
          confidence: 1,
        }),
      }),
    )
    expect(tx.auditLog.create).toHaveBeenCalled()
  })

  it('rejects a machine actor without the refresh capability before reading account state', async () => {
    await expect(
      refreshAccountSummaryAction(
        {
          clientId: 'tenant_1',
          organizationId: 'org_1',
          actor: {
            type: 'AGENT',
            actorId: 'agent_1',
            role: 'AGENT',
            agentIdentityId: 'agent_1',
            agentRunId: 'run_1',
            workerId: 'worker_1',
            credentialId: 'credential_1',
            capability: 'accounts.read',
          },
        },
        harness().client,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(getCompactAccountContext).not.toHaveBeenCalled()
  })
})
