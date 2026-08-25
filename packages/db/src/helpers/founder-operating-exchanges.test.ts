import { describe, expect, it, vi } from 'vitest'

import {
  FounderOperatingExchangeError,
  listFounderOperatingExchanges,
  recordFounderOperatingExchange,
} from './founder-operating-exchanges'

const input = {
  operationId: '11111111-1111-4111-8111-111111111111',
  operatorUserId: 'founder_1',
  prompt: 'What needs my decision?',
  intent: 'DECISIONS' as const,
  disposition: 'ANSWERED' as const,
  responseTitle: 'No visible founder decisions',
  responseBody: 'No pending questions or approvals are visible in this bounded snapshot.',
  evidence: [],
  snapshot: {
    schemaVersion: 1 as const,
    generatedAt: '2026-08-25T12:00:00.000Z',
    boundedSnapshot: { limit: 10, hasMore: false },
    metrics: {
      decisions: 0,
      criticalRisks: 0,
      workingAgents: 0,
      blockedAgents: 0,
      customerItems: 0,
    },
    changesSinceLastReview: {
      criticalRisks: 0,
      decisions: 0,
      completedAgents: 0,
      outcomes: 0,
      customerItems: 0,
    },
    operatingCosts: {
      windowDays: 30,
      knownOperatingCostUsd: '0.00000000',
      priorKnownOperatingCostUsd: '0.00000000',
      changeUsd: '0.00000000',
      coverageComplete: false,
      anomalyThreshold: 'UNRESOLVED' as const,
    },
    authority: {
      canExecute: false as const,
      canApprove: false as const,
      canContactCustomers: false as const,
      canChangePricing: false as const,
      canSpendMoney: false as const,
      canMutatePolicy: false as const,
    },
  },
}

function fixture(existing: Record<string, unknown> | null = null) {
  const exchange = {
    findUnique: vi.fn().mockResolvedValue(existing),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'exchange_1',
      ...data,
      createdAt: new Date('2026-08-25T12:00:01.000Z'),
    })),
    findFirst: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
  }
  const transaction = {
    founderOperatingExchange: exchange,
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
  }
  return {
    exchange,
    transaction,
    client: {
      founderOperatingExchange: exchange,
      $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    },
  }
}

describe('founder operating exchange actions', () => {
  it('records an immutable answer hash and a strict bounded audit entry', async () => {
    const { client, exchange, transaction } = fixture()
    const result = await recordFounderOperatingExchange(input, client as never)
    expect(result).toMatchObject({ replayed: false, exchange: { id: 'exchange_1' } })
    expect(exchange.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ snapshotHash: expect.stringMatching(/^[0-9a-f]{64}$/u) }),
      }),
    )
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'founder-operating-exchange.recorded',
        afterState: expect.objectContaining({
          disposition: 'ANSWERED',
          authority: expect.objectContaining({ canExecute: false, canApprove: false }),
        }),
      }),
    })
    expect(JSON.stringify(transaction.auditLog.create.mock.calls)).not.toContain(input.prompt)
  })

  it('rejects a directive disguised as an answered request before a transaction', async () => {
    const { client } = fixture()
    await expect(
      recordFounderOperatingExchange(
        { ...input, intent: 'DIRECTIVE', disposition: 'ANSWERED' },
        client as never,
      ),
    ).rejects.toMatchObject({ name: 'ZodError' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('replays the same operation and rejects reuse by different work', async () => {
    const existing = {
      id: 'exchange_1',
      ...input,
      snapshotHash: 'a'.repeat(64),
      createdAt: new Date('2026-08-25T12:00:01.000Z'),
    }
    const replay = fixture(existing)
    await expect(
      recordFounderOperatingExchange(input, replay.client as never),
    ).resolves.toMatchObject({
      replayed: true,
      exchange: { id: 'exchange_1' },
    })
    expect(replay.exchange.create).not.toHaveBeenCalled()

    const conflict = fixture(existing)
    await expect(
      recordFounderOperatingExchange(
        { ...input, prompt: 'Different work' },
        conflict.client as never,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<FounderOperatingExchangeError>>({ code: 'CONFLICT' }),
    )
  })

  it('reconciles a concurrent exact create after the unique fence wins elsewhere', async () => {
    const existing = {
      id: 'exchange_1',
      ...input,
      snapshotHash: 'a'.repeat(64),
      createdAt: new Date('2026-08-25T12:00:01.000Z'),
    }
    const concurrent = fixture()
    concurrent.exchange.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(existing)
    concurrent.exchange.create.mockRejectedValueOnce({ code: 'P2002' })

    await expect(
      recordFounderOperatingExchange(input, concurrent.client as never),
    ).resolves.toMatchObject({ replayed: true, exchange: { id: 'exchange_1' } })
    expect(concurrent.transaction.auditLog.create).not.toHaveBeenCalled()
  })

  it('bounds the platform conversation history', async () => {
    const { client, exchange } = fixture()
    await listFounderOperatingExchanges(500, client as never)
    expect(exchange.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
    )
  })
})
