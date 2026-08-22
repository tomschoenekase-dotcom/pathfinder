import { describe, expect, it, vi } from 'vitest'

import {
  claimNextProspectResearchJobAction,
  finishProspectResearchJobAction,
} from './prospect-research-job-actions'

const context = {
  agentRunId: 'run-1',
  agentIdentityId: 'agent-1',
  territoryIds: ['territory-1'],
  modelProvider: 'provider-1',
  modelName: 'model-1',
  promptIdentity: 'prompt-v1',
}

describe('prospect research leases', () => {
  it('reclaims an expired claim and records an append-only attempt', async () => {
    const tx = {
      prospectResearchJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'job-1',
          claimToken: 'old-token',
          organization: { id: 'organization-1' },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      prospectResearchAttempt: {
        updateMany: vi.fn(),
        create: vi.fn().mockResolvedValue({ id: 'attempt-2' }),
      },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    const result = await claimNextProspectResearchJobAction(
      { context, now: new Date('2026-08-22T15:00:00.000Z'), leaseSeconds: 300 },
      client as never,
    )
    expect(result).toMatchObject({ jobId: 'job-1', attemptId: 'attempt-2' })
    expect(tx.prospectResearchAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'EXPIRED' }) }),
    )
    expect(tx.prospectResearchAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ agentRunId: 'run-1' }) }),
    )
  })

  it('records a bounded terminal outcome only for the live owning run', async () => {
    const tx = {
      prospectResearchJob: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'job-1',
          status: 'CLAIMED',
          claimOwnerId: 'agent-1',
          claimAgentRunId: 'run-1',
          claimExpiresAt: new Date('2026-08-22T15:10:00.000Z'),
        }),
        update: vi.fn().mockResolvedValue({ id: 'job-1', status: 'CAP_REACHED' }),
      },
      prospectResearchAttempt: { update: vi.fn() },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    await expect(
      finishProspectResearchJobAction(
        {
          claimToken: crypto.randomUUID(),
          outcome: 'CAP_REACHED',
          reason: 'No official email found within the bounded search cap',
          usage: { searches: 4 },
          costUsd: 0,
          context,
          now: new Date('2026-08-22T15:05:00.000Z'),
        },
        client as never,
      ),
    ).resolves.toMatchObject({ status: 'CAP_REACHED' })
    expect(tx.prospectResearchAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ outcome: 'CAP_REACHED' }) }),
    )
  })

  it('rejects stale completion after another run owns the job', async () => {
    const tx = {
      prospectResearchJob: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'job-1',
          status: 'CLAIMED',
          claimOwnerId: 'agent-2',
          claimAgentRunId: 'run-2',
          claimExpiresAt: new Date('2026-08-22T15:10:00.000Z'),
        }),
      },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    await expect(
      finishProspectResearchJobAction(
        {
          claimToken: crypto.randomUUID(),
          outcome: 'RESEARCHED',
          reason: 'Done',
          context,
          now: new Date('2026-08-22T15:05:00.000Z'),
        },
        client as never,
      ),
    ).rejects.toThrow(/not owned by this run/i)
  })
})
