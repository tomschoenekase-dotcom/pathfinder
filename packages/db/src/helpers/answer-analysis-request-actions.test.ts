import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  type AnswerAnalysisRequestActionClient,
  answerAnalysisRequestHash,
  requestAnswerAnalysisAction,
} from './answer-analysis-request-actions'

const tenantId = 'tenant-1'
const venueId = 'venue-1'
const requestId = '11111111-1111-4111-8111-111111111111'
const rangeStart = new Date('2026-07-01T00:00:00.000Z')
const rangeEnd = new Date('2026-07-31T23:59:59.999Z')

function input(overrides: Partial<Parameters<typeof requestAnswerAnalysisAction>[0]> = {}) {
  return {
    tenantId,
    venueId,
    requestId,
    rangeStart,
    rangeEnd,
    actor: { type: 'HUMAN' as const, id: 'admin-1', role: 'PLATFORM_ADMIN' as const },
    ...overrides,
  }
}

function harness() {
  const venueFindFirst = vi.fn().mockResolvedValue({ id: venueId, isActive: true })
  const dispatchFindFirst = vi.fn().mockResolvedValue(null)
  const snapshotCreate = vi.fn().mockImplementation(async ({ data }) => data)
  const dispatchCreate = vi.fn().mockImplementation(async ({ data }) => ({
    id: data.id,
    recordId: data.recordId,
    requestHash: data.requestHash,
    status: 'PENDING',
  }))
  const auditCreate = vi.fn().mockResolvedValue({ id: 'audit-1' })
  const tx = {
    venue: { findFirst: venueFindFirst },
    generationRequestDispatch: { findFirst: dispatchFindFirst, create: dispatchCreate },
    answerAnalysisSnapshot: { create: snapshotCreate },
    auditLog: { create: auditCreate },
  }
  const transaction = vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) =>
    callback(tx),
  )
  return {
    client: { $transaction: transaction } as unknown as AnswerAnalysisRequestActionClient,
    transaction,
    venueFindFirst,
    dispatchFindFirst,
    snapshotCreate,
    dispatchCreate,
    auditCreate,
  }
}

describe('requestAnswerAnalysisAction', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('rejects an inverted range before opening a transaction', async () => {
    const h = harness()
    await expect(
      requestAnswerAnalysisAction(
        input({ rangeStart: new Date('2026-08-02T00:00:00.000Z'), rangeEnd }),
        h.client,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(h.transaction).not.toHaveBeenCalled()
  })

  it('atomically creates one scoped snapshot, dispatch and sanitized audit record', async () => {
    const h = harness()
    const result = await requestAnswerAnalysisAction(input(), h.client)

    expect(h.venueFindFirst).toHaveBeenCalledWith({
      where: { id: venueId, tenantId },
      select: { id: true, isActive: true },
    })
    expect(h.snapshotCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId,
        venueId,
        rangeStart,
        rangeEnd,
        createdBy: 'admin-1',
      }),
    })
    expect(h.dispatchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId,
          venueId,
          requestId,
          requestHash: answerAnalysisRequestHash({ venueId, rangeStart, rangeEnd }),
        }),
      }),
    )
    expect(h.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId,
        actorId: 'admin-1',
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.answer_analysis.requested',
        afterState: {
          venueId,
          requestId,
          rangeStart: rangeStart.toISOString(),
          rangeEnd: rangeEnd.toISOString(),
        },
      }),
    })
    expect(result).toMatchObject({ status: 'PENDING', replayed: false })
  })

  it('replays the exact durable request without creating or auditing again', async () => {
    const h = harness()
    h.dispatchFindFirst.mockResolvedValue({
      id: 'dispatch-existing',
      recordId: 'snapshot-existing',
      requestHash: answerAnalysisRequestHash({ venueId, rangeStart, rangeEnd }),
      status: 'PENDING',
    })
    await expect(requestAnswerAnalysisAction(input(), h.client)).resolves.toEqual({
      id: 'dispatch-existing',
      recordId: 'snapshot-existing',
      requestHash: answerAnalysisRequestHash({ venueId, rangeStart, rangeEnd }),
      status: 'PENDING',
      replayed: true,
    })
    expect(h.snapshotCreate).not.toHaveBeenCalled()
    expect(h.dispatchCreate).not.toHaveBeenCalled()
    expect(h.auditCreate).not.toHaveBeenCalled()
  })

  it('rejects a colliding request identity with changed input', async () => {
    const h = harness()
    h.dispatchFindFirst.mockResolvedValue({
      id: 'dispatch-existing',
      recordId: 'snapshot-existing',
      requestHash: '0'.repeat(64),
      status: 'PENDING',
    })
    await expect(requestAnswerAnalysisAction(input(), h.client)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(h.snapshotCreate).not.toHaveBeenCalled()
  })

  it('rejects an inactive scoped venue before reading or creating a request', async () => {
    const h = harness()
    h.venueFindFirst.mockResolvedValue({ id: venueId, isActive: false })
    await expect(requestAnswerAnalysisAction(input(), h.client)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
    expect(h.dispatchFindFirst).not.toHaveBeenCalled()
    expect(h.snapshotCreate).not.toHaveBeenCalled()
  })

  it('fails the transaction when strict audit persistence fails', async () => {
    const h = harness()
    h.auditCreate.mockRejectedValue(new Error('audit unavailable'))
    await expect(requestAnswerAnalysisAction(input(), h.client)).rejects.toThrow(
      'audit unavailable',
    )
    expect(h.snapshotCreate).toHaveBeenCalledTimes(1)
    expect(h.dispatchCreate).toHaveBeenCalledTimes(1)
  })

  it('converges a concurrent unique collision by re-reading the winning request', async () => {
    const h = harness()
    h.dispatchCreate.mockRejectedValueOnce({ code: 'P2002' })
    h.dispatchFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'dispatch-winner',
      recordId: 'snapshot-winner',
      requestHash: answerAnalysisRequestHash({ venueId, rangeStart, rangeEnd }),
      status: 'PENDING',
    })

    await expect(requestAnswerAnalysisAction(input(), h.client)).resolves.toMatchObject({
      id: 'dispatch-winner',
      recordId: 'snapshot-winner',
      replayed: true,
    })
    expect(h.transaction).toHaveBeenCalledTimes(2)
    expect(h.auditCreate).not.toHaveBeenCalled()
  })
})
