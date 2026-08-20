import { beforeEach, describe, expect, it, vi } from 'vitest'

const tenantFindUniqueMock = vi.fn()
const tenantUpsertMock = vi.fn()
const userFindUniqueMock = vi.fn()
const userUpsertMock = vi.fn()
const userUpdateMock = vi.fn()
const membershipCreateMock = vi.fn()
const membershipFindUniqueMock = vi.fn()
const membershipUpdateMock = vi.fn()
const membershipFindFirstMock = vi.fn()
const membershipUpdateManyMock = vi.fn()
const auditLogCreateMock = vi.fn()
const receiptCreateManyMock = vi.fn()
const receiptFindUniqueMock = vi.fn()
const receiptUpdateMock = vi.fn()
const transactionMock = vi.fn()
const loggerWarnMock = vi.fn()
const loggerInfoMock = vi.fn()

const transactionDb = {
  tenant: { findUnique: tenantFindUniqueMock, upsert: tenantUpsertMock },
  user: { findUnique: userFindUniqueMock, upsert: userUpsertMock, update: userUpdateMock },
  tenantMembership: {
    create: membershipCreateMock,
    findUnique: membershipFindUniqueMock,
    findFirst: membershipFindFirstMock,
    update: membershipUpdateMock,
    updateMany: membershipUpdateManyMock,
  },
  auditLog: { create: auditLogCreateMock },
  clerkWebhookReceipt: {
    createMany: receiptCreateManyMock,
    findUnique: receiptFindUniqueMock,
    update: receiptUpdateMock,
  },
}

vi.mock('../client', () => ({
  db: { ...transactionDb, $transaction: transactionMock },
}))

vi.mock('@pathfinder/config/logger', () => ({
  logger: { warn: loggerWarnMock, info: loggerInfoMock, error: vi.fn() },
}))

const TENANT_ID = 'org_tenant1'
const USER_ID = 'user_abc'
const EVENT_TIMESTAMP = 1_700_000_000_000
const VERIFIED_IDENTITY = { providerEventId: 'evt_verified_1', payloadHash: 'a'.repeat(64) }

const membershipData = {
  organization: { id: TENANT_ID },
  public_user_data: {
    user_id: USER_ID,
    first_name: 'Alice',
    last_name: 'Smith',
    email_addresses: [{ email_address: 'alice@example.com' }],
  },
  role: 'org:admin',
}

const membershipDataWithoutEmail = {
  organization: { id: TENANT_ID },
  public_user_data: { user_id: USER_ID, first_name: 'Alice', last_name: 'Smith' },
  role: 'org:admin',
}

const membershipDataWithIdentifier = {
  organization: { id: TENANT_ID },
  public_user_data: {
    user_id: USER_ID,
    first_name: 'Alice',
    last_name: 'Smith',
    identifier: 'alice@example.com',
  },
  role: 'org:admin',
}

beforeEach(() => {
  for (const mock of [
    tenantFindUniqueMock,
    tenantUpsertMock,
    userFindUniqueMock,
    userUpsertMock,
    userUpdateMock,
    membershipCreateMock,
    membershipFindUniqueMock,
    membershipUpdateMock,
    membershipFindFirstMock,
    membershipUpdateManyMock,
    auditLogCreateMock,
    receiptCreateManyMock,
    receiptFindUniqueMock,
    receiptUpdateMock,
    transactionMock,
    loggerWarnMock,
    loggerInfoMock,
  ]) {
    mock.mockReset()
  }
  transactionMock.mockImplementation(async (callback) => callback(transactionDb))
  receiptCreateManyMock.mockResolvedValue({ count: 1 })
  auditLogCreateMock.mockResolvedValue({ id: 'audit_1' })
  membershipFindUniqueMock.mockResolvedValue(null)
  membershipCreateMock.mockResolvedValue({ id: 'mem_1', role: 'OWNER', status: 'ACTIVE' })
  membershipUpdateMock.mockResolvedValue({ id: 'mem_1', role: 'OWNER', status: 'ACTIVE' })
  membershipUpdateManyMock.mockResolvedValue({ count: 1 })
  receiptUpdateMock.mockResolvedValue({ providerEventId: VERIFIED_IDENTITY.providerEventId })
})

describe('mapClerkRoleToTenantRole', () => {
  it.each([
    ['org:admin', 'OWNER'],
    ['org:owner', 'OWNER'],
    ['org:manager', 'MANAGER'],
    ['org:member', 'STAFF'],
    ['org:custom_role', 'STAFF'],
  ])('maps %s to %s', async (clerkRole, expected) => {
    const { mapClerkRoleToTenantRole } = await import('./membership-sync')
    expect(mapClerkRoleToTenantRole(clerkRole)).toBe(expected)
  })
})

