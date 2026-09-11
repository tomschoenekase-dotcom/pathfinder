import { describe, expect, it, vi } from 'vitest'
import {
  dispatchIntakeSourceAgentTask,
  listPendingIntakeSourceAgentDispatches,
} from './intake-source-agent-dispatch-actions'
const scope = { id: 'ac3bd721-426c-4fdb-ae76-cf8d4c3ee410', tenantId: 'tenant', venueId: 'venue' }
function fixture(status = 'PENDING') {
  const row = {
    ...scope,
    status,
    receiptId: 'receipt',
    agentRunId: status === 'COMPLETED' ? 'run' : null,
    intakeRunId: 'intake',
    extractedTextHash: 'a'.repeat(64),
    extractionDispatchId: 'extraction',
  }
  const tx = {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([{ now: new Date('2026-09-10T00:00:00Z') }]),
    intakeSourceAgentDispatch: {
      findFirstOrThrow: vi.fn().mockResolvedValue(row),
      update: vi.fn(),
    },
    intakeFileExtractionReceipt: { findFirst: vi.fn().mockResolvedValue({ id: 'receipt' }) },
    intakeV1ProcessingDispatch: { findFirst: vi.fn().mockResolvedValue({ id: 'extraction' }) },
    intakeSourceAgentRoutingPolicy: { findFirst: vi.fn().mockResolvedValue(null) },
    agentIdentity: { findFirst: vi.fn().mockResolvedValue(null) },
  }
  return {
    tx,
    client: {
      intakeSourceAgentDispatch: { findFirst: vi.fn().mockResolvedValue(row) },
      $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx),
    },
  }
}
describe('durable source task dispatch boundaries', () => {
  it('rejects malformed or foreign scope before mutation', async () => {
    const { client } = fixture()
    client.intakeSourceAgentDispatch.findFirst.mockResolvedValue(null as never)
    await expect(dispatchIntakeSourceAgentTask(scope, client as never)).rejects.toThrow(
      'unavailable',
    )
    expect(client.intakeSourceAgentDispatch.findFirst).toHaveBeenCalledWith({ where: scope })
  })
  it('recovers completed task without reassigning under changed source/policy', async () => {
    const { tx, client } = fixture('COMPLETED')
    await expect(dispatchIntakeSourceAgentTask(scope, client as never)).resolves.toEqual({
      status: 'COMPLETED',
      runId: 'run',
      replayed: true,
    })
    expect(tx.intakeFileExtractionReceipt.findFirst).not.toHaveBeenCalled()
    expect(tx.intakeSourceAgentRoutingPolicy.findFirst).not.toHaveBeenCalled()
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2)
  })
  it.each([
    ['missing', null, 'ROUTING_UNCONFIGURED'],
    ['disabled', { enabled: false }, 'ROUTING_DISABLED'],
    ['identity revoked', { enabled: true, agentIdentityId: 'content' }, 'IDENTITY_UNAVAILABLE'],
  ])('holds %s routing without creating a task', async (_label, policy, reason) => {
    const { tx, client } = fixture()
    tx.intakeSourceAgentRoutingPolicy.findFirst.mockResolvedValue(policy as never)
    await expect(dispatchIntakeSourceAgentTask(scope, client as never)).resolves.toEqual({
      status: 'HELD',
    })
    expect(tx.intakeSourceAgentDispatch.update).toHaveBeenCalledWith({
      where: scope,
      data: { status: 'HELD', holdReason: reason, nextAttemptAt: new Date('2026-09-10T00:01:00Z') },
    })
  })
  it('cancels stale source without inspecting routing', async () => {
    const { tx, client } = fixture()
    tx.intakeFileExtractionReceipt.findFirst.mockResolvedValue(null as never)
    await expect(dispatchIntakeSourceAgentTask(scope, client as never)).resolves.toEqual({
      status: 'CANCELLED',
    })
    expect(tx.intakeSourceAgentRoutingPolicy.findFirst).not.toHaveBeenCalled()
  })
  it('bounds discovery before querying', async () => {
    const client = { $queryRaw: vi.fn() }
    await expect(
      listPendingIntakeSourceAgentDispatches({ limit: 101 }, client as never),
    ).rejects.toThrow()
    expect(client.$queryRaw).not.toHaveBeenCalled()
  })
})
