const AUTH_ROUTES = ['/sign-in', '/sign-up']

// Clerk sends webhook POST requests without a session cookie. Requiring auth
// here would redirect the webhook and prevent automatic tenant creation.
const PUBLIC_ROUTES = [
  '/api/agent-bridge',
  '/api/mcp',
  '/api/operator/mcp',
  '/api/platform-worker/founder-decisions',
  '/api/platform-worker/founder-operating-view',
  '/api/platform-worker/operations-readiness',
  '/api/platform-worker/release-evidence',
  '/api/integrations/gmail/pubsub',
  '/api/webhooks/clerk',
  '/api/webhooks/stripe',
  '/api/webhooks/resend',
  // The Dot operator's OAuth authorization server. Each handler is dark unless
  // OPERATOR_OAUTH_ENABLED and authenticates by PKCE, token or DCR limits itself.
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
  // No OIDC here: answer the discovery probe with a plain 404, not a sign-in redirect.
  '/.well-known/openid-configuration',
  '/oauth/register',
  '/oauth/token',
  '/oauth/revoke',
]
const PUBLIC_ROUTE_PREFIXES = [
  '/api/agent-bridge/',
  '/api/mcp/',
  '/.well-known/oauth-protected-resource/',
]

// Human operator consent and one-tap approval. They need a signed-in platform admin but no
// organization, so a phone with only a Clerk session can approve. Handlers re-check the
// operator allowlist and require a strict reverification before any state change.
const OPERATOR_HUMAN_ROUTES = [
  '/oauth/arm',
  '/oauth/authorize',
  '/api/operator/arm',
  '/api/operator/consent',
  '/api/operator/approve',
  '/api/operator/autonomy',
  '/api/operator/revoke',
]
const OPERATOR_HUMAN_PREFIXES = ['/approve/']

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

export function isOperatorHumanPath(pathname: string): boolean {
  return (
    OPERATOR_HUMAN_ROUTES.includes(pathname) ||
    OPERATOR_HUMAN_PREFIXES.some(
      (prefix) => pathname.startsWith(prefix) && pathname.length > prefix.length,
    )
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
  if (isAdminPath(pathname) || isOperatorHumanPath(pathname)) {
    return isPlatformAdmin ? 'next' : 'root'
  }

  const effectiveOrgId = orgId ?? (isPlatformAdmin ? adminTenantOverride : undefined)
  if (!effectiveOrgId && pathname !== '/onboarding') return 'onboarding'
  if (isInternalWorkspacePath(pathname) && !isPlatformAdmin) return 'root'
  return 'next'
}
