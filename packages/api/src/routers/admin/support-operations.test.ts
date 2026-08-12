import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TRPCContext } from '../../context'
import { mergeRouters, router } from '../../core'
import { adminSupportAttachmentsRouter } from './support-attachments'
import { adminSupportOperationsRouter } from './support-operations'

const requestFindFirst = vi.fn()
const messageFindMany = vi.fn()
const requestUpdateMany = vi.fn()
const messageCreate = vi.fn()
const auditEventCreate = vi.fn()
const packageFindMany = vi.fn()
const packageFindFirst = vi.fn()
const handoffFindMany = vi.fn()
const handoffFindFirst = vi.fn()
const handoffCreate = vi.fn()
const uploadFindMany = vi.fn()
const operationId = '00000000-0000-4000-8000-000000000001'

const mockDb = {
  $executeRaw: vi.fn(),
  $transaction: vi.fn(async (callback: (tx: typeof mockDb) => unknown) => callback(mockDb)),
  supportRequest: { findFirst: requestFindFirst, findMany: vi.fn(), updateMany: requestUpdateMany },
  intakeUpload: { findMany: uploadFindMany },
  supportMessage: {
    findMany: messageFindMany,
    findFirst: vi.fn().mockResolvedValue(null),
    create: messageCreate,
  },
  supportRequestAuditEvent: { create: auditEventCreate },
  venuePackage: { findMany: packageFindMany, findFirst: packageFindFirst },
  supportPackageHandoff: {
    findMany: handoffFindMany,
    findFirst: handoffFindFirst,
    create: handoffCreate,
  },
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

const testRouter = router({
  admin: mergeRouters(adminSupportOperationsRouter, adminSupportAttachmentsRouter),
})
const tenantId = 'tenant_target'
const venueId = 'venue_target'
const requestId = 'request_target'
const now = new Date('2030-01-01T00:00:00.000Z')

describe('admin support operations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requestFindFirst.mockResolvedValue({
      id: requestId,
      status: 'OPEN',
      version: 1,
      clientVersion: 3,
    })
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
    packageFindMany.mockResolvedValue([])
    packageFindFirst.mockResolvedValue({ id: 'package_target', status: 'DRAFT' })
    handoffFindMany.mockResolvedValue([])
    handoffFindFirst.mockResolvedValue(null)
    handoffCreate.mockResolvedValue({
      id: 'handoff_1',
      tenantId,
      venueId,
      supportRequestId: requestId,
      venuePackageId: 'package_target',
      requestVersion: 2,
      linkedByKind: 'OPERATOR',
      linkedById: 'platform_admin',
      createdAt: now,
    })
    uploadFindMany.mockResolvedValue([])
  })

  it('lists safe exact-scope verified attachment choices for operators', async () => {
    await testRouter.createCaller(context(true)).admin.listEligibleSupportAttachments({
      tenantId,
      venueId,
    })
    expect(uploadFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId,
          venueId,
          status: 'AWAITING_REVIEW',
          verifiedAt: { not: null },
          storageVersionId: { not: null },
        }),
      }),
    )
    expect(uploadFindMany.mock.calls[0]?.[0]?.where).not.toHaveProperty('requestedBy')
  })

  it('keeps an admin cursor when a full raw page contains only inconsistent evidence', async () => {
    uploadFindMany.mockResolvedValue(
      ['bad_1', 'bad_2'].map((id, index) => ({
        id,
        fileName: 'bad.pdf',
        mimeType: 'application/pdf',
        byteSize: 42,
        sha256: 'a'.repeat(64),
        verifiedAt: now,
        storageVersionId: 'private-version',
        intakeRunId: `run_${index}`,
        intakeRun: {
          id: `run_${index}`,
          sourceKind: 'FILE_UPLOAD',
          status: 'AWAITING_REVIEW',
          evidence: [],
        },
        createdAt: new Date(now.getTime() - index),
      })),
    )
    const result = await testRouter
      .createCaller(context(true))
      .admin.listEligibleSupportAttachments({ tenantId, venueId, limit: 1 })
    expect(result.items).toEqual([])
    expect(result.nextCursor?.id).toBe('bad_2')
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
      operationId,
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

  it('records structured triage with server-owned human operator identity and no side effects', async () => {
    requestFindFirst.mockResolvedValueOnce({
      id: requestId,
      category: 'GENERAL',
      status: 'OPEN',
      missingInformation: [],
      version: 1,
      clientVersion: 4,
    })
    await expect(
      testRouter.createCaller(context(true)).admin.triageSupportRequest({
        tenantId,
        venueId,
        requestId,
        expectedVersion: 1,
        category: 'CONTENT_CORRECTION',
        missingInformation: ['Current admission price', 'Effective date'],
      }),
    ).resolves.toMatchObject({
      id: requestId,
      category: 'CONTENT_CORRECTION',
      version: 2,
      clientVersion: 5,
      clientActivityAt: expect.any(Date),
    })
    expect(requestUpdateMany).toHaveBeenCalledWith({
      where: {
        id: requestId,
        tenantId,
        venueId,
        version: 1,
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
      },
      data: {
        category: 'CONTENT_CORRECTION',
        missingInformation: ['Current admission price', 'Effective date'],
        version: 2,
        clientVersion: 5,
        clientActivityAt: expect.any(Date),
        updatedByKind: 'OPERATOR',
        updatedById: 'platform_admin',
      },
    })
    expect(auditEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'TRIAGE_UPDATED', requestVersion: 2 }),
      }),
    )
    expect(messageCreate).not.toHaveBeenCalled()
    expect(handoffCreate).not.toHaveBeenCalled()
  })

  it('rejects duplicate triage prompts before domain access', async () => {
    await expect(
      testRouter.createCaller(context(true)).admin.triageSupportRequest({
        tenantId,
        venueId,
        requestId,
        expectedVersion: 1,
        category: 'GENERAL',
        missingInformation: ['Same prompt', 'Same prompt'],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(requestFindFirst).not.toHaveBeenCalled()
  })

  it('lists only unlinked DRAFT packages within exact scope', async () => {
    await testRouter
      .createCaller(context(true))
      .admin.listSupportDraftPackages({ tenantId, venueId, requestId })
    expect(packageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId, venueId, status: 'DRAFT', supportHandoffs: { none: {} } },
        select: {
          id: true,
          schemaVersion: true,
          payloadHash: true,
          createdBy: true,
          createdAt: true,
        },
      }),
    )
  })

  it('links through the domain action with server-owned operator identity', async () => {
    await testRouter.createCaller(context(true)).admin.linkSupportDraftPackage({
      tenantId,
      venueId,
      requestId,
      venuePackageId: 'package_target',
      expectedVersion: 1,
    })
    expect(packageFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'package_target', tenantId, venueId } }),
    )
    expect(handoffCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ linkedByKind: 'OPERATOR', linkedById: 'platform_admin' }),
      }),
    )
  })

  it('rejects non-admin linking before any write', async () => {
    await expect(
      testRouter.createCaller(context(false)).admin.linkSupportDraftPackage({
        tenantId,
        venueId,
        requestId,
        venuePackageId: 'package_target',
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(handoffCreate).not.toHaveBeenCalled()
  })

  it('records an allowed status transition with server-owned operator and exact CAS scope', async () => {
    await expect(
      testRouter.createCaller(context(true)).admin.transitionSupportRequestStatus({
        tenantId,
        venueId,
        requestId,
        expectedVersion: 1,
        toStatus: 'IN_REVIEW',
      }),
    ).resolves.toMatchObject({
      id: requestId,
      version: 2,
      clientVersion: 4,
      clientActivityAt: expect.any(Date),
    })
    expect(requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: requestId, tenantId, venueId, version: 1, status: 'OPEN' },
        data: expect.objectContaining({
          status: 'IN_REVIEW',
          version: 2,
          clientVersion: 4,
          clientActivityAt: expect.any(Date),
          updatedByKind: 'OPERATOR',
          updatedById: 'platform_admin',
        }),
      }),
    )
    expect(auditEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'STATUS_CHANGED',
          fromStatus: 'OPEN',
          toStatus: 'IN_REVIEW',
        }),
      }),
    )
  })

  it('rejects client status mutation before transaction data access', async () => {
    await expect(
      testRouter.createCaller(context(false)).admin.transitionSupportRequestStatus({
        tenantId,
        venueId,
        requestId,
        expectedVersion: 1,
        toStatus: 'IN_REVIEW',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(requestUpdateMany).not.toHaveBeenCalled()
  })
})
