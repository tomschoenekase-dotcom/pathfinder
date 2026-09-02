import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  findTenant: vi.fn(),
  writeAuditLogStrict: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock('@clerk/nextjs/server', () => ({ auth: mocks.auth }))
vi.mock('@pathfinder/db', () => ({
  db: { tenant: { findUnique: mocks.findTenant } },
  writeAuditLogStrict: mocks.writeAuditLogStrict,
}))
vi.mock('@pathfinder/config/logger', () => ({
  logger: { error: mocks.loggerError },
}))

import { POST } from './route'

function request(body: unknown, cookie?: string) {
  return new NextRequest('https://dashboard.example/api/admin/impersonate', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Torchiko test',
      'x-forwarded-for': '203.0.113.9, 10.0.0.1',
      ...(cookie ? { cookie: `pf_admin_tenant=${cookie}` } : {}),
    },
  })
}

function authenticate(platformRole: unknown = 'PLATFORM_ADMIN') {
  mocks.auth.mockResolvedValue({
    userId: 'admin_1',
    sessionClaims: { publicMetadata: { platform_role: platformRole } },
  })
}

describe('admin impersonation route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authenticate()
    mocks.findTenant.mockResolvedValue({ id: 'tenant_1' })
    mocks.writeAuditLogStrict.mockResolvedValue(undefined)
  })

  it('rejects unauthenticated requests before database or audit work', async () => {
    mocks.auth.mockResolvedValue({ userId: null, sessionClaims: null })

    const response = await POST(request({ tenantId: 'tenant_1' }))

    expect(response.status).toBe(401)
    expect(mocks.findTenant).not.toHaveBeenCalled()
    expect(mocks.writeAuditLogStrict).not.toHaveBeenCalled()
  })

  it('rejects authenticated non-platform admins', async () => {
    authenticate('OWNER')

    const response = await POST(request({ tenantId: 'tenant_1' }))

    expect(response.status).toBe(403)
    expect(mocks.findTenant).not.toHaveBeenCalled()
    expect(mocks.writeAuditLogStrict).not.toHaveBeenCalled()
  })

  it('validates the target tenant before auditing or setting a cookie', async () => {
    mocks.findTenant.mockResolvedValue(null)

    const response = await POST(request({ tenantId: 'tenant_missing' }))

    expect(response.status).toBe(404)
    expect(mocks.findTenant).toHaveBeenCalledWith({
      where: { id: 'tenant_missing' },
      select: { id: true },
    })
    expect(mocks.writeAuditLogStrict).not.toHaveBeenCalled()
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('audits a validated start before returning the secure impersonation cookie', async () => {
    const response = await POST(request({ tenantId: ' tenant_1 ' }))

    expect(response.status).toBe(200)
    expect(mocks.writeAuditLogStrict).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      actorId: 'admin_1',
      actorRole: 'PLATFORM_ADMIN',
      action: 'admin.impersonation.started',
      targetType: 'Tenant',
      targetId: 'tenant_1',
      afterState: { impersonatedTenantId: 'tenant_1' },
      ipAddress: '203.0.113.9',
      userAgent: 'Torchiko test',
    })
    expect(response.headers.get('set-cookie')).toContain('pf_admin_tenant=tenant_1')
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
    expect(response.headers.get('set-cookie')).toContain('SameSite=lax')
  })

  it('fails closed without a cookie when start auditing is unavailable', async () => {
    mocks.writeAuditLogStrict.mockRejectedValue(new Error('db unavailable'))

    const response = await POST(request({ tenantId: 'tenant_1' }))

    expect(response.status).toBe(503)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.impersonation.audit-failed',
        actorId: 'admin_1',
        targetId: 'tenant_1',
      }),
    )
  })

  it('audits the prior tenant before deleting an active impersonation cookie', async () => {
    const response = await POST(request({ tenantId: null }, 'tenant_previous'))

    expect(response.status).toBe(200)
    expect(mocks.findTenant).not.toHaveBeenCalled()
    expect(mocks.writeAuditLogStrict).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_previous',
        actorId: 'admin_1',
        action: 'admin.impersonation.stopped',
        targetId: 'tenant_previous',
        beforeState: { impersonatedTenantId: 'tenant_previous' },
      }),
    )
    expect(response.headers.get('set-cookie')).toContain('pf_admin_tenant=')
    expect(response.headers.get('set-cookie')).toContain('Expires=Thu, 01 Jan 1970')
  })

  it('fails closed without deleting the cookie when stop auditing is unavailable', async () => {
    mocks.writeAuditLogStrict.mockRejectedValue(new Error('db unavailable'))

    const response = await POST(request({ tenantId: null }, 'tenant_previous'))

    expect(response.status).toBe(503)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('treats stop without an active impersonation as an idempotent no-op', async () => {
    const response = await POST(request({ tenantId: null }))

    expect(response.status).toBe(200)
    expect(mocks.writeAuditLogStrict).not.toHaveBeenCalled()
  })

  it('rejects malformed target types', async () => {
    const response = await POST(request({ tenantId: 123 }))

    expect(response.status).toBe(400)
    expect(mocks.findTenant).not.toHaveBeenCalled()
    expect(mocks.writeAuditLogStrict).not.toHaveBeenCalled()
  })

  it('rejects an oversized body before database or audit work', async () => {
    const oversized = new NextRequest('https://dashboard.example/api/admin/impersonate', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json', 'content-length': '4097' },
    })

    const response = await POST(oversized)

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'Request body too large' })
    expect(mocks.findTenant).not.toHaveBeenCalled()
    expect(mocks.writeAuditLogStrict).not.toHaveBeenCalled()
  })

  it.each([[], 123, 'stop', null])(
    'rejects malformed top-level JSON without stopping impersonation: %j',
    async (body) => {
      const response = await POST(request(body, 'tenant_previous'))

      expect(response.status).toBe(400)
      expect(mocks.findTenant).not.toHaveBeenCalled()
      expect(mocks.writeAuditLogStrict).not.toHaveBeenCalled()
      expect(response.headers.get('set-cookie')).toBeNull()
    },
  )
})
