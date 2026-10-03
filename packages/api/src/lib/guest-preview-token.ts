import { createHmac, timingSafeEqual } from 'node:crypto'

import { z } from 'zod'

/**
 * Private guest preview links. A token is a stateless, HMAC-signed claim that binds exactly one
 * tenant, one venue and one version (a native release or a reviewable package draft) for a short
 * time. It is the only authority the preview route accepts: no session, no cookie, and no part of
 * the claim can be edited without invalidating the signature.
 */
export const GUEST_PREVIEW_TOKEN_DEFAULT_TTL_SECONDS = 15 * 60
export const GUEST_PREVIEW_TOKEN_MAX_TTL_SECONDS = 60 * 60
export const GUEST_PREVIEW_TOKEN_MAX_LENGTH = 1_024
/** Tolerated clock difference between the minting and the verifying server. */
const CLOCK_SKEW_SECONDS = 30

const PREFIX = 'gp1'
const DOMAIN = 'pathfinder.guest-preview.v1'

const Identifier = z.string().trim().min(1).max(191)
const Claims = z
  .object({
    v: z.literal(1),
    t: Identifier,
    n: Identifier,
    k: z.enum(['release', 'package']),
    r: Identifier,
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
  })
  .strict()

export type GuestPreviewVersionKind = 'release' | 'package'

export type GuestPreviewClaims = Readonly<{
  tenantId: string
  venueId: string
  kind: GuestPreviewVersionKind
  versionId: string
  issuedAt: Date
  expiresAt: Date
}>

export type GuestPreviewTokenFailure =
  | 'MISSING_SECRET'
  | 'MALFORMED'
  | 'BAD_SIGNATURE'
  | 'EXPIRED'
  | 'NOT_YET_VALID'
  | 'SCOPE_MISMATCH'

export class GuestPreviewTokenError extends Error {
  constructor(readonly code: GuestPreviewTokenFailure) {
    super(`Guest preview token rejected: ${code}`)
    this.name = 'GuestPreviewTokenError'
  }
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(`${DOMAIN}.${body}`).digest('base64url')
}

function seconds(value: Date): number {
  return Math.floor(value.getTime() / 1_000)
}

export function mintGuestPreviewToken(input: {
  secret: string | null
  tenantId: string
  venueId: string
  kind: GuestPreviewVersionKind
  versionId: string
  now?: Date
  ttlSeconds?: number
}): { token: string; expiresAt: Date } {
  if (!input.secret) throw new GuestPreviewTokenError('MISSING_SECRET')
  const ttl = input.ttlSeconds ?? GUEST_PREVIEW_TOKEN_DEFAULT_TTL_SECONDS
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > GUEST_PREVIEW_TOKEN_MAX_TTL_SECONDS) {
    throw new GuestPreviewTokenError('MALFORMED')
  }
  const issuedAt = seconds(input.now ?? new Date())
  const claims = Claims.parse({
    v: 1,
    t: input.tenantId,
    n: input.venueId,
    k: input.kind,
    r: input.versionId,
    iat: issuedAt,
    exp: issuedAt + ttl,
  })
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  const token = `${PREFIX}.${body}.${sign(input.secret, body)}`
  if (token.length > GUEST_PREVIEW_TOKEN_MAX_LENGTH) throw new GuestPreviewTokenError('MALFORMED')
  return { token, expiresAt: new Date((issuedAt + ttl) * 1_000) }
}

/**
 * Verifies the signature first and only then reads the claims, so an unsigned or altered token is
 * rejected before any of its content is interpreted. `expected` pins the scope the caller already
 * resolved independently (for example the venue named in the URL); any difference is rejected.
 */
export function verifyGuestPreviewToken(input: {
  secret: string | null
  token: string
  now?: Date
  expected?: Partial<{
    tenantId: string
    venueId: string
    kind: GuestPreviewVersionKind
    versionId: string
  }>
}): GuestPreviewClaims {
  if (!input.secret) throw new GuestPreviewTokenError('MISSING_SECRET')
  if (input.token.length === 0 || input.token.length > GUEST_PREVIEW_TOKEN_MAX_LENGTH) {
    throw new GuestPreviewTokenError('MALFORMED')
  }
  const parts = input.token.split('.')
  if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) {
    throw new GuestPreviewTokenError('MALFORMED')
  }
  const [, body, signature] = parts as [string, string, string]
  const expectedSignature = Buffer.from(sign(input.secret, body), 'utf8')
  const presented = Buffer.from(signature, 'utf8')
  if (
    presented.length !== expectedSignature.length ||
    !timingSafeEqual(presented, expectedSignature)
  ) {
    throw new GuestPreviewTokenError('BAD_SIGNATURE')
  }
  let parsed: z.infer<typeof Claims>
  try {
    parsed = Claims.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')))
  } catch {
    throw new GuestPreviewTokenError('MALFORMED')
  }
  const now = seconds(input.now ?? new Date())
  if (parsed.exp - parsed.iat > GUEST_PREVIEW_TOKEN_MAX_TTL_SECONDS) {
    throw new GuestPreviewTokenError('MALFORMED')
  }
  if (parsed.iat > now + CLOCK_SKEW_SECONDS) throw new GuestPreviewTokenError('NOT_YET_VALID')
  if (parsed.exp <= now) throw new GuestPreviewTokenError('EXPIRED')
  const claims: GuestPreviewClaims = {
    tenantId: parsed.t,
    venueId: parsed.n,
    kind: parsed.k,
    versionId: parsed.r,
    issuedAt: new Date(parsed.iat * 1_000),
    expiresAt: new Date(parsed.exp * 1_000),
  }
  const expected = input.expected
  if (
    expected &&
    ((expected.tenantId !== undefined && expected.tenantId !== claims.tenantId) ||
      (expected.venueId !== undefined && expected.venueId !== claims.venueId) ||
      (expected.kind !== undefined && expected.kind !== claims.kind) ||
      (expected.versionId !== undefined && expected.versionId !== claims.versionId))
  ) {
    throw new GuestPreviewTokenError('SCOPE_MISMATCH')
  }
  return claims
}
