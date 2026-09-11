import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AgentQuestionDiscussionActionError,
  appendAgentQuestionDiscussionAction,
} from './agent-question-discussion-actions'

const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const createdAt = new Date('2026-09-08T18:00:00.000Z')
const input = {
  operationId,
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  questionId: 'question-1',
  body: 'The east greenhouse is the one discussed in the receipt.',
  actor: { actorType: 'HUMAN' as const, actorId: 'admin-1', auditRole: 'PLATFORM_ADMIN' as const },
}

function harness() {
  const message = {
    id: 'discussion-1',
    tenantId: input.tenantId,
    venueId: input.venueId,
    questionId: input.questionId,
    authorId: input.actor.actorId,
    body: input.body,
    createdAt,
  }
  const tx = {
    agentQuestion: { findFirst: vi.fn().mockResolvedValue({ id: input.questionId }) },
    agentQuestionDiscussionMessage: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(message),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
  }
  const client = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
  }
  return { tx, client, message }
}

describe('agent question discussion actions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('appends human context and audits it without changing question or run state', async () => {
    const { tx, client, message } = harness()
    await expect(appendAgentQuestionDiscussionAction(input, client as never)).resolves.toEqual({
      message,
      replayed: false,
    })
    expect(tx.agentQuestionDiscussionMessage.create).toHaveBeenCalledWith({
      data: {
        operationId,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        questionId: 'question-1',
        authorId: 'admin-1',
        body: input.body,
      },
      select: expect.any(Object),
    })
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1)
    expect(tx).not.toHaveProperty('agentRun')
    expect(tx).not.toHaveProperty('agentMessage')
    expect(tx).not.toHaveProperty('approvalRequest')
  })

  it('exactly replays once without a second insert or audit', async () => {
    const { tx, client, message } = harness()
    tx.agentQuestionDiscussionMessage.findFirst.mockResolvedValue(message)
    await expect(appendAgentQuestionDiscussionAction(input, client as never)).resolves.toEqual({
      message,
      replayed: true,
    })
    expect(tx.agentQuestionDiscussionMessage.create).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it.each([
    ['body', { body: 'Different context.' }],
    ['question', { questionId: 'question-2' }],
    ['venue', { venueId: 'venue-2' }],
    ['actor', { actor: { ...input.actor, actorId: 'admin-2' } }],
  ])('rejects operation replay with changed %s', async (_label, change) => {
    const { tx, client, message } = harness()
    tx.agentQuestion.findFirst.mockResolvedValue({
      id: (change as { questionId?: string }).questionId ?? input.questionId,
    })
    tx.agentQuestionDiscussionMessage.findFirst.mockResolvedValue(message)
    await expect(
      appendAgentQuestionDiscussionAction({ ...input, ...change }, client as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('rejects a wrong scoped question before reading an operation replay', async () => {
    const { tx, client } = harness()
    tx.agentQuestion.findFirst.mockResolvedValue(null)
    await expect(appendAgentQuestionDiscussionAction(input, client as never)).rejects.toMatchObject(
      {
        code: 'NOT_FOUND',
      },
    )
    expect(tx.agentQuestionDiscussionMessage.findFirst).not.toHaveBeenCalled()
  })

  it('retries a unique race and converges on the one durable message', async () => {
    const { tx, client, message } = harness()
    tx.agentQuestionDiscussionMessage.create.mockRejectedValueOnce({ code: 'P2002' })
    tx.agentQuestionDiscussionMessage.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(message)
    await expect(appendAgentQuestionDiscussionAction(input, client as never)).resolves.toEqual({
      message,
      replayed: true,
    })
    expect(client.$transaction).toHaveBeenCalledTimes(2)
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('validates trimmed, bounded human content before opening a transaction', async () => {
    const { client } = harness()
    await expect(
      appendAgentQuestionDiscussionAction({ ...input, body: ' '.repeat(10) }, client as never),
    ).rejects.toBeInstanceOf(AgentQuestionDiscussionActionError)
    expect(client.$transaction).not.toHaveBeenCalled()
  })
})
