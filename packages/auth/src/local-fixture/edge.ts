/** Middleware half of Packet 14's webpack-only Clerk replacement. */
import { NextResponse, type NextRequest } from 'next/server'

import {
  FIXTURE_COOKIE,
  assertFixtureRequest,
  cookieFromHeader,
  fixtureIdentityForPort,
  fixtureIdentity,
  signFixtureSelector,
  type FixtureIdentity,
} from './guard'

type FixtureAuthState = {
  userId: string | null
  orgId: string | null
  orgRole: 'org:admin' | null
  sessionClaims: FixtureIdentity['sessionClaims'] | null
  redirectToSignIn: () => NextResponse
}

type MiddlewareHandler = (
  auth: () => Promise<FixtureAuthState>,
  request: NextRequest,
) => Promise<Response | void> | Response | void

function expectedPort(): 56345 | 56346 {
  if (process.env.TORCHIKO_LOCAL_FIXTURE_PORT === '56345') return 56345
  if (process.env.TORCHIKO_LOCAL_FIXTURE_PORT === '56346') return 56346
  throw new Error('Local fixture auth port unavailable')
}

function assertSameOrigin(request: NextRequest): void {
  const origin = request.headers.get('origin')
  const directHost = request.headers.get('host')
  if (!directHost || origin !== `http://${directHost}`) {
    throw new Error('Local fixture auth origin mismatch')
  }
}

function localRedirect(pathname: string, status = 307): NextResponse {
  return NextResponse.redirect(new URL(pathname, `http://localhost:${expectedPort()}`), status)
}

function stateFor(identity: FixtureIdentity | null): FixtureAuthState {
  return {
    userId: identity?.userId ?? null,
    orgId: identity?.orgId ?? null,
    orgRole: identity?.orgRole ?? null,
    sessionClaims: identity?.sessionClaims ?? null,
    redirectToSignIn: () => localRedirect('/sign-in'),
  }
}

export function clerkMiddleware(handler: MiddlewareHandler) {
  return async function localFixtureMiddleware(request: NextRequest): Promise<Response> {
    try {
      assertFixtureRequest({
        host: request.headers.get('host'),
        forwardedHost: request.headers.get('x-forwarded-host'),
        port: expectedPort(),
      })
      const { pathname } = request.nextUrl
      if (
        expectedPort() === 56345 &&
        ['/sign-in', '/sign-up', '/sign-out'].some(
          (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
        )
      ) {
        return new NextResponse('Local web is guest-only', { status: 404 })
      }
      if (expectedPort() === 56346 && request.method === 'POST' && pathname === '/sign-in') {
        assertSameOrigin(request)
        const form = await request.formData()
        const selector = form.get('identity')
        if (typeof selector !== 'string' || !fixtureIdentity(selector)) {
          return new NextResponse('Unknown local identity', { status: 400 })
        }
        const destination = selector === 'admin' ? '/admin' : '/'
        const response = localRedirect(destination, 303)
        response.cookies.set(FIXTURE_COOKIE, await signFixtureSelector(selector), {
          httpOnly: true,
          sameSite: 'strict',
          secure: false,
          path: '/',
        })
        return response
      }
      if (expectedPort() === 56346 && request.method === 'POST' && pathname === '/sign-out') {
        assertSameOrigin(request)
        const response = localRedirect('/sign-in', 303)
        response.cookies.delete(FIXTURE_COOKIE)
        return response
      }
      const identity = await fixtureIdentityForPort(
        expectedPort(),
        cookieFromHeader(request.headers.get('cookie')),
      )
      if (
        expectedPort() === 56346 &&
        request.method === 'GET' &&
        pathname === '/api/local-auth-state'
      ) {
        return NextResponse.json(
          identity
            ? {
                userId: identity.userId,
                orgId: identity.orgId,
                selector: identity.selector,
                platformAdmin: identity.selector === 'admin',
              }
            : null,
          { headers: { 'Cache-Control': 'private, no-store' } },
        )
      }
      return (await handler(async () => stateFor(identity), request)) ?? NextResponse.next()
    } catch {
      return new NextResponse('Local fixture auth unavailable', { status: 404 })
    }
  }
}

export function auth(): never {
  throw new Error('Server auth alias resolved in middleware runtime')
}

export function currentUser(): never {
  throw new Error('Server user alias resolved in middleware runtime')
}

export function clerkClient(): never {
  throw new Error('Clerk backend API is unavailable in local fixture auth')
}
