import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { adminSupportOperationsRouter } from './support-operations'

const requestFindFirst = vi.fn()
const messageFindMany = vi.fn()
const requestUpdateMany = vi.fn()
const messageCreate = vi.fn()
const auditEventCreate = vi.fn()

const mockDb = {
  $transaction: vi.fn(async (callback: (tx: typeof mockDb) => unknown) => callback(mockDb)),
  supportRequest: { findFirst: requestFindFirst, findMany: vi.fn(), updateMany: requestUpdateMany },
  supportMessage: { findMany: messageFindMany, create: messageCreate },
  supportRequestAuditEvent: { create: auditEventCreate },
  auditLog: { create: vi.fn() },
} as unknown as TRPCContext['db']

function context(isPlatformAdmin: boolean): TRPCContext {
  return {
    db: mockDb,
    headers: new Headers(),
    session: {
      userId: isPlatformAdmin ? 'platform_admin' : 'tenant_user',
      activeTenantId: 'tenant_session',
      role: 'OWNER',
      isPlatformAdmin,
    },
  }
}

const testRouter = router({ admin: adminSupportOperationsRouter })
const tenantId = 'tenant_target'
const venueId = 'venue_target'
const requestId = 'request_target'
const now = new Date('2030-01-01T00:00:00.000Z')

describe('admin support operations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requestFindFirst.mockResolvedValue({ id: requestId, status: 'OPEN', version: 1 })
    messageFindMany.mockResolvedValue([])
    requestUpdateMany.mockResolvedValue({ count: 1 })
    messageCreate.mockResolvedValue({
      id: 'message_internal',
      tenantId,
      venueId,
      supportRequestId: requestId,
      authorKind: 'OPERATOR',
      authorId: 'platform_admin',
      visibility: 'INTERNAL_ONLY',
      body: 'Review source evidence before replying.',
      createdAt: now,
      attachments: [],
    })
    auditEventCreate.mockResolvedValue({ id: 'event_internal' })
  })

  it('rejects non-admin callers before support data access', async () => {
    await expect(
      testRouter.createCaller(context(false)).admin.listSupportMessages({
        tenantId,
        venueId,
        requestId,
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }))
    expect(requestFindFirst).not.toHaveBeenCalled()
    expect(messageFindMany).not.toHaveBeenCalled()
  })

  it('lets platform admins read both visibility classes only within explicit scope', async () => {
    await testRouter.createCaller(context(true)).admin.listSupportMessages({
      tenantId,
      venueId,
      requestId,
    })

    expect(requestFindFirst).toHaveBeenCalledWith({
      where: { id: requestId, tenantId, venueId },
      select: { id: true },
    })
    expect(messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { supportRequestId: requestId, tenantId, venueId },
        take: 21,
      }),
    )
    const where = messageFindMany.mock.calls[0]?.[0]?.where
    expect(where).not.toHaveProperty('visibility')
  })

  it('creates an internal note with server-owned operator identity and scoped version check', async () => {
    await testRouter.createCaller(context(true)).admin.addSupportMessage({
      tenantId,
      venueId,
      requestId,
      expectedVersion: 1,
      visibility: 'INTERNAL_ONLY',
      body: 'Review source evidence before replying.',
    })

    expect(requestUpdateMany).toHaveBeenCalledWith({
      where: { id: requestId, tenantId, venueId, version: 1 },
      data: { version: 2, updatedByKind: 'OPERATOR', updatedById: 'platform_admin' },
    })
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId,
          venueId,
          supportRequestId: requestId,
          authorKind: 'OPERATOR',
          authorId: 'platform_admin',
          visibility: 'INTERNAL_ONLY',
        }),
      }),
    )
  })
})
