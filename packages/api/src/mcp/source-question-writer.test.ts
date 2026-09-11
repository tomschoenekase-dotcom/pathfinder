import { describe, expect, it, vi } from 'vitest'

import {
  SourceQuestionWriterError,
  writeSourceClarificationQuestion,
} from './source-question-writer'

const receiptId = '11111111-1111-4111-8111-111111111111'
const hash = 'a'.repeat(64)
const sourceClarification = {
  runId: 'intake-run-1',
  receiptId,
  expectedExtractedTextHash: hash,
  fieldPath: 'knowledge.capacity',
  reason: 'CONTRADICTION' as const,
  blockerScope: 'FOUNDATIONAL' as const,
  evidenceExcerpt: 'The auditorium capacity is 137.',
}
const input = {
  clientId: 'tenant-1',
  venueId: 'venue-1',
  agentRunId: 'agent-run-1',
  agentIdentityId: 'identity-1',
  question: 'Which capacity is authoritative?',
  sourceClarification,
}
const context = {
  credential: {
    credentialId: 'credential-1',
    tenantId: 'tenant-1',
    clientId: 'tenant-1',
    venueIds: ['venue-1'],
    capabilities: ['questions:ask', 'intake-source:read', 'agent-runs:execute'],
  },
  executionClaim: {
    agentRunId: 'agent-run-1',
    bridgeSessionId: 'session-1',
    workerId: 'worker-1',
    executionLeaseToken: '22222222-2222-4222-8222-222222222222',
  },
}

function fixture(options: { receipt?: { extractedText: string } | null } = {}) {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    intakeFileExtractionReceipt: {
      findFirst: vi
        .fn()
        .mockResolvedValue(
          options.receipt === undefined
            ? { extractedText: 'The auditorium capacity is 137.' }
            : options.receipt,
        ),
    },
    agentIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'identity-1' }) },
  }
  const db = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
  }
  const claim = vi.fn().mockResolvedValue({
    agentIdentityId: 'identity-1',
    workerId: 'worker-1',
    credentialId: 'credential-1',
    bridgeSessionId: 'session-1',
  })
  const ask = vi.fn(async (_tx, _payload, options) => {
    // The canonical transaction action owns these two locks before its admission hook.
    await tx.$executeRaw('receipt-lock')
    await tx.$executeRaw('question-operation-lock')
    await options.admitQuestion(tx)
    return {
      question: {
        id: 'question-1',
        agentRunId: 'agent-run-1',
        status: 'PENDING',
        blocking: true,
        updatedAt: new Date('2030-01-01T12:00:00.000Z'),
        expiresAt: null,
      },
      replayed: false,
      consolidated: false,
    }
  })
  return { db, tx, claim, ask }
}

describe('source question writer', () => {
  it('uses the canonical transaction helper, whose locks precede current-worker admission', async () => {
    const { db, tx, claim, ask } = fixture()
    const result = await writeSourceClarificationQuestion(db as never, input, context as never, {
      assertCurrentAgentWorkerClaim: claim as never,
      askAgentQuestionActionInTransaction: ask as never,
    })

    expect(tx.$executeRaw).toHaveBeenCalledTimes(2)
    expect(tx.$executeRaw.mock.invocationCallOrder[1]).toBeLessThan(
      claim.mock.invocationCallOrder[0]!,
    )
    expect(claim).toHaveBeenCalledOnce()
    expect(tx.agentIdentity.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'identity-1',
          accessCapabilities: { has: 'content.draft' },
        }),
      }),
    )
    expect(claim).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        requiredAgentType: 'CONTENT',
        requiredIdentityCapability: 'intake.read',
        requiredTransportCapabilities: ['questions:ask', 'intake-source:read'],
        actionClass: 'OPERATOR_QUESTION',
      }),
    )
    expect(ask).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        agentIdentityId: 'identity-1',
        agentRunId: 'agent-run-1',
        blocking: true,
        callbackMetadata: expect.objectContaining({
          extractedTextHash: hash,
          blockerScope: 'FOUNDATIONAL',
        }),
      }),
      expect.anything(),
    )
    expect(result.replayed).toBe(false)
  })

  it('requires source, question, and execution transport grants before a transaction', async () => {
    const { db, claim, ask } = fixture()
    await expect(
      writeSourceClarificationQuestion(
        db as never,
        input,
        {
          ...context,
          credential: {
            ...context.credential,
            capabilities: ['questions:ask', 'agent-runs:execute'],
          },
        } as never,
        {
          assertCurrentAgentWorkerClaim: claim as never,
          askAgentQuestionActionInTransaction: ask as never,
        },
      ),
    ).rejects.toBeInstanceOf(SourceQuestionWriterError)
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(claim).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
  })

  it('rechecks exact successful unreviewed evidence in the write transaction', async () => {
    const missing = fixture({ receipt: null })
    await expect(
      writeSourceClarificationQuestion(missing.db as never, input, context as never, {
        assertCurrentAgentWorkerClaim: missing.claim as never,
        askAgentQuestionActionInTransaction: missing.ask as never,
      }),
    ).rejects.toBeInstanceOf(SourceQuestionWriterError)
    expect(missing.ask).toHaveBeenCalledOnce()

    const mismatch = fixture({ receipt: { extractedText: 'A different retained source.' } })
    await expect(
      writeSourceClarificationQuestion(mismatch.db as never, input, context as never, {
        assertCurrentAgentWorkerClaim: mismatch.claim as never,
        askAgentQuestionActionInTransaction: mismatch.ask as never,
      }),
    ).rejects.toBeInstanceOf(SourceQuestionWriterError)
    expect(mismatch.ask).toHaveBeenCalledOnce()
  })

  it('rejects a caller identity that does not match the admitted current worker', async () => {
    const { db, claim, ask } = fixture()
    claim.mockResolvedValueOnce({
      agentIdentityId: 'another-identity',
      workerId: 'worker-1',
      credentialId: 'credential-1',
      bridgeSessionId: 'session-1',
    })
    await expect(
      writeSourceClarificationQuestion(db as never, input, context as never, {
        assertCurrentAgentWorkerClaim: claim as never,
        askAgentQuestionActionInTransaction: ask as never,
      }),
    ).rejects.toBeInstanceOf(SourceQuestionWriterError)
  })

  it('checks content draft authority under the admitted identity lock', async () => {
    const { db, tx, claim, ask } = fixture()
    tx.agentIdentity.findFirst.mockResolvedValueOnce(null)
    await expect(
      writeSourceClarificationQuestion(db as never, input, context as never, {
        assertCurrentAgentWorkerClaim: claim as never,
        askAgentQuestionActionInTransaction: ask as never,
      }),
    ).rejects.toBeInstanceOf(SourceQuestionWriterError)
    expect(tx.intakeFileExtractionReceipt.findFirst).not.toHaveBeenCalled()
  })

  it('requires current authority even when the canonical action replays', async () => {
    const { db, claim, ask } = fixture()
    claim.mockRejectedValueOnce(new Error('expired lease'))
    await expect(
      writeSourceClarificationQuestion(db as never, input, context as never, {
        assertCurrentAgentWorkerClaim: claim as never,
        askAgentQuestionActionInTransaction: ask as never,
      }),
    ).rejects.toBeInstanceOf(SourceQuestionWriterError)
    expect(ask).toHaveBeenCalledOnce()
    expect(claim).toHaveBeenCalledOnce()
  })
})
