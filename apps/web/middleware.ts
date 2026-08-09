import { clerkMiddleware } from '@clerk/nextjs/server'
import { NextResponse, type NextRequest } from 'next/server'

import { buildWidgetFrameAncestors } from './lib/widget-origin-policy'

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
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
  })
}

// clerkMiddleware() is required for auth() to work in server components.
// The web app is guest-facing; no routes are protected.
export default clerkMiddleware((_auth, request) => {
  const headers = getEmbedResponseHeaders(request)
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
