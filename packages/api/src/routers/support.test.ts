import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TRPCContext } from '../context'
import { router } from '../core'
import { supportRouter } from './support'

const venueFindFirst = vi.fn()
const requestFindMany = vi.fn()
const requestFindFirst = vi.fn()
const requestCreate = vi.fn()
const requestUpdateMany = vi.fn()
const messageCreate = vi.fn()
const auditEventCreate = vi.fn()
const auditLogCreate = vi.fn()

const mockDb = {
  $transaction: vi.fn(async (callback: (tx: typeof mockDb) => unknown) => callback(mockDb)),
  venue: { findFirst: venueFindFirst },
  supportRequest: {
    findMany: requestFindMany,
    findFirst: requestFindFirst,
    create: requestCreate,
    updateMany: requestUpdateMany,
  },
  supportMessage: { create: messageCreate },
  supportRequestAuditEvent: { create: auditEventCreate },
  auditLog: { create: auditLogCreate },
} as unknown as TRPCContext['db']

const tenantCtx: TRPCContext = {
  db: mockDb,
  headers: new Headers(),
  session: {
    userId: 'user_client',
    activeTenantId: 'tenant_assigned',
    role: 'STAFF',
    isPlatformAdmin: false,
  },
}

const testRouter = router({ support: supportRouter })
const venueId = 'venue_assigned'
const requestId = 'support_request_1'
const createdAt = new Date('2030-01-01T00:00:00.000Z')

const requestRow = {
  id: requestId,
  venueId,
  category: 'GENERAL' as const,
  status: 'OPEN' as const,
  subject: 'Please update the visitor information',
  missingInformation: [],
  version: 1,
  statusChangedAt: createdAt,
  createdAt,
  updatedAt: createdAt,
}

const messageRow = {
  id: 'support_message_1',
  authorKind: 'CLIENT' as const,
  visibility: 'CLIENT_VISIBLE' as const,
  body: 'The entrance instructions changed.',
  createdAt,
  attachments: [],
}

describe('client support router', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    venueFindFirst.mockResolvedValue({ id: venueId })
    requestCreate.mockResolvedValue(requestRow)
    messageCreate.mockResolvedValue(messageRow)
    auditEventCreate.mockResolvedValue({ id: 'support_event_1' })
    requestUpdateMany.mockResolvedValue({ count: 1 })
  })

  it('binds request lists to the authenticated tenant and requested venue', async () => {
    requestFindMany.mockResolvedValue([requestRow])

    const result = await testRouter.createCaller(tenantCtx).support.listRequests({ venueId })

    expect(result.items).toEqual([requestRow])
    expect(requestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant_assigned', venueId },
        take: 21,
      }),
    )
  })

  it('filters client reads to CLIENT_VISIBLE messages at the database boundary', async () => {
    requestFindFirst.mockResolvedValue({ ...requestRow, messages: [messageRow] })

    const result = await testRouter.createCaller(tenantCtx).support.getRequest({
      venueId,
      requestId,
    })

    expect(result.messages).toHaveLength(1)
    expect(requestFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: requestId, tenantId: 'tenant_assigned', venueId },
        select: expect.objectContaining({
          messages: expect.objectContaining({
            where: {
              tenantId: 'tenant_assigned',
              venueId,
              visibility: 'CLIENT_VISIBLE',
            },
          }),
        }),
      }),
    )
    expect(JSON.stringify(result)).not.toContain('INTERNAL_ONLY')
  })

  it('rejects an unassigned venue before creating any support record', async () => {
    venueFindFirst.mockResolvedValueOnce(null)

    await expect(
      testRouter.createCaller(tenantCtx).support.createRequest({
        venueId: 'venue_other_tenant',
        category: 'GENERAL',
        subject: 'Help needed',
        body: 'Please review this request.',
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))

    expect(venueFindFirst).toHaveBeenCalledWith({
      where: { id: 'venue_other_tenant', tenantId: 'tenant_assigned' },
      select: { id: true },
    })
    expect(requestCreate).not.toHaveBeenCalled()
    expect(messageCreate).not.toHaveBeenCalled()
  })

  it('creates a client-visible draft without accepting visibility or internal fields', async () => {
    const caller = testRouter.createCaller(tenantCtx)
    await caller.support.createRequest({
      venueId,
      category: 'CONTENT_CORRECTION',
      subject: 'Entrance directions',
      body: 'The entrance instructions changed.',
    })

    expect(requestCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant_assigned',
          venueId,
          createdByKind: 'CLIENT',
          createdById: 'user_client',
        }),
      }),
    )
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant_assigned',
          venueId,
          authorKind: 'CLIENT',
          visibility: 'CLIENT_VISIBLE',
        }),
      }),
    )
    expect(auditLogCreate).toHaveBeenCalledOnce()

    await expect(
      caller.support.createRequest({
        venueId,
        category: 'GENERAL',
        subject: 'Attempted internal note',
        body: 'This must remain client visible.',
        visibility: 'INTERNAL_ONLY',
      } as never),
    ).rejects.toThrow()
  })

  it('fails a cross-tenant request lookup before adding a message', async () => {
    requestFindFirst.mockResolvedValueOnce(null)

    await expect(
      testRouter.createCaller(tenantCtx).support.addMessage({
        venueId,
        requestId: 'request_other_tenant',
        expectedVersion: 1,
        body: 'Trying another request.',
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))

    expect(requestFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'request_other_tenant',
        tenantId: 'tenant_assigned',
        venueId,
      },
      select: { id: true, status: true, version: true },
    })
    expect(requestUpdateMany).not.toHaveBeenCalled()
    expect(messageCreate).not.toHaveBeenCalled()
  })
})
