import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  appendEvaluationReviewAction,
  EvaluationReviewActionError,
} from './evaluation-review-actions'

const input = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  runId: '11111111-1111-4111-8111-111111111111',
  expectedRunIdentityHash: 'a'.repeat(64),
  resultId: '22222222-2222-4222-8222-222222222222',
  expectedRevision: 0,
  operationId: '33333333-3333-4333-8333-333333333333',
  decision: 'NEEDS_FOLLOW_UP' as const,
  conclusion: '  Source coverage needs another review.  ',
  rubricVersion: 'operator-v1',
  actor: { type: 'HUMAN' as const, id: 'platform-admin-1', role: 'PLATFORM_ADMIN' as const },
}

function createdReview(overrides: Record<string, unknown> = {}) {
  return {
    id: input.operationId,
    resultId: input.resultId,
    reviewerId: input.actor.id,
    conclusion: 'Source coverage needs another review.',
    decision: input.decision,
    rubricVersion: input.rubricVersion,
    revision: 1,
    submissionOperationId: input.operationId,
    submissionInputHash: expect.any(String),
    createdAt: new Date('2026-08-12T12:00:00.000Z'),
    result: {
      runId: input.runId,
      run: { identityHash: input.expectedRunIdentityHash },
      evalCase: { caseKey: 'hours-question', category: 'grounding' },
    },
    ...overrides,
  }
}

function fixture() {
  const tx = {
    evalReview: { findFirst: vi.fn(), create: vi.fn() },
    evalResult: { findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
  }
  const client = { $transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx)) }
  return { tx, client }
}

