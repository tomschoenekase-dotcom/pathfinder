import { describe, expect, it, vi } from 'vitest'

import type { McpReadInput, VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'

import { QuestionSourceReaderError, readQuestionBoundSource } from './question-source-reader'

const receiptId = '11111111-1111-4111-8111-111111111111'
const hash = 'a'.repeat(64)
const metadata = {
  workflow: 'intake-file-extraction-clarification',
  runId: 'intake-run-1',
  receiptId,
  extractedTextHash: hash,
  agentRunId: 'agent-run-1',
}

const credential: VerifiedMcpCredentialScope = {
  credentialId: 'credential-1',
  tenantId: 'tenant-1',
  clientId: 'tenant-1',
  venueIds: ['venue-1'],
  capabilities: ['resources:read', 'intake-source:read', 'agent-runs:execute'],
}

const input: McpReadInput = {
  resource: 'question-source',
  clientId: 'tenant-1',
  venueId: 'venue-1',
  agentRunId: 'agent-run-1',
  questionId: 'question-1',
  limit: 25,
}

const context = {
  credential,
  executionClaim: {
    agentRunId: 'agent-run-1',
    bridgeSessionId: 'session-1',
    workerId: 'worker-1',
    executionLeaseToken: '22222222-2222-4222-8222-222222222222',
  },
}

function fixture(
  options: {
    firstMetadata?: unknown
    lockedQuestion?: { callbackMetadata: unknown } | null
    receipt?: { id: string } | null
  } = {},
) {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    agentQuestion: {
      findFirst: vi
        .fn()
        .mockResolvedValue(
          options.lockedQuestion === undefined
            ? { callbackMetadata: metadata }
            : options.lockedQuestion,
        ),
    },
    intakeFileExtractionReceipt: {
      findFirst: vi
        .fn()
        .mockResolvedValue(options.receipt === undefined ? { id: receiptId } : options.receipt),
    },
  }
  const db = {
    agentQuestion: {
      findFirst: vi.fn().mockResolvedValue({ callbackMetadata: options.firstMetadata ?? metadata }),
    },
    $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
  }
  const assertClaim = vi.fn().mockResolvedValue({
    agentIdentityId: 'identity-1',
    workerId: 'worker-1',
    credentialId: 'credential-1',
    bridgeSessionId: 'session-1',
  })
  const readSource = vi.fn().mockResolvedValue({
    extractedTextHash: hash,
    extractedCharacterCount: 5_050,
    extractedLineCount: 50,
    page: { offset: 4_000, limit: 1_050, text: 'capacity 137', matchOffsets: [9] },
    nextCursor: null,
  })
  return { db, tx, assertClaim, readSource }
}

describe('question-bound source reader', () => {
  it('requires an execution claim for the exact requested run', async () => {
    const { db } = fixture()
    await expect(
      readQuestionBoundSource(db as never, input, { credential }, {}),
    ).rejects.toBeInstanceOf(QuestionSourceReaderError)
    await expect(
      readQuestionBoundSource(
        db as never,
        input,
        { ...context, executionClaim: { ...context.executionClaim, agentRunId: 'other-run' } },
        {},
      ),
    ).rejects.toBeInstanceOf(QuestionSourceReaderError)
    expect(db.agentQuestion.findFirst).not.toHaveBeenCalled()
  })

  it('rejects missing direct-service grants before lookup or injected claim admission', async () => {
    const { db, assertClaim } = fixture()
    await expect(
      readQuestionBoundSource(
        db as never,
        input,
        {
          ...context,
          credential: { ...credential, capabilities: ['resources:read', 'agent-runs:execute'] },
        },
        { assertCurrentAgentWorkerClaim: assertClaim },
      ),
    ).rejects.toBeInstanceOf(QuestionSourceReaderError)
    expect(db.agentQuestion.findFirst).not.toHaveBeenCalled()
    expect(assertClaim).not.toHaveBeenCalled()
  })

  it('asks the canonical validator for distinct identity and transport grants', async () => {
    const { db, assertClaim, readSource } = fixture()
    assertClaim.mockRejectedValueOnce(new Error('missing grant'))
    await expect(
      readQuestionBoundSource(db as never, input, context, {
        assertCurrentAgentWorkerClaim: assertClaim as never,
        readIntakeFileExtractionSource: readSource,
      }),
    ).rejects.toBeInstanceOf(QuestionSourceReaderError)
    expect(assertClaim).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        requiredAgentType: 'CONTENT',
        requiredIdentityCapability: 'intake.read',
        requiredTransportCapabilities: ['resources:read', 'intake-source:read'],
      }),
    )
    expect(readSource).not.toHaveBeenCalled()
  })

  it.each([
    [
      'an arbitrary workflow',
      { ...metadata, workflow: 'arbitrary-url', sourceUrl: 'https://x.test' },
    ],
    ['another run locator', { ...metadata, agentRunId: 'agent-run-2' }],
  ])('rejects %s before acquiring authority locks', async (_label, firstMetadata) => {
    const { db, assertClaim } = fixture({ firstMetadata })
    await expect(
      readQuestionBoundSource(db as never, input, context, {
        assertCurrentAgentWorkerClaim: assertClaim,
      }),
    ).rejects.toBeInstanceOf(QuestionSourceReaderError)
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(assertClaim).not.toHaveBeenCalled()
  })

  it('locks source review before claim admission and rejects an identity-mismatched question', async () => {
    const { db, tx, assertClaim, readSource } = fixture({ lockedQuestion: null })
    await expect(
      readQuestionBoundSource(db as never, input, context, {
        assertCurrentAgentWorkerClaim: assertClaim,
        readIntakeFileExtractionSource: readSource,
      }),
    ).rejects.toBeInstanceOf(QuestionSourceReaderError)
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      assertClaim.mock.invocationCallOrder[0]!,
    )
    expect(tx.agentQuestion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          agentIdentityId: 'identity-1',
          agentRunId: 'agent-run-1',
        }),
      }),
    )
    expect(readSource).not.toHaveBeenCalled()
  })

  it('rejects reviewed receipts and stale canonical source reads without returning text', async () => {
    const reviewed = fixture({ receipt: null })
    await expect(
      readQuestionBoundSource(reviewed.db as never, input, context, {
        assertCurrentAgentWorkerClaim: reviewed.assertClaim,
        readIntakeFileExtractionSource: reviewed.readSource,
      }),
    ).rejects.toBeInstanceOf(QuestionSourceReaderError)
    expect(reviewed.readSource).not.toHaveBeenCalled()

    const stale = fixture()
    stale.readSource.mockRejectedValueOnce(new Error('source hash changed'))
    await expect(
      readQuestionBoundSource(stale.db as never, input, context, {
        assertCurrentAgentWorkerClaim: stale.assertClaim,
        readIntakeFileExtractionSource: stale.readSource,
      }),
    ).rejects.toBeInstanceOf(QuestionSourceReaderError)
  })

  it('forwards bounded pagination and returns only safe page metadata and text', async () => {
    const { db, assertClaim, readSource } = fixture()
    const response = await readQuestionBoundSource(
      db as never,
      { ...input, sourceCursor: 'source-cursor', pageSize: 1_050, search: 'capacity' },
      context,
      {
        assertCurrentAgentWorkerClaim: assertClaim,
        readIntakeFileExtractionSource: readSource,
      },
    )
    expect(readSource).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 'source-cursor', pageSize: 1_050, search: 'capacity' }),
      expect.anything(),
    )
    expect(response.data).toMatchObject({
      questionId: 'question-1',
      agentRunId: 'agent-run-1',
      page: { text: 'capacity 137' },
      nextSourceCursor: null,
    })
    expect(response.data).not.toHaveProperty('receiptId')
    expect(JSON.stringify(response)).not.toContain('sourceUrl')
    expect(JSON.stringify(response)).not.toContain('credential-1')
  })
})

