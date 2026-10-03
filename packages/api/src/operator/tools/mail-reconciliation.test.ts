import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), audit: vi.fn() }))
vi.mock('@pathfinder/jobs', () => ({
  enqueueGmailSync: mocks.enqueue,
  GMAIL_SYNC_QUEUE: 'gmail-sync',
}))
vi.mock('@pathfinder/db', () => ({ writeAuditLogStrict: mocks.audit }))

import type { OperatorCallContext } from '../registry'
import { mailReconciliationTools } from './mail-reconciliation'

const JOB_ID = `gmail-sync-${'a'.repeat(64)}`

function context(
  overrides: { allTenants?: boolean; account?: object | null; record?: object | null } = {},
) {
  const findAccount = vi.fn(async () =>
    overrides.account === undefined ? { id: 'account-1' } : overrides.account,
  )
  const findJob = vi.fn(async () => overrides.record ?? null)
  return {
    findAccount,
    findJob,
    value: {
      grant: {
        allTenants: overrides.allTenants ?? true,
        userId: 'owner',
        grantId: 'grant-1',
      },
      config: { allowedUserIds: new Set(['owner']) },
      database: {
        correspondenceProviderAccount: { findFirst: findAccount },
        jobRecord: { findUnique: findJob },
      },
      requestId: 'call-1',
    } as unknown as OperatorCallContext,
  }
}

describe('Gmail reconciliation MCP controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.enqueue.mockResolvedValue(JOB_ID)
  })

  it('queues one connected mailbox with exact platform scope and audits the request', async () => {
    const fixture = context()
    const order: string[] = []
    mocks.audit.mockImplementationOnce(async () => {
      order.push('audit')
    })
    mocks.enqueue.mockImplementationOnce(async () => {
      order.push('enqueue')
      return JOB_ID
    })
    const request = mailReconciliationTools[0]!
    const result = await request.handler(
      { providerAccountId: 'account-1', requestId: 'ca4ded47-719b-4e6c-acbc-c7dc10d44eca' },
      fixture.value,
    )
    expect(result).toEqual({ jobId: JOB_ID, status: 'QUEUED' })
    expect(fixture.findAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'account-1', provider: 'GMAIL' }),
      }),
    )
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: 'account-1', requestId: expect.any(String) }),
    )
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: 'account-1',
        action: 'operator.gmail_reconciliation.requested',
      }),
      fixture.value.database,
    )
    expect(order).toEqual(['audit', 'enqueue'])
  })

  it('rejects a tenant-only grant before looking up another mailbox or enqueuing', async () => {
    const fixture = context({ allTenants: false })
    await expect(
      mailReconciliationTools[0]!.handler(
        { providerAccountId: 'account-1', requestId: 'ca4ded47-719b-4e6c-acbc-c7dc10d44eca' },
        fixture.value,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(fixture.findAccount).not.toHaveBeenCalled()
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it('shows only the requested account job record and safe status fields', async () => {
    const fixture = context({
      record: {
        status: 'COMPLETE',
        payload: {
          providerAccountId: 'account-1',
          processed: 42,
          complete: false,
          nextJobId: JOB_ID,
        },
        error: null,
        completedAt: new Date('2026-10-02T00:00:00Z'),
      },
    })
    expect(
      await mailReconciliationTools[1]!.handler(
        { providerAccountId: 'account-1', jobId: JOB_ID },
        fixture.value,
      ),
    ).toEqual({
      jobId: JOB_ID,
      status: 'COMPLETE',
      processed: 42,
      complete: false,
      nextJobId: JOB_ID,
      errorCode: null,
      completedAt: '2026-10-02T00:00:00.000Z',
      providerDrafts: null,
    })
    const other = context({
      record: { status: 'COMPLETE', payload: { providerAccountId: 'other' } },
    })
    await expect(
      mailReconciliationTools[1]!.handler(
        { providerAccountId: 'account-1', jobId: JOB_ID },
        other.value,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('reports only well-formed native draft counts from the job record', async () => {
    const counts = {
      complete: true,
      providerDraftsSeen: 7,
      referencedLocalDrafts: 3,
      referencesConfirmedPresent: 2,
      referencesReleasedAsAbsent: 1,
      unreferencedProviderDrafts: 4,
    }
    const read = async (providerDrafts: unknown) =>
      mailReconciliationTools[1]!.handler(
        { providerAccountId: 'account-1', jobId: JOB_ID },
        context({
          record: {
            status: 'COMPLETE',
            payload: { providerAccountId: 'account-1', complete: true, providerDrafts },
            error: null,
            completedAt: null,
          },
        }).value,
      )
    expect(await read({ ...counts, draftId: 'r-private' })).toMatchObject({
      providerDrafts: counts,
    })
    expect(await read({ ...counts, referencesReleasedAsAbsent: -1 })).toMatchObject({
      providerDrafts: null,
    })
    expect(await read({ ...counts, complete: 'yes' })).toMatchObject({ providerDrafts: null })
    expect(await read(null)).toMatchObject({ providerDrafts: null })
  })
})
