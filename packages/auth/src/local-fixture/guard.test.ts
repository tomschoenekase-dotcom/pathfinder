import { describe, expect, it } from 'vitest'

import {
  assertFixtureRequest,
  cookieFromHeader,
  fixtureIdentityForPort,
  fixtureIdentity,
  signFixtureSelector,
  verifyFixtureCookie,
} from './guard'

const key = 'a'.repeat(64)
const validEnvironment = {
  NODE_ENV: 'development',
  TORCHIKO_LOCAL_FIXTURE_AUTH: '1',
  TORCHIKO_LOCAL_FIXTURE_COOKIE_KEY: key,
}

function check(
  overrides: Parameters<typeof assertFixtureRequest>[0] = {
    host: '127.0.0.1:56346',
    port: 56346,
    environment: validEnvironment,
  },
) {
  assertFixtureRequest(overrides)
}

describe('local fixture auth refusal boundary', () => {
  it('allows only its exact development loopback host and port', () => {
    check()
    check({ host: 'localhost:56346', port: 56346, environment: validEnvironment })
    check({ host: '[::1]:56346', port: 56346, environment: validEnvironment })
    for (const host of [
      '0.0.0.0:56346',
      '192.168.1.10:56346',
      '127.0.0.2:56346',
      '2130706433:56346',
      'user@127.0.0.1:56346',
      '127.0.0.1:56345',
      '127.0.0.1',
      '127.0.0.1:56346.evil.invalid',
    ]) {
      expect(() => check({ host, port: 56346, environment: validEnvironment })).toThrow()
    }
    expect(() =>
      check({
        host: '127.0.0.1:56346',
        forwardedHost: 'external.invalid',
        port: 56346,
        environment: validEnvironment,
      }),
    ).toThrow()
  })

  it('refuses absent flag, production and every hosted prefix', () => {
    for (const environment of [
      { ...validEnvironment, TORCHIKO_LOCAL_FIXTURE_AUTH: '0' },
      { ...validEnvironment, NODE_ENV: 'production' },
      { ...validEnvironment, RAILWAY_ENVIRONMENT: 'staging' },
      { ...validEnvironment, RAILWAY_SERVICE_ID: 'fixture' },
      { ...validEnvironment, VERCEL: '1' },
      { ...validEnvironment, VERCEL_ENV: 'preview' },
      { ...validEnvironment, TORCHIKO_LOCAL_FIXTURE_COOKIE_KEY: '' },
    ]) {
      expect(() => check({ host: '127.0.0.1:56346', port: 56346, environment })).toThrow()
    }
  })

  it('accepts only three fixed identities and verifies signed cookies', async () => {
    expect(fixtureIdentity('admin')?.userId).toBe('user_LocalAdmin')
    expect(fixtureIdentity('owner-a')?.orgId).toBe('org_LocalTenantA')
    expect(fixtureIdentity('owner-b')?.orgId).toBe('org_LocalTenantB')
    expect(fixtureIdentity('other')).toBeNull()
    const token = await signFixtureSelector('admin', validEnvironment)
    expect((await verifyFixtureCookie(token, validEnvironment))?.selector).toBe('admin')
    expect(
      await verifyFixtureCookie(token.replace('admin', 'owner-a'), validEnvironment),
    ).toBeNull()
    expect(await verifyFixtureCookie('admin.' + '0'.repeat(64), validEnvironment)).toBeNull()
    expect(await verifyFixtureCookie('other.' + '0'.repeat(64), validEnvironment)).toBeNull()
    await expect(signFixtureSelector('other', validEnvironment)).rejects.toThrow()
    expect(cookieFromHeader(`x=1; torchiko_local_fixture=${token}; y=2`)).toBe(token)
    expect(await fixtureIdentityForPort(56345, token, validEnvironment)).toBeNull()
    expect((await fixtureIdentityForPort(56346, token, validEnvironment))?.selector).toBe('admin')
  })
})
