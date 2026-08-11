import { describe, expect, it } from 'vitest'

import { isAdminPath, isInternalWorkspacePath, resolveDashboardAccess } from './middleware-access'

const signedIn = {
  userId: 'user_1',
  orgId: 'org_1',
  platformRole: undefined,
}

describe('dashboard middleware access policy', () => {
  it.each(['/admin', '/admin/', '/admin/clients', '/admin/clients/tenant_1'])(
    'recognizes the admin shell at %s',
    (pathname) => {
      expect(isAdminPath(pathname)).toBe(true)
    },
  )

  it.each(['/administrator', '/administer', '/api/admin/impersonate', '/venues/admin'])(
    'does not treat the prefix-adjacent path %s as the admin shell',
    (pathname) => {
      expect(isAdminPath(pathname)).toBe(false)
    },
  )

  it('sends unauthenticated admin requests through Clerk sign-in', () => {
    expect(
      resolveDashboardAccess({
        pathname: '/admin/clients',
        userId: null,
        orgId: null,
        platformRole: undefined,
      }),
    ).toBe('sign-in')
  })

  it.each(['/admin', '/admin/clients'])('blocks non-platform admins from %s', (pathname) => {
    expect(resolveDashboardAccess({ ...signedIn, pathname })).toBe('root')
  })

  it.each(['/admin', '/admin/clients'])('allows platform admins through %s', (pathname) => {
    expect(resolveDashboardAccess({ ...signedIn, pathname, platformRole: 'PLATFORM_ADMIN' })).toBe(
      'next',
    )
  })

  it('does not let a tenant override grant platform-admin access', () => {
    expect(
      resolveDashboardAccess({
        ...signedIn,
        pathname: '/admin',
        orgId: null,
        adminTenantOverride: 'tenant_target',
      }),
    ).toBe('root')
  })

  it.each([
    '/analytics',
    '/chat-design',
    '/engagement-questions',
    '/venues',
    '/venues/venue_1/import',
    '/weekly-reports',
  ])('keeps the internal workspace route %s unavailable to client users', (pathname) => {
    expect(isInternalWorkspacePath(pathname)).toBe(true)
    expect(resolveDashboardAccess({ ...signedIn, pathname })).toBe('root')
    expect(resolveDashboardAccess({ ...signedIn, pathname, platformRole: 'PLATFORM_ADMIN' })).toBe(
      'next',
    )
  })

  it.each(['/', '/ai-controls', '/operational-updates', '/support', '/settings', '/onboarding'])(
    'keeps the client portal route %s available to client users',
    (pathname) => {
      expect(isInternalWorkspacePath(pathname)).toBe(false)
      expect(resolveDashboardAccess({ ...signedIn, pathname })).toBe('next')
    },
  )

  it('preserves tenant onboarding for a signed-in user without an organization', () => {
    expect(
      resolveDashboardAccess({
        ...signedIn,
        pathname: '/venues',
        orgId: null,
      }),
    ).toBe('onboarding')
    expect(
      resolveDashboardAccess({
        ...signedIn,
        pathname: '/onboarding',
        orgId: null,
      }),
    ).toBe('next')
  })

  it.each(['/sign-in', '/sign-in/sso-callback', '/sign-up', '/api/webhooks/clerk'])(
    'preserves the public boundary for %s',
    (pathname) => {
      expect(
        resolveDashboardAccess({
          pathname,
          userId: null,
          orgId: null,
          platformRole: undefined,
        }),
      ).toBe('next')
    },
  )

  it.each(['/sign-in-evil', '/sign-upgrade', '/api/webhooks/clerk-attacker'])(
    'does not make the prefix-adjacent path %s public',
    (pathname) => {
      expect(
        resolveDashboardAccess({
          pathname,
          userId: null,
          orgId: null,
          platformRole: undefined,
        }),
      ).toBe('sign-in')
    },
  )

  it('keeps API admin authorization owned by the route', () => {
    expect(resolveDashboardAccess({ ...signedIn, pathname: '/api/admin/impersonate' })).toBe('next')
  })
})