describe('verified Clerk receipt transaction', () => {
  it('rejects malformed identity without opening a transaction', async () => {
    const { handleClerkEvent } = await import('./membership-sync')
    const event = {
      type: 'organization.created' as const,
      data: { id: TENANT_ID, name: 'T', slug: 't' },
      timestamp: EVENT_TIMESTAMP,
    }

    await expect(
      handleClerkEvent(event, { providerEventId: ' ', payloadHash: 'a'.repeat(64) }),
    ).rejects.toThrow('event ID')
    await expect(
      handleClerkEvent(event, { providerEventId: 'evt', payloadHash: 'A'.repeat(64) }),
    ).rejects.toThrow('lowercase SHA-256')
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('claims and processes inside one serializable transaction', async () => {
    tenantUpsertMock.mockResolvedValue({ id: TENANT_ID })
    const { handleClerkEvent } = await import('./membership-sync')
    await expect(
      handleClerkEvent(
        {
          type: 'organization.created',
          data: { id: TENANT_ID, name: 'T', slug: 't' },
          timestamp: EVENT_TIMESTAMP,
        },
        VERIFIED_IDENTITY,
      ),
    ).resolves.toEqual({ replayed: false, welcomeEmailDeliveryId: null })

    expect(transactionMock).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    })
    expect(receiptCreateManyMock).toHaveBeenCalledWith({
      data: {
        providerEventId: VERIFIED_IDENTITY.providerEventId,
        eventType: 'organization.created',
        payloadHash: VERIFIED_IDENTITY.payloadHash,
      },
      skipDuplicates: true,
    })
  })

  it('returns an exact replay without state or audit writes', async () => {
    receiptCreateManyMock.mockResolvedValue({ count: 0 })
    receiptFindUniqueMock.mockResolvedValue({
      eventType: 'organizationMembership.created',
      payloadHash: VERIFIED_IDENTITY.payloadHash,
      welcomeEmailMembershipId: 'mem_1',
    })
    const { handleClerkEvent } = await import('./membership-sync')

    await expect(
      handleClerkEvent(
        {
          type: 'organizationMembership.created',
          data: membershipData,
          timestamp: EVENT_TIMESTAMP,
        },
        VERIFIED_IDENTITY,
      ),
    ).resolves.toEqual({ replayed: true, welcomeEmailDeliveryId: 'mem_1' })
    expect(membershipCreateMock).not.toHaveBeenCalled()
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })

  it('throws the exported conflict error for a mismatched duplicate', async () => {
    receiptCreateManyMock.mockResolvedValue({ count: 0 })
    receiptFindUniqueMock.mockResolvedValue({
      eventType: 'organizationMembership.created',
      payloadHash: 'b'.repeat(64),
    })
    const { handleClerkEvent, isClerkWebhookReceiptConflictError } =
      await import('./membership-sync')

    const error = await handleClerkEvent(
      {
        type: 'organizationMembership.created',
        data: membershipData,
        timestamp: EVENT_TIMESTAMP,
      },
      VERIFIED_IDENTITY,
    ).catch((caught: unknown) => caught)
    expect(isClerkWebhookReceiptConflictError(error)).toBe(true)
    expect(membershipCreateMock).not.toHaveBeenCalled()
  })

  it.each(['P2002', 'P2034'])(
    'retries %s transaction conflicts at most three times',
    async (code) => {
      transactionMock
        .mockRejectedValueOnce({ code })
        .mockRejectedValueOnce({ code })
        .mockResolvedValueOnce({ replayed: false, welcomeEmailDeliveryId: null })
      const { handleClerkEvent } = await import('./membership-sync')

      await expect(
        handleClerkEvent(
          {
            type: 'organization.created',
            data: { id: TENANT_ID, name: 'T', slug: 't' },
            timestamp: EVENT_TIMESTAMP,
          },
          VERIFIED_IDENTITY,
        ),
      ).resolves.toEqual({ replayed: false, welcomeEmailDeliveryId: null })
      expect(transactionMock).toHaveBeenCalledTimes(3)
    },
  )

  it('propagates an audit failure so the transaction can roll back the receipt and state', async () => {
    tenantFindUniqueMock.mockResolvedValue({ id: TENANT_ID })
    userUpsertMock.mockResolvedValue({ id: USER_ID })
    auditLogCreateMock.mockRejectedValue(new Error('audit unavailable'))
    const { handleClerkEvent } = await import('./membership-sync')

    await expect(
      handleClerkEvent(
        {
          type: 'organizationMembership.created',
          data: membershipData,
          timestamp: EVENT_TIMESTAMP,
        },
        VERIFIED_IDENTITY,
      ),
    ).rejects.toThrow('audit unavailable')
  })
})

