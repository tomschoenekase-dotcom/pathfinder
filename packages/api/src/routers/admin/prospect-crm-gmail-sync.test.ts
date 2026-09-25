import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  enqueueGmailSync: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  db: { correspondenceProviderAccount: { findUnique: mocks.findUnique } },
  withTenantIsolationBypass: (callback: () => unknown) => callback(),
}))
vi.mock('@pathfinder/jobs', () => ({ enqueueGmailSync: mocks.enqueueGmailSync }))

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { adminProspectCrmGmailSyncRouter } from './prospect-crm-gmail-sync'

const testRouter = router({ admin: adminProspectCrmGmailSyncRouter })

function context(isPlatformAdmin = true): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'operator-1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin,
    },
  }
}

describe('admin Gmail full reconciliation trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findUnique.mockResolvedValue({
      id: 'gmail-account-1',
      provider: 'GMAIL',
      connectionStatus: 'CONNECTED',
    })
    mocks.enqueueGmailSync.mockResolvedValue(undefined)
  })

  it('queues one exact connected Gmail account with a stable request identity', async () => {
    const request = {
      providerAccountId: 'gmail-account-1',
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }
    await expect(
      testRouter.createCaller(context()).admin.requestFullGmailReconciliation(request),
    ).resolves.toEqual({ ...request, status: 'QUEUED' })
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: request.providerAccountId },
      select: { id: true, provider: true, connectionStatus: true },
    })
    expect(mocks.enqueueGmailSync).toHaveBeenCalledWith({
      providerAccountId: request.providerAccountId,
      trigger: 'FULL_RECONCILIATION',
      requestId: request.requestId,
    })
  })

  it('rejects a wildcard before any account lookup or enqueue', async () => {
    await expect(
      testRouter.createCaller(context()).admin.requestFullGmailReconciliation({
        providerAccountId: '*',
        requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.findUnique).not.toHaveBeenCalled()
    expect(mocks.enqueueGmailSync).not.toHaveBeenCalled()
  })

  it('requires platform admin and a connected Gmail provider account', async () => {
    await expect(
      testRouter.createCaller(context(false)).admin.requestFullGmailReconciliation({
        providerAccountId: 'gmail-account-1',
        requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    mocks.findUnique.mockResolvedValueOnce({
      id: 'gmail-account-1',
      provider: 'GMAIL',
      connectionStatus: 'DEGRADED',
    })
    await expect(
      testRouter.createCaller(context()).admin.requestFullGmailReconciliation({
        providerAccountId: 'gmail-account-1',
        requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(mocks.enqueueGmailSync).not.toHaveBeenCalled()
  })
})