describe('appendEvaluationReviewAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('appends the exact next revision and a sanitized strict audit atomically', async () => {
    const { tx, client } = fixture()
    tx.evalReview.findFirst.mockResolvedValue(null)
    tx.evalResult.findFirst.mockResolvedValue({
      id: input.resultId,
      runId: input.runId,
      run: { identityHash: input.expectedRunIdentityHash },
      evalCase: { caseKey: 'hours-question', category: 'grounding' },
      reviews: [],
    })
    tx.evalReview.create.mockResolvedValue(createdReview())

    await expect(appendEvaluationReviewAction(input, client as never)).resolves.toMatchObject({
      id: input.operationId,
      revision: 1,
      replayed: false,
    })
    expect(tx.evalResult.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          run: { identityHash: input.expectedRunIdentityHash, status: 'COMPLETED' },
        }),
      }),
    )
    expect(tx.evalReview.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: input.operationId,
          conclusion: 'Source coverage needs another review.',
          revision: 1,
          submissionInputHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        }),
      }),
    )
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorRole: 'PLATFORM_ADMIN',
        action: 'evaluation.review-conclusion-appended',
        afterState: expect.objectContaining({ conclusionLength: 37, revision: 1 }),
      }),
    })
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain(
      'Source coverage needs another review.',
    )
  })

  it('replays the exact actor-bound operation without another effect or audit', async () => {
    const first = fixture()
    first.tx.evalReview.findFirst.mockResolvedValue(null)
    first.tx.evalResult.findFirst.mockResolvedValue({
      id: input.resultId,
      runId: input.runId,
      run: { identityHash: input.expectedRunIdentityHash },
      evalCase: { caseKey: 'hours-question', category: 'grounding' },
      reviews: [],
    })
    first.tx.evalReview.create.mockImplementation(
      async ({ data }: { data: { submissionInputHash: string } }) =>
        createdReview({ submissionInputHash: data.submissionInputHash }),
    )
    const created = await appendEvaluationReviewAction(input, first.client as never)

    const replay = fixture()
    replay.tx.evalReview.findFirst.mockResolvedValue(created)
    await expect(
      appendEvaluationReviewAction(input, replay.client as never),
    ).resolves.toMatchObject({
      replayed: true,
    })
    expect(replay.tx.evalResult.findFirst).not.toHaveBeenCalled()
    expect(replay.tx.evalReview.create).not.toHaveBeenCalled()
    expect(replay.tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('rejects command collisions and stale review revisions', async () => {
    const collision = fixture()
    collision.tx.evalReview.findFirst.mockResolvedValue(
      createdReview({ submissionInputHash: 'b'.repeat(64) }),
    )
    await expect(
      appendEvaluationReviewAction(input, collision.client as never),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    })

    const stale = fixture()
    stale.tx.evalReview.findFirst.mockResolvedValue(null)
    stale.tx.evalResult.findFirst.mockResolvedValue({
      id: input.resultId,
      runId: input.runId,
      run: { identityHash: input.expectedRunIdentityHash },
      evalCase: { caseKey: 'hours-question', category: 'grounding' },
      reviews: [{ revision: 2 }],
    })
    await expect(appendEvaluationReviewAction(input, stale.client as never)).rejects.toEqual(
      expect.objectContaining({
        code: 'CONFLICT',
        message: expect.stringContaining('refresh'),
      }),
    )
  })

  it('fails nondisclosing for a wrong run, identity, tenant, venue, or result', async () => {
    const { tx, client } = fixture()
    tx.evalReview.findFirst.mockResolvedValue(null)
    tx.evalResult.findFirst.mockResolvedValue(null)
    await expect(appendEvaluationReviewAction(input, client as never)).rejects.toEqual(
      expect.objectContaining({ code: 'NOT_FOUND', message: 'Evaluation result was not found.' }),
    )
    expect(tx.evalReview.create).not.toHaveBeenCalled()
  })

  it('requires completed immutable run evidence before accepting a conclusion', async () => {
    const { tx, client } = fixture()
    tx.evalReview.findFirst.mockResolvedValue(null)
    tx.evalResult.findFirst.mockResolvedValue(null)

    await expect(appendEvaluationReviewAction(input, client as never)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(tx.evalResult.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ run: expect.objectContaining({ status: 'COMPLETED' }) }),
      }),
    )
    expect(tx.evalReview.create).not.toHaveBeenCalled()
  })

  it('converges a P2002 race only through an exact fresh replay read', async () => {
    const seed = fixture()
    seed.tx.evalReview.findFirst.mockResolvedValue(null)
    seed.tx.evalResult.findFirst.mockResolvedValue({
      id: input.resultId,
      runId: input.runId,
      run: { identityHash: input.expectedRunIdentityHash },
      evalCase: { caseKey: 'hours-question', category: 'grounding' },
      reviews: [],
    })
    seed.tx.evalReview.create.mockImplementation(
      async ({ data }: { data: { submissionInputHash: string } }) =>
        createdReview({ submissionInputHash: data.submissionInputHash }),
    )
    const raced = await appendEvaluationReviewAction(input, seed.client as never)

    const { tx, client } = fixture()
    tx.evalReview.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(raced)
    tx.evalResult.findFirst.mockResolvedValue({
      id: input.resultId,
      runId: input.runId,
      run: { identityHash: input.expectedRunIdentityHash },
      evalCase: { caseKey: 'hours-question', category: 'grounding' },
      reviews: [],
    })
    tx.evalReview.create.mockRejectedValueOnce({ code: 'P2002' })
    await expect(appendEvaluationReviewAction(input, client as never)).resolves.toMatchObject({
      replayed: true,
    })
    expect(client.$transaction).toHaveBeenCalledTimes(2)
  })

  it('validates the HUMAN PLATFORM_ADMIN actor and bounded command shape', async () => {
    await expect(
      appendEvaluationReviewAction(
        { ...input, actor: { ...input.actor, role: 'OWNER' as never } },
        fixture().client as never,
      ),
    ).rejects.toBeInstanceOf(EvaluationReviewActionError)
    await expect(
      appendEvaluationReviewAction(
        { ...input, operationId: 'not-a-uuid' },
        fixture().client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