describe('membership synchronization', () => {
  it('creates the user, active membership, and audit when the tenant exists', async () => {
    tenantFindUniqueMock.mockResolvedValue({ id: TENANT_ID })
    userUpsertMock.mockResolvedValue({ id: USER_ID })
    const { handleClerkEvent } = await import('./membership-sync')

    await handleClerkEvent(
      {
        type: 'organizationMembership.created',
        data: membershipData,
        timestamp: EVENT_TIMESTAMP,
      },
      VERIFIED_IDENTITY,
    )
    expect(userUpsertMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: USER_ID } }))
    expect(membershipCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: 'OWNER', status: 'ACTIVE' }),
      }),
    )
    expect(receiptUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { welcomeEmailMembershipId: 'mem_1' } }),
    )
    expect(auditLogCreateMock).toHaveBeenCalledOnce()
  })

  it('creates a first user from Clerk current identifier payloads', async () => {
    tenantFindUniqueMock.mockResolvedValue({ id: TENANT_ID })
    userUpsertMock.mockResolvedValue({ id: USER_ID })
    const { handleClerkEvent } = await import('./membership-sync')

    await handleClerkEvent(
      {
        type: 'organizationMembership.created',
        data: membershipDataWithIdentifier,
        timestamp: EVENT_TIMESTAMP,
      },
      VERIFIED_IDENTITY,
    )

    expect(userUpsertMock).toHaveBeenCalledWith({
      where: { id: USER_ID },
      create: { id: USER_ID, email: 'alice@example.com', fullName: 'Alice Smith' },
      update: { email: 'alice@example.com', fullName: 'Alice Smith' },
    })
    expect(membershipCreateMock).toHaveBeenCalledOnce()
  })

  it('fails before user or membership writes when the tenant is absent', async () => {
    tenantFindUniqueMock.mockResolvedValue(null)
    const { handleClerkEvent } = await import('./membership-sync')

    await expect(
      handleClerkEvent(
        {
          type: 'organizationMembership.updated',
          data: membershipData,
          timestamp: EVENT_TIMESTAMP,
        },
        VERIFIED_IDENTITY,
      ),
    ).rejects.toThrow('dependency is not ready')
    expect(userUpsertMock).not.toHaveBeenCalled()
    expect(membershipCreateMock).not.toHaveBeenCalled()
    expect(loggerWarnMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_ID }))
    expect(loggerWarnMock.mock.calls[0]?.[0]).not.toHaveProperty('userId')
  })

  it('preserves an existing email when an update omits it', async () => {
    tenantFindUniqueMock.mockResolvedValue({ id: TENANT_ID })
    userFindUniqueMock.mockResolvedValue({ id: USER_ID })
    userUpdateMock.mockResolvedValue({ id: USER_ID })
    membershipFindUniqueMock.mockResolvedValue({
      id: 'mem_1',
      role: 'OWNER',
      status: 'ACTIVE',
      clerkEventTimestamp: BigInt(EVENT_TIMESTAMP - 1),
      welcomeEmailDeliveredAt: null,
    })
    const { handleClerkEvent } = await import('./membership-sync')

    await handleClerkEvent(
      {
        type: 'organizationMembership.updated',
        data: membershipDataWithoutEmail,
        timestamp: EVENT_TIMESTAMP,
      },
      VERIFIED_IDENTITY,
    )
    expect(userUpsertMock).not.toHaveBeenCalled()
    expect(userUpdateMock).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { fullName: 'Alice Smith' },
    })
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })

  it('fails before membership writes when an unknown user has no email', async () => {
    tenantFindUniqueMock.mockResolvedValue({ id: TENANT_ID })
    userFindUniqueMock.mockResolvedValue(null)
    const { handleClerkEvent } = await import('./membership-sync')
    await expect(
      handleClerkEvent(
        {
          type: 'organizationMembership.updated',
          data: membershipDataWithoutEmail,
          timestamp: EVENT_TIMESTAMP,
        },
        VERIFIED_IDENTITY,
      ),
    ).rejects.toThrow('user dependency is not ready')
    expect(membershipCreateMock).not.toHaveBeenCalled()
  })

  it('fails closed when an existing membership has no cutover cursor', async () => {
    tenantFindUniqueMock.mockResolvedValue({ id: TENANT_ID })
    membershipFindUniqueMock.mockResolvedValue({
      id: 'mem_legacy',
      role: 'OWNER',
      status: 'ACTIVE',
      clerkEventTimestamp: null,
      welcomeEmailDeliveredAt: null,
    })
    const { handleClerkEvent } = await import('./membership-sync')

    await expect(
      handleClerkEvent(
        {
          type: 'organizationMembership.updated',
          data: { ...membershipData, role: 'org:manager' },
          timestamp: EVENT_TIMESTAMP,
        },
        VERIFIED_IDENTITY,
      ),
    ).rejects.toThrow('cursor dependency is not ready')

    expect(userUpsertMock).not.toHaveBeenCalled()
    expect(membershipUpdateMock).not.toHaveBeenCalled()
    expect(auditLogCreateMock).not.toHaveBeenCalled()
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'clerk.webhook.membership_cursor_missing',
        tenantId: TENANT_ID,
      }),
    )
  })

  it('marks an existing membership removed and audits the transition', async () => {
    membershipFindUniqueMock.mockResolvedValue({
      id: 'mem_1',
      role: 'OWNER',
      status: 'ACTIVE',
      clerkEventTimestamp: BigInt(EVENT_TIMESTAMP - 1),
      welcomeEmailDeliveredAt: null,
    })
    membershipUpdateMock.mockResolvedValue({ id: 'mem_1', status: 'REMOVED' })
    const { handleClerkEvent } = await import('./membership-sync')

    await handleClerkEvent(
      {
        type: 'organizationMembership.deleted',
        data: membershipData,
        timestamp: EVENT_TIMESTAMP,
      },
      VERIFIED_IDENTITY,
    )
    expect(membershipUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'REMOVED',
          clerkEventTimestamp: BigInt(EVENT_TIMESTAMP),
          welcomeEmailDeliveredAt: expect.any(Date),
        }),
      }),
    )
    expect(auditLogCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          afterState: expect.objectContaining({ status: 'REMOVED' }),
        }),
      }),
    )
  })

  it('treats an already removed membership as a state-level no-op', async () => {
    membershipFindUniqueMock.mockResolvedValue({
      id: 'mem_1',
      role: 'OWNER',
      status: 'REMOVED',
      clerkEventTimestamp: BigInt(EVENT_TIMESTAMP),
      welcomeEmailDeliveredAt: new Date('2026-08-08T00:00:00.000Z'),
    })
    const { handleClerkEvent } = await import('./membership-sync')
    await handleClerkEvent(
      {
        type: 'organizationMembership.deleted',
        data: membershipData,
        timestamp: EVENT_TIMESTAMP,
      },
      VERIFIED_IDENTITY,
    )
    expect(membershipUpdateMock).not.toHaveBeenCalled()
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })
})

