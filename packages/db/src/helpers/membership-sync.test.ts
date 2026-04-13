import { beforeEach, describe, expect, it, vi } from 'vitest'

const tenantFindUniqueMock = vi.fn()
const tenantUpsertMock = vi.fn()
const userUpsertMock = vi.fn()
const membershipUpsertMock = vi.fn()
const membershipFindUniqueMock = vi.fn()
const membershipUpdateMock = vi.fn()
const auditLogCreateMock = vi.fn()
const loggerWarnMock = vi.fn()
const loggerInfoMock = vi.fn()

vi.mock('../client', () => ({
  db: {
    tenant: {
      findUnique: tenantFindUniqueMock,
      upsert: tenantUpsertMock,
    },
    user: {
      upsert: userUpsertMock,
    },
    tenantMembership: {
      upsert: membershipUpsertMock,
      findUnique: membershipFindUniqueMock,
      update: membershipUpdateMock,
    },
    auditLog: {
      create: auditLogCreateMock,
    },
  },
}))

vi.mock('@pathfinder/config/logger', () => ({
  logger: {
    warn: loggerWarnMock,
    info: loggerInfoMock,
    error: vi.fn(),
  },
}))

const TENANT_ID = 'org_tenant1'
const USER_ID = 'user_abc'

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

describe('mapClerkRoleToTenantRole', () => {
  it('maps org:admin → OWNER', async () => {
    const { mapClerkRoleToTenantRole } = await import('./membership-sync')
    expect(mapClerkRoleToTenantRole('org:admin')).toBe('OWNER')
  })

  it('maps org:owner → OWNER', async () => {
    const { mapClerkRoleToTenantRole } = await import('./membership-sync')
    expect(mapClerkRoleToTenantRole('org:owner')).toBe('OWNER')
  })

  it('maps org:manager → MANAGER', async () => {
    const { mapClerkRoleToTenantRole } = await import('./membership-sync')
    expect(mapClerkRoleToTenantRole('org:manager')).toBe('MANAGER')
  })

  it('maps org:member → STAFF', async () => {
    const { mapClerkRoleToTenantRole } = await import('./membership-sync')
    expect(mapClerkRoleToTenantRole('org:member')).toBe('STAFF')
  })

  it('maps unknown roles → STAFF', async () => {
    const { mapClerkRoleToTenantRole } = await import('./membership-sync')
    expect(mapClerkRoleToTenantRole('org:custom_role')).toBe('STAFF')
  })
})

describe('syncMembershipCreated (via handleClerkEvent)', () => {
  beforeEach(() => {
    tenantFindUniqueMock.mockReset()
    userUpsertMock.mockReset()
    membershipUpsertMock.mockReset()
    auditLogCreateMock.mockReset()
    loggerWarnMock.mockReset()

    auditLogCreateMock.mockResolvedValue({ id: 'audit_1' })
  })

  it('upserts User and TenantMembership when tenant exists', async () => {
    tenantFindUniqueMock.mockResolvedValueOnce({ id: TENANT_ID })
    userUpsertMock.mockResolvedValueOnce({ id: USER_ID })
    membershipUpsertMock.mockResolvedValueOnce({ id: 'mem_1', tenantId: TENANT_ID, userId: USER_ID, role: 'OWNER', status: 'ACTIVE' })

    const { handleClerkEvent } = await import('./membership-sync')
    await handleClerkEvent({ type: 'organizationMembership.created', data: membershipData })

    expect(userUpsertMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: USER_ID },
      create: expect.objectContaining({ id: USER_ID, email: 'alice@example.com' }),
    }))
    expect(membershipUpsertMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId_userId: { tenantId: TENANT_ID, userId: USER_ID } },
      create: expect.objectContaining({ tenantId: TENANT_ID, userId: USER_ID, role: 'OWNER', status: 'ACTIVE' }),
      update: expect.objectContaining({ role: 'OWNER', status: 'ACTIVE' }),
    }))
    expect(auditLogCreateMock).toHaveBeenCalled()
  })

  it('skips membership creation when tenant does not exist yet', async () => {
    tenantFindUniqueMock.mockResolvedValueOnce(null)

    const { handleClerkEvent } = await import('./membership-sync')
    await handleClerkEvent({ type: 'organizationMembership.created', data: membershipData })

    expect(userUpsertMock).not.toHaveBeenCalled()
    expect(membershipUpsertMock).not.toHaveBeenCalled()
    expect(loggerWarnMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'clerk.webhook.tenant_not_found',
    }))
  })

  it('calling created event twice does not fail (upsert idempotency)', async () => {
    tenantFindUniqueMock.mockResolvedValue({ id: TENANT_ID })
    userUpsertMock.mockResolvedValue({ id: USER_ID })
    membershipUpsertMock.mockResolvedValue({ id: 'mem_1', tenantId: TENANT_ID, userId: USER_ID, role: 'OWNER', status: 'ACTIVE' })

    const { handleClerkEvent } = await import('./membership-sync')
    await handleClerkEvent({ type: 'organizationMembership.created', data: membershipData })
    await handleClerkEvent({ type: 'organizationMembership.created', data: membershipData })

    expect(membershipUpsertMock).toHaveBeenCalledTimes(2)
  })
})

describe('syncMembershipDeleted (via handleClerkEvent)', () => {
  beforeEach(() => {
    membershipFindUniqueMock.mockReset()
    membershipUpdateMock.mockReset()
    auditLogCreateMock.mockReset()
    loggerWarnMock.mockReset()

    auditLogCreateMock.mockResolvedValue({ id: 'audit_1' })
  })

  it('sets status REMOVED and does not delete the row', async () => {
    membershipFindUniqueMock.mockResolvedValueOnce({ id: 'mem_1', role: 'OWNER', status: 'ACTIVE' })
    membershipUpdateMock.mockResolvedValueOnce({ id: 'mem_1', tenantId: TENANT_ID, userId: USER_ID, role: 'OWNER', status: 'REMOVED' })

    const { handleClerkEvent } = await import('./membership-sync')
    await handleClerkEvent({ type: 'organizationMembership.deleted', data: membershipData })

    expect(membershipUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: 'REMOVED' },
    }))
    expect(auditLogCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        afterState: expect.objectContaining({ status: 'REMOVED' }),
      }),
    }))
  })

  it('logs a warning and does nothing when membership row does not exist', async () => {
    membershipFindUniqueMock.mockResolvedValueOnce(null)

    const { handleClerkEvent } = await import('./membership-sync')
    await handleClerkEvent({ type: 'organizationMembership.deleted', data: membershipData })

    expect(membershipUpdateMock).not.toHaveBeenCalled()
    expect(loggerWarnMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'clerk.webhook.membership_not_found_on_delete',
    }))
  })
})
