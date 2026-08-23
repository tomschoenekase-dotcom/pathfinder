const AUTH_ROUTES = ['/sign-in', '/sign-up']

// Clerk sends webhook POST requests without a session cookie. Requiring auth
// here would redirect the webhook and prevent automatic tenant creation.
const PUBLIC_ROUTES = [
  '/api/agent-bridge',
  '/api/mcp',
  '/api/platform-worker/founder-decisions',
  '/api/integrations/gmail/pubsub',
  '/api/webhooks/clerk',
  '/api/webhooks/stripe',
  '/api/webhooks/resend',
]
const PUBLIC_ROUTE_PREFIXES = ['/api/agent-bridge/', '/api/mcp/']

const INTERNAL_WORKSPACE_ROUTES = ['/analytics', '/chat-design', '/engagement-questions'] as const

type DashboardAccessInput = {
  pathname: string
  userId: string | null | undefined
  orgId: string | null | undefined
  platformRole: unknown
  adminTenantOverride?: string | undefined
}

export type DashboardAccessDecision = 'next' | 'sign-in' | 'root' | 'onboarding'

export function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/')
}

export function isPublicDashboardPath(
  pathname: string,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  return (
    AUTH_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`)) ||
    PUBLIC_ROUTES.includes(pathname) ||
    PUBLIC_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    (nodeEnv === 'development' &&
      (pathname === '/dev-fixtures' || pathname.startsWith('/dev-fixtures/')))
  )
}

export function isInternalWorkspacePath(pathname: string): boolean {
  return INTERNAL_WORKSPACE_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  )
}

export function resolveDashboardAccess({
  pathname,
  userId,
  orgId,
  platformRole,
  adminTenantOverride,
}: DashboardAccessInput): DashboardAccessDecision {
  if (isPublicDashboardPath(pathname)) return 'next'
  if (!userId) return 'sign-in'

  const isPlatformAdmin = platformRole === 'PLATFORM_ADMIN'
  if (isAdminPath(pathname)) return isPlatformAdmin ? 'next' : 'root'

  const effectiveOrgId = orgId ?? (isPlatformAdmin ? adminTenantOverride : undefined)
  if (!effectiveOrgId && pathname !== '/onboarding') return 'onboarding'
  if (isInternalWorkspacePath(pathname) && !isPlatformAdmin) return 'root'
  return 'next'
}
