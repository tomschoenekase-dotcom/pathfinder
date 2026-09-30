import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  argsHash,
  candidateTokenHashes,
  generateOperatorToken,
  hashOperatorToken,
  isOperatorTokenShape,
  OperatorKeyringError,
  parsePepperKeyring,
  sameHash,
  storedTokenMatches,
  verifyPkceS256,
} from './tokens'

const pepper = () => randomBytes(32).toString('base64url')

describe('operator token material', () => {
  it('parses a keyring whose first key signs and whose later keys only verify', () => {
    const keyring = parsePepperKeyring(`k2:${pepper()},k1:${pepper()}`)
    expect(keyring.currentKid).toBe('k2')
    expect([...keyring.peppers.keys()]).toEqual(['k2', 'k1'])
  })

  it.each([
    undefined,
    '',
    'k1',
    `k1:${randomBytes(16).toString('base64url')}`,
    `k1:${pepper()},k1:${pepper()}`,
    `K 1:${pepper()}`,
  ])('rejects a missing, weak, duplicated or malformed keyring %#', (raw) => {
    expect(() => parsePepperKeyring(raw)).toThrow(OperatorKeyringError)
  })

  it('mints 256-bit opaque tokens with an environment-bound prefix', () => {
    const access = generateOperatorToken('access', 'prd')
    expect(access).toMatch(/^pf_oat_prd_[A-Za-z0-9_-]{43}$/u)
    expect(isOperatorTokenShape(access, 'access', 'prd')).toBe(true)
    // The other environment's token is refused before any lookup.
    expect(isOperatorTokenShape(access, 'access', 'stg')).toBe(false)
    expect(isOperatorTokenShape(access, 'refresh', 'prd')).toBe(false)
    expect(isOperatorTokenShape(generateOperatorToken('refresh', 'stg'), 'refresh', 'stg')).toBe(
      true,
    )
    expect(isOperatorTokenShape(generateOperatorToken('code', 'stg'), 'code', 'prd')).toBe(true)
    expect(isOperatorTokenShape(`${access}x`, 'access', 'prd')).toBe(false)
  })

  it('stores only an HMAC digest and verifies it against the stored kid in constant time', () => {
    const keyring = parsePepperKeyring(`new:${pepper()},old:${pepper()}`)
    const token = generateOperatorToken('access', 'stg')
    const stored = { kid: 'old', tokenHash: hashOperatorToken(keyring, 'old', token) }
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/u)
    expect(stored.tokenHash).not.toContain(token.slice(11))
    expect(candidateTokenHashes(keyring, token).map((candidate) => candidate.hash)).toContain(
      stored.tokenHash,
    )
    expect(storedTokenMatches(keyring, stored, token)).toBe(true)
    expect(storedTokenMatches(keyring, stored, generateOperatorToken('access', 'stg'))).toBe(false)
    expect(storedTokenMatches(keyring, { kid: 'gone', tokenHash: stored.tokenHash }, token)).toBe(
      false,
    )
    const otherKeyring = parsePepperKeyring(`new:${pepper()}`)
    expect(
      storedTokenMatches(otherKeyring, { kid: 'new', tokenHash: stored.tokenHash }, token),
    ).toBe(false)
  })

  it('accepts only S256 PKCE with an RFC 7636 verifier', () => {
    const verifier = randomBytes(48).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    expect(verifyPkceS256(verifier, challenge)).toBe(true)
    // `plain` (challenge === verifier) never verifies.
    expect(verifyPkceS256(verifier, verifier)).toBe(false)
    expect(verifyPkceS256(`${verifier}x`, challenge)).toBe(false)
    // Wrong-length verifiers (under 43 or over 128) are rejected outright.
    const short = 'a'.repeat(42)
    expect(verifyPkceS256(short, createHash('sha256').update(short).digest('base64url'))).toBe(
      false,
    )
    const long = 'a'.repeat(129)
    expect(verifyPkceS256(long, createHash('sha256').update(long).digest('base64url'))).toBe(false)
  })

  it('hashes arguments canonically so key order never changes the approval binding', () => {
    expect(argsHash({ b: 1, a: { d: [1, 2], c: null } })).toBe(
      argsHash({ a: { c: null, d: [1, 2] }, b: 1 }),
    )
    expect(argsHash({ a: 1 })).not.toBe(argsHash({ a: '1' }))
    expect(sameHash(argsHash({ a: 1 }), argsHash({ a: 1 }))).toBe(true)
    expect(sameHash(argsHash({ a: 1 }), 'not-a-hash')).toBe(false)
  })
})
