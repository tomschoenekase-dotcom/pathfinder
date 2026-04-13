import { beforeEach, describe, expect, it, vi } from 'vitest'

const authMock = vi.fn()
const currentUserMock = vi.fn()

vi.mock('@clerk/nextjs/server', () => ({
  auth: authMock,
  currentUser: currentUserMock,
}))

describe('resolveSession', () => {
  beforeEach(() => {
    authMock.mockReset()
    currentUserMock.mockReset()
  })

  it('returns null when no Clerk session exists (anonymous visitor)', async () => {
    authMock.mockResolvedValueOnce({
      orgId: null,
      orgRole: null,
      userId: null,
    })

    const { resolveSession } = await import('./session')

    await expect(resolveSession(new Request('https://example.com'))).resolves.toBeNull()
  })

  it('maps Clerk org and platform metadata into session context', async () => {
    authMock.mockResolvedValueOnce({
      orgId: 'tenant_1',
      orgRole: 'org:admin',
      userId: 'user_1',
    })
    currentUserMock.mockResolvedValueOnce({
      publicMetadata: {
        platform_role: 'PLATFORM_ADMIN',
      },
    })

    const { resolveSession } = await import('./session')

    await expect(resolveSession(new Request('https://example.com'))).resolves.toEqual({
      userId: 'user_1',
      activeTenantId: 'tenant_1',
      role: 'OWNER',
      isPlatformAdmin: true,
    })
  })

  it('returns null tenant context for signed-in users without an active org', async () => {
    authMock.mockResolvedValueOnce({
      orgId: null,
      orgRole: null,
      userId: 'user_1',
    })
    currentUserMock.mockResolvedValueOnce({
      publicMetadata: {},
    })

    const { resolveSession } = await import('./session')

    await expect(resolveSession(new Request('https://example.com'))).resolves.toEqual({
      userId: 'user_1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin: false,
    })
  })

  it('documents the Clerk role mapping used by the package', async () => {
    const { sessionInternals } = await import('./session')

    expect(sessionInternals.mapClerkOrgRole('org:member')).toBe('STAFF')
    expect(sessionInternals.mapClerkOrgRole('org:manager')).toBe('MANAGER')
    expect(sessionInternals.mapClerkOrgRole('org:admin')).toBe('OWNER')
    expect(sessionInternals.mapClerkOrgRole('unknown-role')).toBeNull()
  })
})
