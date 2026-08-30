import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))

vi.mock('../../lib/customer-access-executor', () => ({
  executeApprovedCustomerInvitation: execute,
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminCustomerAccessExecutionRouter } from './customer-access-execution'

const app = router({ admin: adminCustomerAccessExecutionRouter })
const revision = new Date('2026-08-25T14:00:00.000Z')

function context(isPlatformAdmin: boolean): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'admin-1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin,
    },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  execute.mockResolvedValue({
    requestId: 'access-1',
    status: 'INVITED',
    providerInvitationId: 'invite-1',
    replayed: false,
    membershipCreatedLocally: false,
  })
})

describe('platform customer access execution router', () => {
  it('requires platform-admin authorization before provider execution', async () => {
    await expect(
      app.createCaller(context(false)).admin.executeApprovedCustomerInvitation({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        requestId: 'access-1',
        expectedUpdatedAt: revision,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('passes exact scope, revision, and human actor to the executor', async () => {
    await expect(
      app.createCaller(context(true)).admin.executeApprovedCustomerInvitation({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        requestId: 'access-1',
        expectedUpdatedAt: revision,
      }),
    ).resolves.toMatchObject({ status: 'INVITED', membershipCreatedLocally: false })
    expect(execute).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      requestId: 'access-1',
      expectedUpdatedAt: revision,
      actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
    })
  })
})
