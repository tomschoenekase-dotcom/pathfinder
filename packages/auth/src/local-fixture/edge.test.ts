import { NextRequest, NextResponse } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { clerkMiddleware } from './edge'

const handler = clerkMiddleware(async () => NextResponse.next())
const origin = 'http://127.0.0.1:56346'

function request(
  path: string,
  options: {
    method?: string | undefined
    origin?: string | undefined
    cookie?: string | undefined
    body?: string | undefined
  } = {},
) {
  return new NextRequest(`${origin}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      host: '127.0.0.1:56346',
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(options.body ? { body: options.body } : {}),
  })
}

function enable() {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('TORCHIKO_LOCAL_FIXTURE_AUTH', '1')
  vi.stubEnv('TORCHIKO_LOCAL_FIXTURE_PORT', '56346')
  vi.stubEnv('TORCHIKO_LOCAL_FIXTURE_COOKIE_KEY', 'a'.repeat(64))
}

afterEach(() => vi.unstubAllEnvs())

describe('fixture middleware request boundary', () => {
  it('refuses when the flag is missing', async () => {
    vi.stubEnv('TORCHIKO_LOCAL_FIXTURE_AUTH', '')
    expect((await handler(request('/sign-in'))).status).toBe(404)
  })

  it('rejects foreign and missing Origin on identity switches', async () => {
    enable()
    for (const originHeader of [undefined, 'https://evil.invalid']) {
      const response = await handler(
        request('/sign-in', {
          method: 'POST',
          origin: originHeader,
          body: 'identity=admin',
        }),
      )
      expect(response.status).toBe(404)
      expect(response.headers.get('set-cookie')).toBeNull()
    }
  })

  it('permits only a signed fixed selector and clears it on sign out', async () => {
    enable()
    const signIn = await handler(
      request('/sign-in', { method: 'POST', origin, body: 'identity=owner-a' }),
    )
    expect(signIn.status).toBe(303)
    expect(signIn.headers.get('location')).toBe('http://localhost:56346/')
    const cookie = signIn.headers.get('set-cookie')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=strict')
    const cookieHeader = cookie?.split(';', 1)[0]
    const state = await handler(request('/api/local-auth-state', { cookie: cookieHeader }))
    expect(await state.json()).toMatchObject({ selector: 'owner-a', orgId: 'org_LocalTenantA' })

    const tampered = await handler(
      request('/api/local-auth-state', {
        cookie: cookieHeader?.replace('owner-a', 'admin'),
      }),
    )
    expect(await tampered.json()).toBeNull()

    const signOut = await handler(
      request('/sign-out', { method: 'POST', origin, cookie: cookieHeader }),
    )
    expect(signOut.status).toBe(303)
    expect(signOut.headers.get('location')).toBe('http://localhost:56346/sign-in')
    expect(signOut.headers.get('set-cookie')).toContain('Expires=Thu, 01 Jan 1970')
  })

  it('rejects an unknown identity and a hosted environment', async () => {
    enable()
    const unknown = await handler(
      request('/sign-in', { method: 'POST', origin, body: 'identity=attacker' }),
    )
    expect(unknown.status).toBe(400)
    vi.stubEnv('RAILWAY_ENVIRONMENT', 'staging')
    expect((await handler(request('/sign-in'))).status).toBe(404)
  })

  it('never displays or accepts fixture sign-in on guest web', async () => {
    enable()
    vi.stubEnv('TORCHIKO_LOCAL_FIXTURE_PORT', '56345')
    for (const pathname of ['/sign-in', '/sign-up', '/sign-out']) {
      const webRequest = new NextRequest(`http://127.0.0.1:56345${pathname}`, {
        headers: { host: '127.0.0.1:56345' },
      })
      expect((await handler(webRequest)).status).toBe(404)
    }
    const webPost = new NextRequest('http://127.0.0.1:56345/sign-in', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:56345',
        origin: 'http://127.0.0.1:56345',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'identity=admin',
    })
    const response = await handler(webPost)
    expect(response.status).toBe(404)
    expect(response.headers.get('set-cookie')).toBeNull()
  })
})
