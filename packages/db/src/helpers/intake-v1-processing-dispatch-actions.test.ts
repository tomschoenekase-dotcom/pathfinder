import { describe, expect, it, vi } from 'vitest'

import {
  INTAKE_V1_PROCESSING_POLICY_VERSION,
  claimIntakeV1WebsiteResearchDispatch,
  createIntakeV1ProcessingDispatchesInTransaction,
  failIntakeV1ProcessingDispatch,
} from './intake-v1-processing-dispatch-actions'

describe('V1 processing dispatches', () => {
  it('projects website, reviewed input, and unsupported extraction independently', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 3 })
    const tx = {
      intakeV1SubmissionMember: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'm-web',
            immutableHash: 'a'.repeat(64),
            intakeRunId: 'run-web',
            intakeUpload: null,
            intakeRun: {
              sourceKind: 'WEBSITE',
              websiteUri: 'https://example.test',
              submissionInputHash: 'a'.repeat(64),
              websiteResearchReceipts: [],
            },
          },
          {
            id: 'm-interview',
            immutableHash: 'b'.repeat(64),
            intakeRunId: 'run-interview',
            intakeUpload: null,
            intakeRun: {
              sourceKind: 'INTERVIEW',
              websiteUri: null,
              submissionInputHash: 'b'.repeat(64),
              websiteResearchReceipts: [],
            },
          },
          {
            id: 'm-upload',
            immutableHash: 'c'.repeat(64),
            intakeRunId: null,
            intakeUpload: { intakeRunId: 'run-upload' },
            intakeRun: null,
          },
        ]),
      },
      intakeV1ProcessingDispatch: { createMany },
    }
    const rows = await createIntakeV1ProcessingDispatchesInTransaction(tx as never, {
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      revisionId: 'revision-a',
    })
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: 'm-web',
          kind: 'WEBSITE_RESEARCH',
          status: 'PENDING',
          policyVersion: INTAKE_V1_PROCESSING_POLICY_VERSION,
        }),
        expect.objectContaining({
          memberId: 'm-interview',
          kind: 'REVIEW_READY',
          status: 'COMPLETED',
        }),
        expect.objectContaining({
          memberId: 'm-upload',
          kind: 'EXTRACTION_UNSUPPORTED',
          status: 'HELD',
          holdReason: 'EXTRACTION_NOT_EXECUTABLE',
        }),
      ]),
    )
    expect(createMany).toHaveBeenCalledOnce()
  })

  it('uses one DB-clock claim statement with fixed lease and bounded attempts', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        {
          websiteUri: 'https://example.test',
          submissionInputHash: 'a'.repeat(64),
          memberHash: 'a'.repeat(64),
          dispatchHash: 'a'.repeat(64),
        },
      ])
      .mockResolvedValueOnce([
        { id: 'dispatch-a', leaseToken: '01ba25e5-f5bf-48bc-ad04-a91247732e58' },
      ])
    const client = {
      $transaction: (callback: (tx: unknown) => unknown) => callback({ $queryRaw: query }),
    }
    await expect(
      claimIntakeV1WebsiteResearchDispatch(
        { dispatchId: 'dispatch-a', leaseOwner: 'worker-a' },
        client as never,
      ),
    ).resolves.toMatchObject({ id: 'dispatch-a' })
    expect(query).toHaveBeenCalledTimes(2)
    expect((query.mock.calls[1]?.[0] as readonly string[]).join('')).toContain(
      'receipt.source_uri_hash=',
    )
  })

  it('refuses a claim before recovery when the locked current source no longer matches the snapshot', async () => {
    const query = vi.fn().mockResolvedValueOnce([
      {
        websiteUri: 'https://changed.example.test',
        submissionInputHash: 'b'.repeat(64),
        memberHash: 'a'.repeat(64),
        dispatchHash: 'a'.repeat(64),
      },
    ])
    const client = {
      $transaction: (callback: (tx: unknown) => unknown) => callback({ $queryRaw: query }),
    }
    await expect(
      claimIntakeV1WebsiteResearchDispatch(
        { dispatchId: 'dispatch-a', leaseOwner: 'worker-a' },
        client as never,
      ),
    ).resolves.toBeNull()
    expect(query).toHaveBeenCalledOnce()
  })

  it('requeues the same operation before attempt three and terminally fails attempt three', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    const client = (attempts: number) => ({
      $transaction: (callback: (tx: unknown) => unknown) =>
        callback({
          $queryRaw: vi
            .fn()
            .mockResolvedValueOnce([{ id: 'dispatch-a' }])
            .mockResolvedValueOnce([{ now: new Date('2026-09-07T00:00:00.000Z') }]),
          intakeV1ProcessingDispatch: {
            findFirst: vi.fn().mockResolvedValue({ attempts }),
            updateMany,
          },
        }),
    })
    const exact = {
      id: 'dispatch-a',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      operationId: '1eb69bbd-9d96-4742-b55a-3e82fa4891a8',
      leaseToken: '01ba25e5-f5bf-48bc-ad04-a91247732e58',
      sourceHash: 'a'.repeat(64),
      error: 'bounded failure',
    }
    await expect(failIntakeV1ProcessingDispatch(exact, client(1) as never)).resolves.toMatchObject({
      status: 'PENDING',
      attempts: 1,
    })
    await expect(failIntakeV1ProcessingDispatch(exact, client(3) as never)).resolves.toMatchObject({
      status: 'FAILED',
      attempts: 3,
    })
    expect(updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING' }) }),
    )
    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    )
  })
})
