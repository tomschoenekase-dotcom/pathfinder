import { describe, expect, it } from 'vitest'

import {
  GUEST_PREVIEW_TOKEN_DEFAULT_TTL_SECONDS,
  GUEST_PREVIEW_TOKEN_MAX_TTL_SECONDS,
  GuestPreviewTokenError,
  mintGuestPreviewToken,
  verifyGuestPreviewToken,
} from './guest-preview-token'

const SECRET = 'a-server-only-preview-signing-secret-32+'
const NOW = new Date('2026-10-02T12:00:00.000Z')
const base = {
  tenantId: 'tenant_a',
  venueId: 'venue_a',
  kind: 'release',
  versionId: 'rel_1',
} as const

function mint(overrides: Partial<Parameters<typeof mintGuestPreviewToken>[0]> = {}) {
  return mintGuestPreviewToken({ secret: SECRET, ...base, now: NOW, ...overrides })
}

function code(run: () => unknown) {
  try {
    run()
  } catch (error) {
    if (error instanceof GuestPreviewTokenError) return error.code
    throw error
  }
  return 'ACCEPTED'
}

describe('guest preview token', () => {
  it('accepts a valid token bound to the exact tenant, venue and version', () => {
    const { token, expiresAt } = mint()
    expect(expiresAt.toISOString()).toBe(
      new Date(NOW.getTime() + GUEST_PREVIEW_TOKEN_DEFAULT_TTL_SECONDS * 1_000).toISOString(),
    )
    const claims = verifyGuestPreviewToken({
      secret: SECRET,
      token,
      now: new Date(NOW.getTime() + 60_000),
      expected: base,
    })
    expect(claims).toMatchObject({ ...base })
    expect(claims.expiresAt).toEqual(expiresAt)
  })

  it('rejects an expired token, including at the exact expiry second', () => {
    const { token, expiresAt } = mint({ ttlSeconds: 60 })
    expect(code(() => verifyGuestPreviewToken({ secret: SECRET, token, now: expiresAt }))).toBe(
      'EXPIRED',
    )
    expect(
      code(() =>
        verifyGuestPreviewToken({
          secret: SECRET,
          token,
          now: new Date(expiresAt.getTime() - 1_000),
        }),
      ),
    ).toBe('ACCEPTED')
  })

  it('rejects a token for another venue or another tenant', () => {
    const { token } = mint()
    expect(
      code(() =>
        verifyGuestPreviewToken({
          secret: SECRET,
          token,
          now: NOW,
          expected: { venueId: 'venue_b' },
        }),
      ),
    ).toBe('SCOPE_MISMATCH')
    expect(
      code(() =>
        verifyGuestPreviewToken({
          secret: SECRET,
          token,
          now: NOW,
          expected: { tenantId: 'tenant_b' },
        }),
      ),
    ).toBe('SCOPE_MISMATCH')
    expect(
      code(() =>
        verifyGuestPreviewToken({
          secret: SECRET,
          token,
          now: NOW,
          expected: { kind: 'package', versionId: 'rel_1' },
        }),
      ),
    ).toBe('SCOPE_MISMATCH')
    expect(
      code(() =>
        verifyGuestPreviewToken({
          secret: SECRET,
          token,
          now: NOW,
          expected: { versionId: 'rel_2' },
        }),
      ),
    ).toBe('SCOPE_MISMATCH')
  })

  it('rejects a tampered payload even when the claims remain well formed', () => {
    const { token } = mint()
    const [prefix, body, signature] = token.split('.') as [string, string, string]
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    for (const change of [
      { n: 'venue_b' },
      { t: 'tenant_b' },
      { r: 'rel_2' },
      { exp: 9_999_999_999 },
    ]) {
      const forged = Buffer.from(JSON.stringify({ ...claims, ...change })).toString('base64url')
      expect(
        code(() =>
          verifyGuestPreviewToken({
            secret: SECRET,
            token: `${prefix}.${forged}.${signature}`,
            now: NOW,
          }),
        ),
      ).toBe('BAD_SIGNATURE')
    }
  })

  it('rejects an altered signature, a token signed with another key, and a truncated token', () => {
    const { token } = mint()
    const flipped = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`
    expect(code(() => verifyGuestPreviewToken({ secret: SECRET, token: flipped, now: NOW }))).toBe(
      'BAD_SIGNATURE',
    )
    const other = mintGuestPreviewToken({
      secret: 'another-server-secret-that-is-32-chars!!',
      ...base,
      now: NOW,
    })
    expect(
      code(() => verifyGuestPreviewToken({ secret: SECRET, token: other.token, now: NOW })),
    ).toBe('BAD_SIGNATURE')
    expect(
      code(() => verifyGuestPreviewToken({ secret: SECRET, token: token.slice(0, 20), now: NOW })),
    ).toBe('MALFORMED')
  })

  it('rejects malformed tokens before reading their content', () => {
    for (const token of ['', 'abc', 'gp1..', 'gp2.a.b', 'gp1.a', `gp1.${'a'.repeat(2_000)}.b`]) {
      expect(code(() => verifyGuestPreviewToken({ secret: SECRET, token, now: NOW }))).toBe(
        'MALFORMED',
      )
    }
  })

  it('fails closed when no signing secret is configured', () => {
    expect(code(() => mint({ secret: null }))).toBe('MISSING_SECRET')
    const { token } = mint()
    expect(code(() => verifyGuestPreviewToken({ secret: null, token, now: NOW }))).toBe(
      'MISSING_SECRET',
    )
  })

  it('bounds the lifetime and rejects a token from the future', () => {
    expect(code(() => mint({ ttlSeconds: GUEST_PREVIEW_TOKEN_MAX_TTL_SECONDS + 1 }))).toBe(
      'MALFORMED',
    )
    expect(code(() => mint({ ttlSeconds: 0 }))).toBe('MALFORMED')
    const { token } = mint({ now: new Date(NOW.getTime() + 10 * 60_000) })
    expect(code(() => verifyGuestPreviewToken({ secret: SECRET, token, now: NOW }))).toBe(
      'NOT_YET_VALID',
    )
  })
})
