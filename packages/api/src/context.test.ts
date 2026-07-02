import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveSessionMock } = vi.hoisted(() => ({
  resolveSessionMock: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  db: {},
}))

vi.mock('@pathfinder/auth', () => ({
  resolveSession: resolveSessionMock,
}))

import { createTRPCContext } from './context'

describe('createTRPCContext', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('uses pf_admin_tenant as the active tenant for platform admins', async () => {
    resolveSessionMock.mockResolvedValueOnce({
      userId: 'admin_1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin: true,
    })

    const ctx = await createTRPCContext({
      req: new Request('https://dashboard.pathfinder.local/', {
        headers: { cookie: 'other=1; pf_admin_tenant=tenant_override' },
      }),
    })

    expect(ctx.session.activeTenantId).toBe('tenant_override')
  })

  it('ignores pf_admin_tenant for non-admin users', async () => {
    resolveSessionMock.mockResolvedValueOnce({
      userId: 'user_1',
      activeTenantId: 'tenant_real',
      role: 'OWNER',
      isPlatformAdmin: false,
    })

    const ctx = await createTRPCContext({
      req: new Request('https://dashboard.pathfinder.local/', {
        headers: { cookie: 'pf_admin_tenant=tenant_override' },
      }),
    })

    expect(ctx.session.activeTenantId).toBe('tenant_real')
  })
})
