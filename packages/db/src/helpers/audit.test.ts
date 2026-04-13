import { beforeEach, describe, expect, it, vi } from 'vitest'

const createMock = vi.fn()
const warnMock = vi.fn()

vi.mock('../client', () => ({
  db: {
    auditLog: {
      create: createMock,
    },
  },
}))

vi.mock('@pathfinder/config/logger', () => ({
  logger: {
    warn: warnMock,
  },
}))

describe('writeAuditLog', () => {
  beforeEach(() => {
    createMock.mockReset()
    warnMock.mockReset()
  })

  it('creates a platform-level audit log when tenantId is omitted', async () => {
    createMock.mockResolvedValueOnce({ id: 'audit_1' })

    const { writeAuditLog } = await import('./audit')

    await writeAuditLog({
      actorId: 'user_1',
      actorRole: 'PLATFORM_ADMIN',
      action: 'admin.tenant.viewed',
      targetType: 'Tenant',
      targetId: 'tenant_1',
    })

    expect(createMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'user_1',
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.tenant.viewed',
        targetType: 'Tenant',
        targetId: 'tenant_1',
      }),
    })
    expect(createMock.mock.calls[0]?.[0]?.data.tenantId).toBeUndefined()
    expect(warnMock).not.toHaveBeenCalled()
  })

  it('logs and swallows database errors', async () => {
    createMock.mockRejectedValueOnce(new Error('db unavailable'))

    const { writeAuditLog } = await import('./audit')

    await expect(
      writeAuditLog({
        tenantId: 'tenant_1',
        actorId: 'user_1',
        actorRole: 'OWNER',
        action: 'tenant.updated',
        targetType: 'Tenant',
        targetId: 'tenant_1',
      }),
    ).resolves.toBeUndefined()

    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'audit-log.write-failed',
        tenantId: 'tenant_1',
        actorId: 'user_1',
        error: 'db unavailable',
      }),
    )
  })
})