describe('assigned source reader', () => {
  const sourceAssignment = {
    version: 1,
    kind: 'FILE_EXTRACTION',
    intakeRunId: 'intake-run-1',
    receiptId,
    extractedTextHash: hash,
  }
  const assignedInput = { ...input, resource: 'assigned-source', questionId: undefined }
  function assignedFixture() {
    const f = fixture()
    const tx = {
      ...f.tx,
      agentRun: { findFirst: vi.fn().mockResolvedValue({ scopeSnapshot: { sourceAssignment } }) },
    }
    const db = {
      ...f.db,
      agentRun: { findFirst: vi.fn().mockResolvedValue({ scopeSnapshot: { sourceAssignment } }) },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    }
    return { ...f, db, tx }
  }
  it('reads only the locked persisted assignment without a question lookup', async () => {
    const { db, tx, assertClaim, readSource } = assignedFixture()
    const result = await readQuestionBoundSource(db as never, assignedInput, context as never, {
      assertCurrentAgentWorkerClaim: assertClaim,
      readIntakeFileExtractionSource: readSource,
    })
    expect(result.kind).toBe('pathfinder.assigned-source')
    expect(readSource).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'intake-run-1',
        receiptId,
        expectedExtractedTextHash: hash,
      }),
      tx,
    )
    expect(db.agentQuestion.findFirst).not.toHaveBeenCalled()
    expect(tx.agentQuestion.findFirst).not.toHaveBeenCalled()
    expect(tx.agentRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: input.agentRunId, agentIdentityId: 'identity-1' }),
      }),
    )
  })
  it('denies absent or changed assignment before returning source text', async () => {
    for (const scopeSnapshot of [
      {},
      {
        sourceAssignment: {
          ...sourceAssignment,
          receiptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
      },
    ]) {
      const { db, tx, assertClaim, readSource } = assignedFixture()
      tx.agentRun.findFirst.mockResolvedValue({ scopeSnapshot } as never)
      await expect(
        readQuestionBoundSource(db as never, assignedInput, context as never, {
          assertCurrentAgentWorkerClaim: assertClaim,
          readIntakeFileExtractionSource: readSource,
        }),
      ).rejects.toBeInstanceOf(QuestionSourceReaderError)
      expect(readSource).not.toHaveBeenCalled()
    }
  })
  it('does not admit an unassigned run or an unrelated question ID', async () => {
    const { db, assertClaim, readSource } = assignedFixture()
    db.agentRun.findFirst.mockResolvedValue({ scopeSnapshot: {} } as never)
    await expect(
      readQuestionBoundSource(db as never, assignedInput, context as never, {
        assertCurrentAgentWorkerClaim: assertClaim,
        readIntakeFileExtractionSource: readSource,
      }),
    ).rejects.toBeInstanceOf(QuestionSourceReaderError)
    await expect(
      readQuestionBoundSource(
        db as never,
        { ...assignedInput, questionId: 'unrelated' },
        context as never,
        { assertCurrentAgentWorkerClaim: assertClaim, readIntakeFileExtractionSource: readSource },
      ),
    ).rejects.toBeInstanceOf(QuestionSourceReaderError)
    expect(assertClaim).not.toHaveBeenCalled()
    expect(readSource).not.toHaveBeenCalled()
  })
})
