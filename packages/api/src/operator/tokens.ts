import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Opaque operator OAuth secrets. Only HMAC-SHA-256(pepper[kid], token) and the kid are stored;
 * plaintext never reaches the database, logs or audit rows.
 */
export type OperatorTokenEnvironment = 'stg' | 'prd'
export type OperatorTokenKind = 'code' | 'access' | 'refresh'

export type OperatorPepperKeyring = Readonly<{
  /** The key ID used for new tokens. */
  currentKid: string
  peppers: ReadonlyMap<string, Buffer>
}>

const SECRET = '[A-Za-z0-9_-]{43}'
const PATTERNS: Record<OperatorTokenKind, RegExp> = {
  code: new RegExp(`^pf_oac_${SECRET}$`, 'u'),
  access: new RegExp(`^pf_oat_(stg|prd)_${SECRET}$`, 'u'),
  refresh: new RegExp(`^pf_ort_(stg|prd)_${SECRET}$`, 'u'),
}

export class OperatorKeyringError extends Error {
  readonly code = 'OPERATOR_KEYRING_INVALID'
}

/**
 * Parses `kid:base64url,kid:base64url`. The first entry signs new tokens; later entries are
 * accepted for verification only, so a pepper can rotate without logging everyone out.
 */
export function parsePepperKeyring(raw: string | undefined): OperatorPepperKeyring {
  if (!raw) throw new OperatorKeyringError('Operator pepper keyring is not configured')
  const peppers = new Map<string, Buffer>()
  let currentKid: string | null = null
  for (const entry of raw.split(',')) {
    const match = entry.trim().match(/^([a-z0-9-]{1,16}):([A-Za-z0-9_-]{43,128})$/u)
    if (!match) throw new OperatorKeyringError('Operator pepper keyring entry is malformed')
    const [, kid, encoded] = match
    const secret = Buffer.from(encoded!, 'base64url')
    if (secret.length < 32 || peppers.has(kid!)) {
      throw new OperatorKeyringError('Operator pepper keyring entry is weak or duplicated')
    }
    peppers.set(kid!, secret)
    currentKid ??= kid!
  }
  if (!currentKid) throw new OperatorKeyringError('Operator pepper keyring is empty')
  return { currentKid, peppers }
}

export function tokenPrefix(kind: OperatorTokenKind, environment: OperatorTokenEnvironment) {
  if (kind === 'code') return 'pf_oac_'
  return `${kind === 'access' ? 'pf_oat' : 'pf_ort'}_${environment}_`
}

export function generateOperatorToken(
  kind: OperatorTokenKind,
  environment: OperatorTokenEnvironment,
): string {
  return `${tokenPrefix(kind, environment)}${randomBytes(32).toString('base64url')}`
}

/** True only for a well-formed token of this kind minted for this environment. */
export function isOperatorTokenShape(
  value: string,
  kind: OperatorTokenKind,
  environment: OperatorTokenEnvironment,
): boolean {
  const match = PATTERNS[kind].exec(value)
  if (!match) return false
  return kind === 'code' || match[1] === environment
}

export function hashOperatorToken(keyring: OperatorPepperKeyring, kid: string, token: string) {
  const pepper = keyring.peppers.get(kid)
  if (!pepper) throw new OperatorKeyringError('Unknown operator pepper key ID')
  return createHmac('sha256', pepper).update(token, 'utf8').digest('hex')
}

/** Every candidate hash, one per known kid, for an indexed lookup. */
export function candidateTokenHashes(keyring: OperatorPepperKeyring, token: string) {
  return [...keyring.peppers.keys()].map((kid) => ({
    kid,
    hash: hashOperatorToken(keyring, kid, token),
  }))
}

/** Recomputes the stored row's hash and compares it in constant time. */
export function storedTokenMatches(
  keyring: OperatorPepperKeyring,
  stored: Readonly<{ kid: string; tokenHash: string }>,
  token: string,
): boolean {
  if (!keyring.peppers.has(stored.kid) || !/^[0-9a-f]{64}$/u.test(stored.tokenHash)) return false
  const expected = Buffer.from(hashOperatorToken(keyring, stored.kid, token), 'hex')
  const actual = Buffer.from(stored.tokenHash, 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/u

export function isPkceChallenge(value: string): boolean {
  return CHALLENGE.test(value)
}

/** RFC 7636 S256 only. `plain` is never accepted anywhere in the operator server. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!VERIFIER.test(verifier) || !CHALLENGE.test(challenge)) return false
  const computed = Buffer.from(createHash('sha256').update(verifier, 'ascii').digest('base64url'))
  const expected = Buffer.from(challenge)
  return computed.length === expected.length && timingSafeEqual(computed, expected)
}

/** Stable SHA-256 over canonical JSON (sorted keys) for argsHash binding. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

export function argsHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

export function sameHash(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}
