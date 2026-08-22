import { clerkMiddleware } from '@clerk/nextjs/server'
import { NextResponse, type NextRequest } from 'next/server'

import { buildWidgetFrameAncestors } from './lib/widget-origin-policy'

const DENY_MICROPHONE_POLICY = 'camera=(), geolocation=(self), microphone=(), payment=(), usb=()'
const VISITOR_VOICE_POLICY = 'camera=(), geolocation=(self), microphone=(self), payment=(), usb=()'

export function isStandaloneVisitorVoicePath(pathname: string): boolean {
  const segments = pathname.split('/').filter(Boolean)
  return (
    (segments.length === 2 && segments[1] === 'chat') ||
    (segments.length === 4 && segments[1] === 'layer' && segments[3] === 'chat')
  )
}

export function getEmbedResponseHeaders(
  request: Pick<NextRequest, 'nextUrl'>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Headers | null {
  const { pathname, search } = request.nextUrl
  if (pathname !== '/embed' && !pathname.startsWith('/embed/')) return null

  // Third-party framing is limited to the queryless widget route. In particular,
  // the native-shell `?chrome=hidden` presentation remains self-frame-only.
  const framingPathname = search.length === 0 ? pathname : '/embed'

  return new Headers({
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': buildWidgetFrameAncestors(framingPathname, environment),
    // Voice remains feature/entitlement gated and getUserMedia still requires an
    // explicit visitor action. The parent widget must separately delegate this
    // capability with its iframe allow attribute.
    'Permissions-Policy': VISITOR_VOICE_POLICY,
    'Referrer-Policy': 'no-referrer',
    'X-PathFinder-Revision':
      environment.RAILWAY_GIT_COMMIT_SHA ?? environment.VERCEL_GIT_COMMIT_SHA ?? 'unknown',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
  })
}

export function getPageResponseHeaders(request: Pick<NextRequest, 'nextUrl'>): Headers | null {
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

  return new Headers({
    'Content-Security-Policy': "frame-ancestors 'self'",
    'Permissions-Policy': isStandaloneVisitorVoicePath(pathname)
      ? VISITOR_VOICE_POLICY
      : DENY_MICROPHONE_POLICY,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
  })
}

// clerkMiddleware() is required for auth() to work in server components.
// The web app is guest-facing; no routes are protected.
export default clerkMiddleware((_auth, request) => {
  const headers = getEmbedResponseHeaders(request) ?? getPageResponseHeaders(request)
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
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
