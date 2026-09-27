import { clerkMiddleware } from '@clerk/nextjs/server'
import { NextResponse, type NextRequest } from 'next/server'
import { resolveReleaseRevision } from '@pathfinder/config/release-identity'

import {
  buildWidgetFrameAncestors,
  extractExactWebsiteEmbedVenueSlug,
} from './lib/widget-origin-policy'
import { appearancePreviewParentOrigin } from './app/appearance-preview/preview-origin'

const DENY_MICROPHONE_POLICY = 'camera=(), geolocation=(self), microphone=(), payment=(), usb=()'
const VISITOR_VOICE_POLICY = 'camera=(), geolocation=(self), microphone=(self), payment=(), usb=()'
const INTERNAL_POLICY_TOKEN_HEADER = 'x-torchiko-internal-policy-token'
let warnedMissingInternalPolicyToken = false

function getInternalPolicyOrigin(
  environment: Readonly<Record<string, string | undefined>>,
): string | null {
  const configured = environment.INTERNAL_WEB_ORIGIN
  const port = environment.PORT ?? '3000'
  const candidate = configured ?? `http://127.0.0.1:${port}`
  try {
    const url = new URL(candidate)
    const exactOrigin = candidate === url.origin || candidate === `${url.origin}/`
    const loopbackHttp =
      url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (
      !exactOrigin ||
      url.username ||
      url.password ||
      (url.protocol !== 'https:' && !loopbackHttp)
    ) {
      return null
    }
    return url.origin
  } catch {
    return null
  }
}

export function isStandaloneVisitorVoicePath(pathname: string): boolean {
  const segments = pathname.split('/').filter(Boolean)
  return (
    (segments.length === 2 && segments[0] === 'app') ||
    (segments.length === 2 && segments[1] === 'chat') ||
    (segments.length === 4 && segments[1] === 'layer' && segments[3] === 'chat')
  )
}

export function getEmbedResponseHeaders(
  request: Pick<NextRequest, 'nextUrl'>,
  origins: readonly string[] = [],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Headers | null {
  const { pathname, search } = request.nextUrl
  if (pathname !== '/embed' && !pathname.startsWith('/embed/')) return null

  // Third-party framing is limited to canonical queryless website document routes.
  // In particular, app aliases and every query-bearing presentation remain self-frame-only.
  const framingPathname =
    search.length === 0 && extractExactWebsiteEmbedVenueSlug(pathname) ? pathname : '/embed'

  return new Headers({
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': buildWidgetFrameAncestors(
      framingPathname === pathname ? origins : [],
    ),
    // Voice remains feature/entitlement gated and getUserMedia still requires an
    // explicit visitor action. The parent widget must separately delegate this
    // capability with its iframe allow attribute.
    'Permissions-Policy': VISITOR_VOICE_POLICY,
    'Referrer-Policy': 'no-referrer',
    'X-PathFinder-Revision': resolveReleaseRevision(environment),
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
  })
}

export function getPageResponseHeaders(
  request: Pick<NextRequest, 'nextUrl'>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Headers | null {
  const { pathname } = request.nextUrl
  if (
    pathname === '/embed' ||
    pathname.startsWith('/embed/') ||
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/trpc' ||
    pathname.startsWith('/trpc/')
  ) {
    return null
  }

  // The data-free appearance preview is the only page the client portal may frame, and only
  // from the portal origin this service is configured with. X-Frame-Options cannot name an
  // origin, so it is omitted there and frame-ancestors carries the exact allowance.
  const previewParent =
    pathname === '/appearance-preview' ? appearancePreviewParentOrigin(environment) : null
  if (previewParent) {
    return new Headers({
      'Content-Security-Policy': `frame-ancestors 'self' ${previewParent}`,
      'Permissions-Policy': DENY_MICROPHONE_POLICY,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
    })
  }

  return new Headers({
    'Content-Security-Policy': "frame-ancestors 'self'",
    'Permissions-Policy': isStandaloneVisitorVoicePath(pathname)
      ? VISITOR_VOICE_POLICY
      : DENY_MICROPHONE_POLICY,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    ...(pathname.startsWith('/app/') ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
  })
}

// clerkMiddleware() is required for auth() to work in server components.
// The web app is guest-facing; no routes are protected.
export default clerkMiddleware(async (_auth, request) => {
  if (request.nextUrl.pathname.startsWith('/api/internal/embed-frame-policy/')) {
    return NextResponse.next()
  }
  let origins: readonly string[] = []
  const slug =
    request.nextUrl.search.length === 0
      ? extractExactWebsiteEmbedVenueSlug(request.nextUrl.pathname)
      : null
  if (slug) {
    try {
      const token = process.env.INTERNAL_POLICY_TOKEN
      if (!token) {
        if (!warnedMissingInternalPolicyToken) {
          warnedMissingInternalPolicyToken = true
          // eslint-disable-next-line no-console -- one process-scoped structured warning for a fail-closed configuration issue
          console.warn(
            JSON.stringify({
              event: 'internal_policy_token_missing',
              route: 'embed-frame-policy',
              action: 'using_self_only_csp',
            }),
          )
        }
      } else {
        const internalOrigin = getInternalPolicyOrigin(process.env)
        if (!internalOrigin) throw new Error('Internal web origin is invalid.')
        const response = await fetch(
          new URL(`/api/internal/embed-frame-policy/${encodeURIComponent(slug)}`, internalOrigin),
          {
            signal: AbortSignal.timeout(1_000),
            cache: 'no-store',
            headers: { [INTERNAL_POLICY_TOKEN_HEADER]: token },
          },
        )
        if (response.ok) {
          const payload: unknown = await response.json()
          if (
            typeof payload === 'object' &&
            payload !== null &&
            'origins' in payload &&
            Array.isArray(payload.origins) &&
            payload.origins.every((origin) => typeof origin === 'string')
          )
            origins = payload.origins
        }
      }
    } catch {
      // The frame policy remains self-only when the Node policy service is unavailable.
    }
  }
  const headers = getEmbedResponseHeaders(request, origins) ?? getPageResponseHeaders(request)
  if (!headers) return

  const response = NextResponse.next()
  headers.forEach((value, name) => response.headers.set(name, value))
  return response
})

export const config = {
  matcher: [
    // Keep every embed response inside the framing boundary, including paths
    // that look like static files and would be skipped by the generic matcher.
    '/embed/:path*',
    // Exclude the internal Node policy route from every generic/API matcher.
    '/((?!api/internal/embed-frame-policy(?:/|$)|_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api/(?!internal/embed-frame-policy(?:/|$))|trpc)(.*)',
  ],
}
