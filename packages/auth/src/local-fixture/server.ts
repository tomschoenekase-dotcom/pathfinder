/** Server half of Packet 14's webpack-only Clerk replacement. */
import { headers } from 'next/headers'

import {
  assertFixtureRequest,
  cookieFromHeader,
  fixtureIdentityForPort,
  type FixtureIdentity,
} from './guard'

function expectedPort(): 56345 | 56346 {
  const configured = process.env.TORCHIKO_LOCAL_FIXTURE_PORT
  if (configured === '56345') return 56345
  if (configured === '56346') return 56346
  throw new Error('Local fixture auth port unavailable')
}

async function currentIdentity(): Promise<FixtureIdentity | null> {
  const requestHeaders = await headers()
  assertFixtureRequest({
    host: requestHeaders.get('host'),
    forwardedHost: requestHeaders.get('x-forwarded-host'),
    port: expectedPort(),
  })
  return fixtureIdentityForPort(expectedPort(), cookieFromHeader(requestHeaders.get('cookie')))
}

export async function auth() {
  const identity = await currentIdentity()
  return {
    userId: identity?.userId ?? null,
    orgId: identity?.orgId ?? null,
    orgRole: identity?.orgRole ?? null,
    sessionClaims: identity?.sessionClaims ?? null,
  }
}

export async function currentUser() {
  const identity = await currentIdentity()
  if (!identity) return null
  return {
    id: identity.userId,
    publicMetadata: identity.publicMetadata,
    emailAddresses: [
      {
        id: `email_${identity.selector}`,
        emailAddress: `${identity.selector}@fixture.invalid`,
      },
    ],
    primaryEmailAddressId: `email_${identity.selector}`,
    firstName: identity.selector === 'admin' ? 'Local' : 'Synthetic',
    lastName: identity.selector === 'admin' ? 'Admin' : 'Owner',
    imageUrl: '',
  }
}

export async function clerkClient(): Promise<never> {
  throw new Error('Clerk backend API is unavailable in local fixture auth')
}

export function clerkMiddleware(): never {
  throw new Error('Clerk middleware alias resolved in the wrong runtime')
}