describe('welcome email durable completion', () => {
  it('skips a delivery that is already complete or whose membership is inactive', async () => {
    membershipFindFirstMock.mockResolvedValue({
      status: 'ACTIVE',
      welcomeEmailAttemptedAt: new Date('2026-08-07T23:00:00.000Z'),
      welcomeEmailDeliveredAt: new Date('2026-08-08T00:00:00.000Z'),
    })
    const { getWelcomeEmailDeliveryState } = await import('./membership-sync')

    await expect(getWelcomeEmailDeliveryState(TENANT_ID, 'mem_1')).resolves.toEqual({
      complete: true,
      attemptedAt: new Date('2026-08-07T23:00:00.000Z'),
    })
    expect(membershipFindFirstMock).toHaveBeenCalledWith({
      where: { id: 'mem_1', tenantId: TENANT_ID },
      select: {
        status: true,
        welcomeEmailAttemptedAt: true,
        welcomeEmailDeliveredAt: true,
      },
    })
  })

  it('persists the first provider attempt before returning it to the worker', async () => {
    const { beginWelcomeEmailDeliveryAttempt } = await import('./membership-sync')

    const state = await beginWelcomeEmailDeliveryAttempt(TENANT_ID, 'mem_1')

    expect(state).toEqual({ complete: false, attemptedAt: expect.any(Date) })
    expect(membershipUpdateManyMock).toHaveBeenCalledWith({
      where: {
        id: 'mem_1',
        tenantId: TENANT_ID,
        status: 'ACTIVE',
        welcomeEmailAttemptedAt: null,
        welcomeEmailDeliveredAt: null,
      },
      data: { welcomeEmailAttemptedAt: expect.any(Date) },
    })
  })

  it('persists completion with tenant and membership predicates', async () => {
    const { markWelcomeEmailDeliveryComplete } = await import('./membership-sync')

    await markWelcomeEmailDeliveryComplete(TENANT_ID, 'mem_1')

    expect(membershipUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 'mem_1', tenantId: TENANT_ID, welcomeEmailDeliveredAt: null },
      data: { welcomeEmailDeliveredAt: expect.any(Date) },
    })
  })
})
