import { describe, expect, it, vi } from 'vitest'

import {
  expireAgentQuestionIfDue,
  expireAgentQuestionsAction,
} from './agent-question-expiration-actions'

const scope = { tenantId: 'tenant-1', venueId: 'venue-1', questionId: 'question-1' }
const expiresAt = new Date('2026-09-08T12:00:00.000Z')
const now = new Date('2026-09-08T12:00:01.000Z')

function transaction(responses: unknown[]) {
  return {
    $queryRaw: vi.fn().mockImplementation(() => Promise.resolve(responses.shift())),
    agentQuestion: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'timeline-1' }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
  }
}

describe('agent question expiration actions', () => {
  it('locks a linked run before its question and expires with one timeline and audit', async () => {
    const tx = transaction([
      [{ agentRunId: 'run-1' }],
      [{ id: 'run-1' }],
      [{ id: scope.questionId }],
      [{ status: 'PENDING', expiresAt, now, agentRunId: 'run-1' }],
    ])

    await expect(expireAgentQuestionIfDue(tx as never, scope)).resolves.toBe('EXPIRED')
    const sql = tx.$queryRaw.mock.calls.map(([query]) => (query as TemplateStringsArray).join(' '))
    expect(sql[1]).toContain('FROM agent_runs')
    expect(sql[2]).toContain('FROM agent_questions')
    expect(tx.agentQuestion.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.agentTimelineEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: 'QUESTION_EXPIRED', agentRunId: 'run-1' }),
    })
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'agent-question.expired' }),
    })
  })

  it('leaves a future deadline unchanged', async () => {
    const tx = transaction([
      [{ agentRunId: null }],
      [{ id: scope.questionId }],
      [{ status: 'PENDING', expiresAt: new Date(now.getTime() + 1), now, agentRunId: null }],
    ])
    await expect(expireAgentQuestionIfDue(tx as never, scope)).resolves.toBe('NOT_DUE')
    expect(tx.agentQuestion.updateMany).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('returns an idempotent expired result without duplicate evidence', async () => {
    const tx = transaction([
      [{ agentRunId: null }],
      [{ id: scope.questionId }],
      [{ status: 'EXPIRED', expiresAt, now, agentRunId: null }],
    ])
    await expect(expireAgentQuestionIfDue(tx as never, scope)).resolves.toBe('EXPIRED')
    expect(tx.agentQuestion.updateMany).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('reports a contended linked run as skipped before locking the question', async () => {
    const tx = transaction([[{ agentRunId: 'run-1' }], []])
    await expect(expireAgentQuestionIfDue(tx as never, scope, { skipLocked: true })).resolves.toBe(
      'SKIPPED',
    )
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2)
    expect(tx.agentQuestion.updateMany).not.toHaveBeenCalled()
  })

  it('bounds the candidate scan and counts an already-expired race as skipped', async () => {
    const candidates = [
      { id: 'question-1', tenantId: 'tenant-1', venueId: 'venue-1' },
      { id: 'question-2', tenantId: 'tenant-1', venueId: 'venue-1' },
    ]
    const first = transaction([
      [{ agentRunId: null }],
      [{ id: 'question-1' }],
      [{ status: 'EXPIRED', expiresAt, now, agentRunId: null }],
    ])
    const second = transaction([
      [{ agentRunId: null }],
      [{ id: 'question-2' }],
      [{ status: 'PENDING', expiresAt, now, agentRunId: null }],
    ])
    const transactions = [first, second]
    const client = {
      $queryRaw: vi.fn().mockResolvedValue(candidates),
      $transaction: vi.fn((callback: (tx: never) => unknown) =>
        callback(transactions.shift() as never),
      ),
    }
    await expect(expireAgentQuestionsAction({ limit: 1 }, client as never)).resolves.toEqual({
      scanned: 2,
      expired: 1,
      skipped: 1,
    })
    const [query] = client.$queryRaw.mock.calls[0] as [TemplateStringsArray, number]
    expect(query.join(' ')).toContain('ORDER BY expires_at ASC, id ASC')
    expect(client.$queryRaw.mock.calls[0]?.[1]).toBe(4)
  })

  it('rejects an out-of-range batch before querying', async () => {
    const client = { $queryRaw: vi.fn(), $transaction: vi.fn() }
    await expect(expireAgentQuestionsAction({ limit: 101 }, client as never)).rejects.toThrow()
    expect(client.$queryRaw).not.toHaveBeenCalled()
  })
})
