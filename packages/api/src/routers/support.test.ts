import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TRPCContext } from '../context'
import { router } from '../core'
import { supportRouter } from './support'

const venueFindFirst = vi.fn()
const uploadFindMany = vi.fn()
const requestFindMany = vi.fn()
const requestFindFirst = vi.fn()
const requestCreate = vi.fn()
const requestUpdateMany = vi.fn()
const messageCreate = vi.fn()
const auditEventCreate = vi.fn()
const auditLogCreate = vi.fn()
const membershipFindFirst = vi.fn()
const membershipFindMany = vi.fn()
const participantFindMany = vi.fn()

const mockDb = {
  $executeRaw: vi.fn(),
  $transaction: vi.fn(async (callback: (tx: typeof mockDb) => unknown) => callback(mockDb)),
  venue: { findFirst: venueFindFirst },
  tenantMembership: { findFirst: membershipFindFirst, findMany: membershipFindMany },
  intakeUpload: { findMany: uploadFindMany },
  supportRequest: {
    findMany: requestFindMany,
    findFirst: requestFindFirst,
    create: requestCreate,
    updateMany: requestUpdateMany,
  },
  supportMessage: { findFirst: vi.fn().mockResolvedValue(null), create: messageCreate },
  onboardingQuestionLink: { findFirst: vi.fn().mockResolvedValue(null) },
  supportRequestParticipant: { findMany: participantFindMany },
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
const operationId = '00000000-0000-4000-8000-000000000001'

const requestRow = {
  id: requestId,
  venueId,
  category: 'GENERAL' as const,
  status: 'OPEN' as const,
  subject: 'Please update the visitor information',
  missingInformation: [],
  version: 1,
  clientVersion: 1,
  clientActivityAt: createdAt,
  createdByKind: 'CLIENT' as const,
  requesterUserId: 'user_client',
  requesterMembership: { status: 'ACTIVE' as const },
  participants: [],
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
  it('keeps client support status read-only', () => {
    expect(supportRouter._def.procedures).not.toHaveProperty('transitionSupportRequestStatus')
  })

  it('responds to requested information through the exact client ACL and DTO', async () => {
    requestFindFirst.mockResolvedValue({
      ...requestRow,
      status: 'WAITING_FOR_CLIENT',
      missingInformation: ['Effective date'],
    })
    messageCreate.mockResolvedValue({
      ...messageRow,
      body: 'It takes effect tomorrow.',
      clientVersion: 2,
    })
    const result = await testRouter.createCaller(tenantCtx).support.respondToInformation({
      operationId,
      venueId,
      requestId,
      expectedClientVersion: 1,
      body: 'It takes effect tomorrow.',
      attachments: [],
    })
    expect(result).toMatchObject({
      status: 'IN_REVIEW',
      missingInformation: [],
      requestVersion: 2,
      clientVersion: 2,
      replayed: false,
    })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    venueFindFirst.mockResolvedValue({ id: venueId })
    membershipFindFirst.mockResolvedValue({ id: 'membership_1' })
    participantFindMany.mockResolvedValue([])
    requestCreate.mockResolvedValue(requestRow)
    messageCreate.mockResolvedValue(messageRow)
    auditEventCreate.mockResolvedValue({ id: 'support_event_1' })
    requestUpdateMany.mockResolvedValue({ count: 1 })
  })

  it('binds request lists to the authenticated tenant and requested venue', async () => {
    requestFindMany.mockResolvedValue([requestRow])

    const result = await testRouter.createCaller(tenantCtx).support.listRequests({ venueId })

    expect(result.items).toEqual([
      expect.objectContaining({
        id: requestId,
        requesterIsCurrentUser: true,
        participantIsCurrentUser: false,
        canReply: true,
      }),
    ])
    expect(JSON.stringify(result.items)).not.toMatch(/requesterUserId|createdById|participants/)
    expect(requestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant_assigned', venueId }),
        take: 21,
      }),
    )
    const where = requestFindMany.mock.calls[0]?.[0]?.where
    expect(where).toMatchObject({
      OR: [
        {
          createdByKind: 'CLIENT',
          requesterUserId: 'user_client',
          requesterMembership: { is: { status: 'ACTIVE' } },
        },
        {
          participants: {
            some: {
              userId: 'user_client',
              revokedAt: null,
              membership: { is: { status: 'ACTIVE' } },
            },
          },
        },
      ],
    })
  })

  it('authorizes the exact active requester before returning bounded participant candidates', async () => {
    requestFindFirst.mockResolvedValueOnce({
      id: requestId,
      requesterUserId: 'user_client',
    })
    membershipFindMany.mockResolvedValueOnce([
      { userId: 'user_active', user: { fullName: 'Active teammate' } },
      { userId: 'user_revoked', user: { fullName: null } },
    ])
    participantFindMany.mockResolvedValueOnce([{ userId: 'user_active' }])

    const result = await testRouter.createCaller(tenantCtx).support.listParticipantCandidates({
      venueId,
      requestId,
    })

    expect(requestFindFirst).toHaveBeenCalledWith({
      where: {
        id: requestId,
        tenantId: 'tenant_assigned',
        venueId,
        OR: [
          {
            createdByKind: 'CLIENT',
            requesterUserId: 'user_client',
            requesterMembership: { is: { status: 'ACTIVE' } },
          },
          {
            createdByKind: 'OPERATOR',
            onboardingQuestionLink: { is: { recipientUserId: 'user_client' } },
            participants: {
              some: {
                userId: 'user_client',
                revokedAt: null,
                membership: { is: { status: 'ACTIVE' } },
              },
            },
          },
        ],
      },
      select: {
        id: true,
        requesterUserId: true,
      },
    })
    expect(membershipFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant_assigned',
          status: 'ACTIVE',
          userId: { not: 'user_client' },
        },
        take: 21,
      }),
    )
    expect(result).toEqual({
      candidates: [
        { userId: 'user_active', displayLabel: 'Active teammate', activeOnRequest: true },
        { userId: 'user_revoked', displayLabel: 'Team member', activeOnRequest: false },
      ],
      nextCursor: null,
    })
    expect(JSON.stringify(result)).not.toMatch(/email|role|membership|grant|revokedAt/i)
    expect(mockDb.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    })
  })

  it('does not enumerate tenant members for a participant, inactive requester, or wrong scope', async () => {
    requestFindFirst.mockResolvedValue(null)
    await expect(
      testRouter.createCaller(tenantCtx).support.listParticipantCandidates({ venueId, requestId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(membershipFindMany).not.toHaveBeenCalled()
    expect(participantFindMany).not.toHaveBeenCalled()
  })

  it.each(['STAFF', 'MANAGER', 'OWNER'] as const)(
    'uses the same requester-or-active-participant ACL for %s',
    async (role) => {
      requestFindMany.mockResolvedValue([])
      await testRouter
        .createCaller({
          ...tenantCtx,
          session: {
            userId: 'user_client',
            activeTenantId: 'tenant_assigned',
            isPlatformAdmin: false,
            role,
          },
        })
        .support.listRequests({ venueId })
      expect(requestFindMany.mock.calls[0]?.[0]?.where).toMatchObject({
        OR: expect.any(Array),
      })
      expect(requestFindMany.mock.calls[0]?.[0]?.where.OR[0]).toMatchObject({
        createdByKind: 'CLIENT',
        requesterUserId: 'user_client',
      })
      expect(requestFindMany.mock.calls[0]?.[0]?.where).not.toHaveProperty('role')
    },
  )

  it('lists only requester-owned transport-verified attachment metadata without provenance secrets', async () => {
    uploadFindMany.mockResolvedValue([
      {
        id: 'upload_1',
        fileName: 'verified.pdf',
        mimeType: 'application/pdf',
        byteSize: 42,
        sha256: 'a'.repeat(64),
        verifiedAt: createdAt,
        storageVersionId: 'private-version',
        intakeRunId: 'run_1',
        intakeRun: {
          id: 'run_1',
          sourceKind: 'FILE_UPLOAD',
          status: 'AWAITING_REVIEW',
          evidence: [
            {
              tenantId: 'tenant_assigned',
              venueId,
              runId: 'run_1',
              sourceKind: 'FILE_UPLOAD',
              locator: 'intake-upload:upload_1',
              normalizedHash: 'a'.repeat(64),
            },
          ],
        },
        createdAt,
      },
    ])
    const result = await testRouter.createCaller(tenantCtx).support.listEligibleAttachments({
      venueId,
    })
    expect(uploadFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant_assigned',
          venueId,
          requestedBy: 'user_client',
          verifiedAt: { not: null },
          storageVersionId: { not: null },
        }),
      }),
    )
    expect(result).toEqual({
      items: [
        {
          intakeUploadId: 'upload_1',
          fileName: 'verified.pdf',
          mimeType: 'application/pdf',
          byteSize: 42,
          createdAt,
        },
      ],
      nextCursor: null,
    })
    expect(JSON.stringify(result)).not.toMatch(/sha256|version|locator|runId|sourceId/u)
  })

  it('lets a platform admin preview an attachment-empty client portal without tenant membership', async () => {
    uploadFindMany.mockResolvedValueOnce([])

    const result = await testRouter
      .createCaller({
        ...tenantCtx,
        session: {
          userId: 'platform_admin',
          activeTenantId: 'tenant_assigned',
          role: 'OWNER',
          isPlatformAdmin: true,
        },
      })
      .support.listEligibleAttachments({ venueId })

    expect(membershipFindFirst).not.toHaveBeenCalled()
    expect(uploadFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant_assigned',
          venueId,
          requestedBy: 'platform_admin',
        }),
      }),
    )
    expect(result).toEqual({ items: [], nextCursor: null })
  })

  it('keeps attachment discovery closed for a tenant user without active membership', async () => {
    membershipFindFirst.mockResolvedValueOnce(null)

    await expect(
      testRouter.createCaller(tenantCtx).support.listEligibleAttachments({ venueId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(uploadFindMany).not.toHaveBeenCalled()
  })

  it('continues pagination after a full window of inconsistent evidence rows', async () => {
    uploadFindMany.mockResolvedValue(
      ['upload_bad_1', 'upload_bad_2'].map((id, index) => ({
        id,
        fileName: 'bad.pdf',
        mimeType: 'application/pdf',
        byteSize: 42,
        sha256: 'a'.repeat(64),
        verifiedAt: createdAt,
        storageVersionId: 'private-version',
        intakeRunId: `run_${index}`,
        intakeRun: {
          id: `run_${index}`,
          sourceKind: 'FILE_UPLOAD',
          status: 'AWAITING_REVIEW',
          evidence: [],
        },
        createdAt: new Date(createdAt.getTime() - index),
      })),
    )
    const result = await testRouter.createCaller(tenantCtx).support.listEligibleAttachments({
      venueId,
      limit: 1,
    })
    expect(result.items).toEqual([])
    expect(result.nextCursor).toEqual({
      createdAt: new Date(createdAt.getTime() - 1).toISOString(),
      id: 'upload_bad_2',
    })
  })

  it('filters client reads to CLIENT_VISIBLE messages at the database boundary', async () => {
    requestFindFirst.mockResolvedValue({ ...requestRow, messages: [messageRow] })

    const result = await testRouter.createCaller(tenantCtx).support.getRequest({
      venueId,
      requestId,
    })

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toMatchObject({ authorIsCurrentUser: false })
    expect(JSON.stringify(result.messages)).not.toMatch(/authorId|visibility|INTERNAL_ONLY/)
    expect(requestFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: requestId, tenantId: 'tenant_assigned', venueId }),
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
        operationId,
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
      operationId,
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
        operationId,
        venueId,
        category: 'GENERAL',
        subject: 'Attempted internal note',
        body: 'This must remain client visible.',
        visibility: 'INTERNAL_ONLY',
      } as never),
    ).rejects.toThrow()

    await expect(
      caller.support.createRequest({
        operationId,
        venueId,
        category: 'GENERAL',
        subject: 'Spoof metadata',
        body: 'Must fail.',
        attachments: [
          { intakeUploadId: 'upload_1', filename: 'spoof.pdf', mediaType: 'text/plain' },
        ],
      } as never),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'BAD_REQUEST' }))
  })

  it('fails a cross-tenant request lookup before adding a message', async () => {
    requestFindFirst.mockResolvedValueOnce(null)

    await expect(
      testRouter.createCaller(tenantCtx).support.addMessage({
        operationId,
        venueId,
        requestId: 'request_other_tenant',
        expectedClientVersion: 1,
        body: 'Trying another request.',
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))

    expect(requestFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'request_other_tenant',
          tenantId: 'tenant_assigned',
          venueId,
        },
      }),
    )
    expect(requestUpdateMany).not.toHaveBeenCalled()
    expect(messageCreate).not.toHaveBeenCalled()
  })
})
