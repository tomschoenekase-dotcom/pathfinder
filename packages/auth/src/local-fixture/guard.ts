/** Packet 14's disposable, loopback-only fixture. Never import from product auth. */
export const LOCAL_FIXTURE_MARKER = 'torchiko-local-fixture-auth-p14'
export const FIXTURE_COOKIE = 'torchiko_local_fixture'

export type FixtureSelector = 'admin' | 'owner-a' | 'owner-b'

export type FixtureIdentity = {
  selector: FixtureSelector
  userId: string
  orgId: string | null
  orgRole: 'org:admin' | null
  sessionClaims: { iss: string; publicMetadata: { platform_role?: string } }
  publicMetadata: { platform_role?: string }
}

const ISSUER = 'https://fixture.invalid'
const IDENTITIES: Record<FixtureSelector, FixtureIdentity> = {
  admin: {
    selector: 'admin',
    userId: 'user_LocalAdmin',
    orgId: null,
    orgRole: null,
    sessionClaims: { iss: ISSUER, publicMetadata: { platform_role: 'PLATFORM_ADMIN' } },
    publicMetadata: { platform_role: 'PLATFORM_ADMIN' },
  },
  'owner-a': {
    selector: 'owner-a',
    userId: 'user_LocalOwnerA',
    orgId: 'org_LocalTenantA',
    orgRole: 'org:admin',
    sessionClaims: { iss: ISSUER, publicMetadata: {} },
    publicMetadata: {},
  },
  'owner-b': {
    selector: 'owner-b',
    userId: 'user_LocalOwnerB',
    orgId: 'org_LocalTenantB',
    orgRole: 'org:admin',
    sessionClaims: { iss: ISSUER, publicMetadata: {} },
    publicMetadata: {},
  },
}

export function fixtureIdentity(selector: string): FixtureIdentity | null {
  return Object.hasOwn(IDENTITIES, selector) ? IDENTITIES[selector as FixtureSelector] : null
}

export function assertFixtureRequest(input: {
  host: string | null
  forwardedHost?: string | null
  port: 56345 | 56346
  environment?: Readonly<Record<string, string | undefined>>
}): void {
  const env = input.environment ?? process.env
  if (env.TORCHIKO_LOCAL_FIXTURE_AUTH !== '1' || env.NODE_ENV !== 'development') {
    throw new Error('Local fixture auth disabled')
  }
  if (Object.keys(env).some((name) => name.startsWith('RAILWAY_') || name.startsWith('VERCEL'))) {
    throw new Error('Local fixture auth refused in a hosted environment')
  }
  const allowed = [`127.0.0.1:${input.port}`, `localhost:${input.port}`, `[::1]:${input.port}`]
  if (!input.host || !allowed.includes(input.host)) {
    throw new Error('Local fixture auth requires its exact loopback host and port')
  }
  if (input.forwardedHost && input.forwardedHost !== input.host) {
    throw new Error('Local fixture auth refused a forwarded host override')
  }
  if (!/^[a-f0-9]{64}$/u.test(env.TORCHIKO_LOCAL_FIXTURE_COOKIE_KEY ?? '')) {
    throw new Error('Local fixture auth signing key unavailable')
  }
}

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../gu) ?? [], (part) => Number.parseInt(part, 16))
}

function bytesHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function signingKey(
  secret: string,
): Promise<Awaited<ReturnType<typeof crypto.subtle.importKey>>> {
  return crypto.subtle.importKey(
    'raw',
    hexBytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

export async function signFixtureSelector(
  selector: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  if (!fixtureIdentity(selector)) throw new Error('Unknown local fixture identity')
  const secret = environment.TORCHIKO_LOCAL_FIXTURE_COOKIE_KEY
  if (!secret || !/^[a-f0-9]{64}$/u.test(secret)) throw new Error('Missing fixture signing key')
  const signature = await crypto.subtle.sign(
    'HMAC',
    await signingKey(secret),
    new TextEncoder().encode(selector),
  )
  return `${selector}.${bytesHex(new Uint8Array(signature))}`
}

export async function verifyFixtureCookie(
  cookieValue: string | null,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<FixtureIdentity | null> {
  if (!cookieValue) return null
  const [selector, signature, extra] = cookieValue.split('.')
  if (
    extra !== undefined ||
    !selector ||
    !fixtureIdentity(selector) ||
    !signature ||
    !/^[a-f0-9]{64}$/u.test(signature)
  )
    return null
  const secret = environment.TORCHIKO_LOCAL_FIXTURE_COOKIE_KEY
  if (!secret || !/^[a-f0-9]{64}$/u.test(secret)) return null
  const valid = await crypto.subtle.verify(
    'HMAC',
    await signingKey(secret),
    hexBytes(signature),
    new TextEncoder().encode(selector),
  )
  return valid ? fixtureIdentity(selector) : null
}

export async function fixtureIdentityForPort(
  port: 56345 | 56346,
  cookieValue: string | null,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<FixtureIdentity | null> {
  // Cookies are scoped by host, not port. The guest web app must stay anonymous
  // even when the same browser has signed in to the dashboard on 127.0.0.1.
  if (port === 56345) return null
  return verifyFixtureCookie(cookieValue, environment)
}

export function cookieFromHeader(header: string | null): string | null {
  if (!header) return null
  for (const segment of header.split(';')) {
    const [name, ...value] = segment.trim().split('=')
    if (name === FIXTURE_COOKIE) return value.join('=')
  }
  return null
}
