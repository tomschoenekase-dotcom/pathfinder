import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'

import { OperatorCapability } from '@pathfinder/contracts/operator-mcp'
import { logger } from '@pathfinder/config/logger'
import { db } from '@pathfinder/db'

import { writeOperatorAudit, writeOperatorAuditBestEffort, type OperatorDatabase } from './audit'
import {
  OPERATOR_OAUTH_LIFETIMES,
  OPERATOR_OAUTH_SCOPE,
  resolveOperatorConfig,
  type OperatorConfigResolution,
  type OperatorServerConfig,
} from './config'
import {
  candidateTokenHashes,
  generateOperatorToken,
  hashOperatorToken,
  isOperatorTokenShape,
  isPkceChallenge,
  storedTokenMatches,
  verifyPkceS256,
} from './tokens'

const MAX_FORM_BYTES = 16 * 1024
const MAX_REGISTRATION_BYTES = 16 * 1024
const MAX_REDIRECT_URIS = 5
const REGISTRATIONS_PER_IP_PER_HOUR = 10
// A spoofed forwarding header cannot lift this: at most this many registrations platform-wide.
const REGISTRATIONS_PER_HOUR_TOTAL = 50
const REJECTED_REDIRECT_AUDIT_WINDOW_MS = 10 * 60 * 1000

export type OperatorOAuthDependencies = Readonly<{
  resolveConfig?: () => OperatorConfigResolution
  database?: OperatorDatabase
  now?: () => Date
}>

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      pragma: 'no-cache',
      ...headers,
    },
  })
}

function oauthError(status: number, error: string, description?: string): Response {
  return json(status, { error, ...(description ? { error_description: description } : {}) })
}

export function notFoundResponse(): Response {
  return json(404, { error: 'NOT_FOUND' })
}

function ready(
  dependencies: OperatorOAuthDependencies,
):
  | { response: Response }
  | { config: OperatorServerConfig; database: OperatorDatabase; now: Date } {
  const resolution = (dependencies.resolveConfig ?? resolveOperatorConfig)()
  if (resolution.status === 'disabled') return { response: notFoundResponse() }
  if (resolution.status === 'misconfigured') {
    return { response: json(503, { error: 'temporarily_unavailable' }) }
  }
  return {
    config: resolution.config,
    database: dependencies.database ?? db,
    now: (dependencies.now ?? (() => new Date()))(),
  }
}

// ---------------------------------------------------------------------------
// Metadata (RFC 8414, RFC 9728)
// ---------------------------------------------------------------------------

export function authorizationServerMetadata(config: OperatorServerConfig) {
  return {
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/oauth/authorize`,
    token_endpoint: `${config.issuer}/oauth/token`,
    registration_endpoint: `${config.issuer}/oauth/register`,
    revocation_endpoint: `${config.issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [OPERATOR_OAUTH_SCOPE],
    authorization_response_iss_parameter_supported: true,
  }
}

export function protectedResourceMetadata(config: OperatorServerConfig) {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [OPERATOR_OAUTH_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Torchiko operator',
  }
}

export function handleAuthorizationServerMetadata(
  dependencies: OperatorOAuthDependencies = {},
): Response {
  const state = ready(dependencies)
  if ('response' in state) return state.response
  return json(200, authorizationServerMetadata(state.config), {
    'cache-control': 'public, max-age=300',
  })
}

export function handleProtectedResourceMetadata(
  dependencies: OperatorOAuthDependencies = {},
): Response {
  const state = ready(dependencies)
  if ('response' in state) return state.response
  return json(200, protectedResourceMetadata(state.config), {
    'cache-control': 'public, max-age=300',
  })
}

// ---------------------------------------------------------------------------
// Redirect URIs
// ---------------------------------------------------------------------------

function isLoopbackHost(hostname: string) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

/**
 * Registration-time check. The value must already be in canonical form (no normalization is ever
 * applied later), carry no userinfo or fragment, and be HTTPS on an allowlisted origin or HTTP on
 * loopback. Authorization and token requests then compare exact strings only.
 */
export function validateRegisteredRedirectUri(
  raw: unknown,
  config: Pick<OperatorServerConfig, 'redirectOrigins'>,
): string | null {
  if (typeof raw !== 'string' || raw.length < 8 || raw.length > 2_000) return null
  if (raw.includes('#') || /[\s\\]/u.test(raw)) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.href !== raw || url.username || url.password || url.hash) return null
  if (url.protocol === 'https:') return config.redirectOrigins.has(url.origin) ? raw : null
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return raw
  return null
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591), public clients only
// ---------------------------------------------------------------------------

const RegistrationRequest = z
  .object({
    client_name: z.string().trim().min(1).max(120).optional(),
    redirect_uris: z.array(z.unknown()).min(1).max(MAX_REDIRECT_URIS),
    grant_types: z.array(z.string()).max(4).optional(),
    response_types: z.array(z.string()).max(2).optional(),
    token_endpoint_auth_method: z.string().max(64).optional(),
    scope: z.string().max(200).optional(),
  })
  .passthrough()

function clientIp(request: Request) {
  // The nearest proxy appends the peer address last; earlier entries are client-supplied.
  const forwarded = request.headers.get('x-forwarded-for')
  const last = forwarded?.split(',').at(-1)?.trim()
  return last || request.headers.get('x-real-ip')?.trim() || 'unknown'
}

async function readBoundedText(request: Request, maxBytes: number) {
  const declared = request.headers.get('content-length')
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) {
    throw new Error('BODY_TOO_LARGE')
  }
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > maxBytes) {
      await reader.cancel()
      throw new Error('BODY_TOO_LARGE')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function newClientId() {
  return `opc_${randomBytes(18).toString('base64url')}`
}

export async function handleClientRegistration(
  request: Request,
  dependencies: OperatorOAuthDependencies = {},
): Promise<Response> {
  const state = ready(dependencies)
  if ('response' in state) return state.response
  if (request.method !== 'POST') return oauthError(405, 'invalid_request')
  const { config, database, now } = state
  const requestId = randomUUID()
  let body: unknown
  try {
    body = JSON.parse(await readBoundedText(request, MAX_REGISTRATION_BYTES))
  } catch {
    return oauthError(400, 'invalid_client_metadata', 'Body must be bounded JSON.')
  }
  const parsed = RegistrationRequest.safeParse(body)
  if (!parsed.success) return oauthError(400, 'invalid_client_metadata')
  const registration = parsed.data
  const ipHash = hashOperatorToken(
    config.keyring,
    config.keyring.currentKid,
    `ip:${clientIp(request)}`,
  )
  // Limits run before anything is written, so unauthenticated traffic cannot grow the
  // append-only audit trail. Rate-limited attempts go to the logger only.
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000)
  const [fromIp, total] = await Promise.all([
    database.operatorOAuthClient.count({
      where: { registrationIpHash: ipHash, createdAt: { gt: hourAgo, lte: now } },
    }),
    database.operatorOAuthClient.count({ where: { createdAt: { gt: hourAgo, lte: now } } }),
  ])
  if (fromIp >= REGISTRATIONS_PER_IP_PER_HOUR || total >= REGISTRATIONS_PER_HOUR_TOTAL) {
    logger.warn({ action: 'operator.oauth.register_rate_limited' })
    return oauthError(429, 'too_many_requests')
  }
  const redirectUris = registration.redirect_uris.map((uri) =>
    validateRegisteredRedirectUri(uri, config),
  )
  if (redirectUris.some((uri) => uri === null)) {
    // Record the rejected origins so Tom can allowlist a real connector's callback, but at most
    // one audit row per ten minutes platform-wide; everything else goes to the logger.
    const recent = await database.operatorAuditEvent.count({
      where: {
        eventType: 'oauth.register',
        outcome: 'REDIRECT_URI_REJECTED',
        occurredAt: { gt: new Date(Date.now() - REJECTED_REDIRECT_AUDIT_WINDOW_MS) },
      },
    })
    if (recent === 0) {
      await writeOperatorAuditBestEffort(
        {
          requestId,
          eventType: 'oauth.register',
          outcome: 'REDIRECT_URI_REJECTED',
          args: {
            redirectOrigins: registration.redirect_uris.slice(0, MAX_REDIRECT_URIS).map((uri) => {
              try {
                return typeof uri === 'string' ? new URL(uri).origin : 'invalid'
              } catch {
                return 'invalid'
              }
            }),
          },
        },
        database,
      )
    } else {
      logger.warn({ action: 'operator.oauth.redirect_uri_rejected' })
    }
    return oauthError(400, 'invalid_redirect_uri')
  }
  // RFC 7591 §3.2.1 lets the server replace requested metadata. Confidential methods are
  // downgraded to a public client (no secret is ever issued); anything else is refused.
  if (
    registration.token_endpoint_auth_method !== undefined &&
    !['none', 'client_secret_post', 'client_secret_basic'].includes(
      registration.token_endpoint_auth_method,
    )
  ) {
    return oauthError(400, 'invalid_client_metadata', 'Only public clients are supported.')
  }
  const grantTypes = registration.grant_types ?? ['authorization_code', 'refresh_token']
  if (
    grantTypes.some((type) => type !== 'authorization_code' && type !== 'refresh_token') ||
    !grantTypes.includes('authorization_code')
  ) {
    return oauthError(400, 'invalid_client_metadata', 'Unsupported grant_types.')
  }
  if (registration.response_types && registration.response_types.some((type) => type !== 'code')) {
    return oauthError(400, 'invalid_client_metadata', 'Unsupported response_types.')
  }
  const clientId = newClientId()
  const clientName = registration.client_name ?? 'Unnamed client'
  const uris = redirectUris as string[]
  await database.operatorOAuthClient.create({
    data: {
      id: clientId,
      clientName,
      redirectUris: uris,
      registrationIpHash: ipHash,
      expiresAt: new Date(now.getTime() + OPERATOR_OAUTH_LIFETIMES.unconsentedClientSeconds * 1000),
      createdAt: now,
    },
  })
  await writeOperatorAudit(
    {
      requestId,
      eventType: 'oauth.register',
      outcome: 'REGISTERED',
      clientId,
      args: { clientName, redirectUris: uris },
    },
    database,
  )
  return json(201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    client_name: clientName,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: OPERATOR_OAUTH_SCOPE,
  })
}

// ---------------------------------------------------------------------------
// Authorization request validation and consent
// ---------------------------------------------------------------------------

export type AuthorizationRequestParameters = Readonly<Record<string, string | undefined>>

export type ValidatedAuthorizationRequest = Readonly<{
  clientId: string
  clientName: string
  redirectUri: string
  redirectHost: string
  codeChallenge: string
  resource: string
  state: string | null
}>

export type AuthorizationRequestValidation =
  /** Never redirect: the client or redirect URI itself is untrusted. */
  | { kind: 'show-error'; error: 'invalid_client' | 'invalid_redirect_uri' }
  /** Redirect back to the verified redirect URI with an OAuth error. */
  | { kind: 'redirect-error'; redirectTo: string }
  | { kind: 'valid'; request: ValidatedAuthorizationRequest }

function withQuery(base: string, params: Record<string, string | null>) {
  const url = new URL(base)
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(key, value)
  }
  return url.toString()
}

export async function validateAuthorizationRequest(
  params: AuthorizationRequestParameters,
  config: OperatorServerConfig,
  now: Date,
  database: OperatorDatabase = db,
): Promise<AuthorizationRequestValidation> {
  const clientId = params.client_id
  if (!clientId || clientId.length > 64) return { kind: 'show-error', error: 'invalid_client' }
  const client = await database.operatorOAuthClient.findUnique({ where: { id: clientId } })
  if (
    !client ||
    client.revokedAt !== null ||
    (client.consentedAt === null && client.expiresAt !== null && client.expiresAt <= now)
  ) {
    return { kind: 'show-error', error: 'invalid_client' }
  }
  const redirectUri = params.redirect_uri
  // Exact string equality with a registered URI: no prefix, normalization or port relaxation.
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return { kind: 'show-error', error: 'invalid_redirect_uri' }
  }
  const state = params.state && params.state.length <= 1_000 ? params.state : null
  const fail = (error: string, description: string): AuthorizationRequestValidation => ({
    kind: 'redirect-error',
    redirectTo: withQuery(redirectUri, {
      error,
      error_description: description,
      state,
      iss: config.issuer,
    }),
  })
  if (params.response_type !== 'code') return fail('unsupported_response_type', 'Use code.')
  if (params.code_challenge_method !== 'S256') {
    return fail('invalid_request', 'PKCE with S256 is required.')
  }
  if (!params.code_challenge || !isPkceChallenge(params.code_challenge)) {
    return fail('invalid_request', 'A valid S256 code_challenge is required.')
  }
  if (params.resource !== undefined && params.resource !== config.resource) {
    return fail('invalid_target', 'Unknown resource.')
  }
  if (
    params.scope !== undefined &&
    params.scope.split(' ').some((scope) => scope !== '' && scope !== OPERATOR_OAUTH_SCOPE)
  ) {
    return fail('invalid_scope', 'Only the operator scope exists.')
  }
  return {
    kind: 'valid',
    request: {
      clientId: client.id,
      clientName: client.clientName,
      redirectUri,
      redirectHost: new URL(redirectUri).host,
      codeChallenge: params.code_challenge,
      resource: config.resource,
      state,
    },
  }
}

export function isOperatorApprover(
  config: Pick<OperatorServerConfig, 'allowedUserIds'>,
  identity: Readonly<{ userId: string | null | undefined; platformRole: unknown }>,
): boolean {
  return (
    typeof identity.userId === 'string' &&
    identity.platformRole === 'PLATFORM_ADMIN' &&
    config.allowedUserIds.has(identity.userId)
  )
}

export const ConsentDecision = z
  .object({
    decision: z.enum(['approve', 'deny']),
    allTenants: z.boolean(),
    tenantIds: z.array(z.string().trim().min(1).max(191)).max(500),
    capabilities: z.array(OperatorCapability).min(1).max(OperatorCapability.options.length),
    expiresInDays: z.number().int().min(1).max(OPERATOR_OAUTH_LIFETIMES.maxGrantDays),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === 'approve' && !value.allTenants && value.tenantIds.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tenantIds'],
        message: 'Pick tenants',
      })
    }
    if (new Set(value.capabilities).size !== value.capabilities.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['capabilities'], message: 'Unique' })
    }
  })
export type ConsentDecision = z.infer<typeof ConsentDecision>

export const OPERATOR_ARM_WINDOW_MS = 10 * 60 * 1000

/**
 * Tom arms a connection from the dashboard before he starts it in ChatGPT. A consent link that
 * someone else sends him (their own connector registers with the same callback host) finds no
 * recent arming and is refused. Each arming covers one consent.
 */
export async function armOperatorConnection(
  input: Readonly<{ userId: string; requestId: string; now?: Date }>,
  database: OperatorDatabase = db,
): Promise<void> {
  const now = input.now ?? new Date()
  await database.operatorArming.create({
    data: {
      userId: input.userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + OPERATOR_ARM_WINDOW_MS),
    },
  })
  await writeOperatorAudit(
    {
      requestId: input.requestId,
      eventType: 'oauth.arm',
      outcome: 'ARMED',
      actorUserId: input.userId,
    },
    database,
  )
}

/** The arming time if this user armed within the window and has not consented since. */
export async function activeOperatorArming(
  userId: string,
  database: OperatorDatabase = db,
  now: Date = new Date(),
): Promise<Date | null> {
  const armed = await database.operatorArming.findFirst({
    where: { userId, consumedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  return armed?.createdAt ?? null
}

/**
 * Called by the Clerk-protected consent handler only after it has verified the platform-admin
 * session, the allowlist and a strict reverification. Re-validates the whole request itself.
 */
export async function completeAuthorization(
  input: Readonly<{
    config: OperatorServerConfig
    userId: string
    params: AuthorizationRequestParameters
    decision: ConsentDecision
    now: Date
    requestId: string
  }>,
  database: OperatorDatabase = db,
): Promise<
  | { redirectTo: string }
  | { error: 'invalid_client' | 'invalid_redirect_uri' | 'invalid_tenant' | 'not_armed' }
> {
  const validation = await validateAuthorizationRequest(
    input.params,
    input.config,
    input.now,
    database,
  )
  if (validation.kind === 'show-error') return { error: validation.error }
  if (validation.kind === 'redirect-error') return { redirectTo: validation.redirectTo }
  const request = validation.request
  // An arming is a real-time window set by a person, so it is judged by the real clock, not the
  // injected one that governs token lifetimes.
  const armingNow = new Date()
  if (input.decision.decision === 'deny') {
    await writeOperatorAudit(
      {
        requestId: input.requestId,
        eventType: 'oauth.authorize',
        outcome: 'DENIED',
        clientId: request.clientId,
        actorUserId: input.userId,
      },
      database,
    )
    return {
      redirectTo: withQuery(request.redirectUri, {
        error: 'access_denied',
        state: request.state,
        iss: input.config.issuer,
      }),
    }
  }
  if (!(await activeOperatorArming(input.userId, database, armingNow))) {
    return { error: 'not_armed' }
  }
  const tenantIds = input.decision.allTenants ? [] : [...new Set(input.decision.tenantIds)].sort()
  if (tenantIds.length > 0) {
    const found = await database.tenant.count({ where: { id: { in: tenantIds } } })
    if (found !== tenantIds.length) return { error: 'invalid_tenant' }
  }
  const code = generateOperatorToken('code', input.config.environment)
  const kid = input.config.keyring.currentKid
  const consented = await database.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as OperatorDatabase
    // Claim one arming, atomically. Two consents racing on a single arming cannot both pass: the
    // loser finds nothing left to claim and creates no grant.
    const arming = await tx.operatorArming.findFirst({
      where: { userId: input.userId, consumedAt: null, expiresAt: { gt: armingNow } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    const claim = arming
      ? await tx.operatorArming.updateMany({
          where: { id: arming.id, consumedAt: null, expiresAt: { gt: armingNow } },
          data: { consumedAt: armingNow, consumedClientId: request.clientId },
        })
      : { count: 0 }
    if (!arming || claim.count !== 1) return null
    const grant = await tx.operatorGrant.create({
      data: {
        clientId: request.clientId,
        userId: input.userId,
        allTenants: input.decision.allTenants,
        tenantIds,
        capabilities: [...input.decision.capabilities].sort(),
        resource: request.resource,
        scope: OPERATOR_OAUTH_SCOPE,
        expiresAt: new Date(input.now.getTime() + input.decision.expiresInDays * 86_400_000),
        createdAt: input.now,
      },
    })
    await tx.operatorAuthorizationCode.create({
      data: {
        codeHash: hashOperatorToken(input.config.keyring, kid, code),
        kid,
        clientId: request.clientId,
        grantId: grant.id,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        resource: request.resource,
        expiresAt: new Date(input.now.getTime() + OPERATOR_OAUTH_LIFETIMES.codeSeconds * 1000),
        createdAt: input.now,
      },
    })
    await tx.operatorOAuthClient.update({
      where: { id: request.clientId },
      data: { consentedAt: input.now, expiresAt: null },
    })
    await writeOperatorAudit(
      {
        requestId: input.requestId,
        eventType: 'oauth.authorize',
        outcome: 'CONSENTED',
        grantId: grant.id,
        clientId: request.clientId,
        actorUserId: input.userId,
        args: {
          allTenants: input.decision.allTenants,
          tenantCount: tenantIds.length,
          capabilities: input.decision.capabilities,
          expiresInDays: input.decision.expiresInDays,
          redirectHost: request.redirectHost,
        },
      },
      tx,
    )
    await tx.operatorArming.update({
      where: { id: arming.id },
      data: { consumedGrantId: grant.id },
    })
    return grant.id
  })
  if (consented === null) return { error: 'not_armed' }
  return {
    redirectTo: withQuery(request.redirectUri, {
      code,
      state: request.state,
      iss: input.config.issuer,
    }),
  }
}

// ---------------------------------------------------------------------------
// Token endpoint and revocation
// ---------------------------------------------------------------------------

async function readTokenParameters(request: Request): Promise<Record<string, string> | null> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  const text = await readBoundedText(request, MAX_FORM_BYTES)
  if (contentType === 'application/x-www-form-urlencoded') {
    const form = new URLSearchParams(text)
    const out: Record<string, string> = {}
    for (const key of new Set(form.keys())) {
      const values = form.getAll(key)
      // RFC 6749 §3.1: parameters must not be repeated.
      if (values.length !== 1) return null
      out[key] = values[0]!
    }
    return out
  }
  if (contentType === 'application/json') {
    const parsed = z.record(z.string().max(4_096)).safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  }
  return null
}

type GrantRow = Awaited<ReturnType<OperatorDatabase['operatorGrant']['findUnique']>>

function grantUsable(grant: NonNullable<GrantRow>, now: Date) {
  return grant.revokedAt === null && grant.expiresAt > now
}

/** Revokes the whole authorization: the grant row and every token minted under it. */
export async function revokeOperatorGrant(
  input: Readonly<{
    grantId: string
    reason: string
    now: Date
    requestId: string
    actorUserId?: string
  }>,
  database: OperatorDatabase = db,
): Promise<void> {
  await database.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as OperatorDatabase
    const updated = await tx.operatorGrant.updateMany({
      where: { id: input.grantId, revokedAt: null },
      data: { revokedAt: input.now, revokeReason: input.reason.slice(0, 191) },
    })
    await tx.operatorToken.updateMany({
      where: { grantId: input.grantId, revokedAt: null },
      data: { revokedAt: input.now },
    })
    const grant = await tx.operatorGrant.findUnique({
      where: { id: input.grantId },
      select: { clientId: true },
    })
    await writeOperatorAudit(
      {
        requestId: input.requestId,
        eventType: input.reason.endsWith('reuse') ? 'oauth.reuse_detected' : 'oauth.revoke',
        outcome: updated.count === 1 ? input.reason.toUpperCase() : 'ALREADY_REVOKED',
        grantId: input.grantId,
        clientId: grant?.clientId ?? null,
        actorUserId: input.actorUserId ?? null,
      },
      tx,
    )
  })
}

async function issueTokenPair(
  input: Readonly<{
    config: OperatorServerConfig
    grantId: string
    familyId: string
    parentId: string | null
    absoluteExpiresAt: Date
    now: Date
  }>,
  database: OperatorDatabase,
) {
  const kid = input.config.keyring.currentKid
  const accessToken = generateOperatorToken('access', input.config.environment)
  const refreshToken = generateOperatorToken('refresh', input.config.environment)
  const refreshExpiry = new Date(
    Math.min(
      input.now.getTime() + OPERATOR_OAUTH_LIFETIMES.refreshIdleSeconds * 1000,
      input.absoluteExpiresAt.getTime(),
    ),
  )
  await database.operatorToken.createMany({
    data: [
      {
        grantId: input.grantId,
        kind: 'ACCESS',
        tokenHash: hashOperatorToken(input.config.keyring, kid, accessToken),
        kid,
        familyId: input.familyId,
        parentId: input.parentId,
        audience: input.config.resource,
        expiresAt: new Date(input.now.getTime() + OPERATOR_OAUTH_LIFETIMES.accessSeconds * 1000),
        createdAt: input.now,
      },
      {
        grantId: input.grantId,
        kind: 'REFRESH',
        tokenHash: hashOperatorToken(input.config.keyring, kid, refreshToken),
        kid,
        familyId: input.familyId,
        parentId: input.parentId,
        audience: input.config.resource,
        expiresAt: refreshExpiry,
        absoluteExpiresAt: input.absoluteExpiresAt,
        createdAt: input.now,
      },
    ],
  })
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: OPERATOR_OAUTH_LIFETIMES.accessSeconds,
    refresh_token: refreshToken,
    scope: OPERATOR_OAUTH_SCOPE,
  }
}

async function findTokenRow(
  config: OperatorServerConfig,
  token: string,
  database: OperatorDatabase,
) {
  const candidates = candidateTokenHashes(config.keyring, token)
  const row = await database.operatorToken.findFirst({
    where: { tokenHash: { in: candidates.map((candidate) => candidate.hash) } },
  })
  return row && storedTokenMatches(config.keyring, row, token) ? row : null
}

async function exchangeAuthorizationCode(
  params: Record<string, string>,
  config: OperatorServerConfig,
  now: Date,
  requestId: string,
  database: OperatorDatabase,
): Promise<Response> {
  const code = params.code ?? ''
  if (!isOperatorTokenShape(code, 'code', config.environment)) {
    return oauthError(400, 'invalid_grant')
  }
  const candidates = candidateTokenHashes(config.keyring, code)
  const row = await database.operatorAuthorizationCode.findFirst({
    where: { codeHash: { in: candidates.map((candidate) => candidate.hash) } },
  })
  if (
    !row ||
    !storedTokenMatches(config.keyring, { kid: row.kid, tokenHash: row.codeHash }, code)
  ) {
    return oauthError(400, 'invalid_grant')
  }
  // Single use: claim before any other check so a stolen code burns on first touch.
  const claimed = await database.operatorAuthorizationCode.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: now },
  })
  if (claimed.count !== 1) {
    await revokeOperatorGrant(
      { grantId: row.grantId, reason: 'code_reuse', now, requestId },
      database,
    )
    return oauthError(400, 'invalid_grant')
  }
  const fail = async (outcome: string) => {
    await writeOperatorAudit(
      {
        requestId,
        eventType: 'oauth.token',
        outcome,
        grantId: row.grantId,
        clientId: row.clientId,
      },
      database,
    )
    return oauthError(400, 'invalid_grant')
  }
  if (row.expiresAt <= now) return fail('CODE_EXPIRED')
  if (params.client_id !== row.clientId) return fail('CLIENT_MISMATCH')
  if (params.redirect_uri !== row.redirectUri) return fail('REDIRECT_MISMATCH')
  if (params.resource !== undefined && params.resource !== row.resource) {
    return fail('RESOURCE_MISMATCH')
  }
  if (!params.code_verifier || !verifyPkceS256(params.code_verifier, row.codeChallenge)) {
    return fail('PKCE_FAILED')
  }
  const [grant, client] = await Promise.all([
    database.operatorGrant.findUnique({ where: { id: row.grantId } }),
    database.operatorOAuthClient.findUnique({ where: { id: row.clientId } }),
  ])
  if (!grant || !grantUsable(grant, now) || !client || client.revokedAt !== null) {
    return fail('GRANT_UNUSABLE')
  }
  const absoluteExpiresAt = new Date(
    Math.min(
      now.getTime() + OPERATOR_OAUTH_LIFETIMES.refreshAbsoluteSeconds * 1000,
      grant.expiresAt.getTime(),
    ),
  )
  const body = await issueTokenPair(
    { config, grantId: grant.id, familyId: grant.id, parentId: null, absoluteExpiresAt, now },
    database,
  )
  await database.operatorOAuthClient.update({ where: { id: client.id }, data: { lastUsedAt: now } })
  await writeOperatorAudit(
    {
      requestId,
      eventType: 'oauth.token',
      outcome: 'ISSUED',
      grantId: grant.id,
      clientId: client.id,
    },
    database,
  )
  return json(200, body)
}

async function rotateRefreshToken(
  params: Record<string, string>,
  config: OperatorServerConfig,
  now: Date,
  requestId: string,
  database: OperatorDatabase,
): Promise<Response> {
  const token = params.refresh_token ?? ''
  if (!isOperatorTokenShape(token, 'refresh', config.environment)) {
    return oauthError(400, 'invalid_grant')
  }
  const row = await findTokenRow(config, token, database)
  if (!row || row.kind !== 'REFRESH') return oauthError(400, 'invalid_grant')
  if (row.revokedAt !== null || row.rotatedAt !== null) {
    // A rotated or revoked refresh token came back: assume theft and kill the whole family.
    await revokeOperatorGrant(
      { grantId: row.grantId, reason: 'refresh_reuse', now, requestId },
      database,
    )
    return oauthError(400, 'invalid_grant')
  }
  const grant = await database.operatorGrant.findUnique({ where: { id: row.grantId } })
  const fail = async (outcome: string) => {
    await writeOperatorAudit(
      { requestId, eventType: 'oauth.refresh', outcome, grantId: row.grantId },
      database,
    )
    return oauthError(400, 'invalid_grant')
  }
  if (!grant || !grantUsable(grant, now)) return fail('GRANT_UNUSABLE')
  if (params.client_id !== grant.clientId) return fail('CLIENT_MISMATCH')
  if (params.resource !== undefined && params.resource !== row.audience) {
    return fail('RESOURCE_MISMATCH')
  }
  if (row.expiresAt <= now || (row.absoluteExpiresAt !== null && row.absoluteExpiresAt <= now)) {
    return fail('REFRESH_EXPIRED')
  }
  const client = await database.operatorOAuthClient.findUnique({ where: { id: grant.clientId } })
  if (!client || client.revokedAt !== null) return fail('CLIENT_REVOKED')
  // Retire the old refresh token and issue the new pair in ONE transaction. A crash, timeout or
  // error part-way rolls the whole rotation back and leaves the old token usable, so an
  // interrupted rotation can never strand the client behind a token that is already spent.
  const rotated = await database.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as OperatorDatabase
    const claimed = await tx.operatorToken.updateMany({
      where: { id: row.id, rotatedAt: null, revokedAt: null },
      data: { rotatedAt: now, lastUsedAt: now },
    })
    if (claimed.count !== 1) return null
    const pair = await issueTokenPair(
      {
        config,
        grantId: grant.id,
        familyId: row.familyId,
        parentId: row.id,
        absoluteExpiresAt: row.absoluteExpiresAt ?? grant.expiresAt,
        now,
      },
      tx,
    )
    await writeOperatorAudit(
      {
        requestId,
        eventType: 'oauth.refresh',
        outcome: 'ROTATED',
        grantId: grant.id,
        clientId: client.id,
      },
      tx,
    )
    return pair
  })
  if (rotated === null) {
    // Another request spent this exact token first: a genuine replay, so the family is revoked.
    await revokeOperatorGrant(
      { grantId: row.grantId, reason: 'refresh_reuse', now, requestId },
      database,
    )
    return oauthError(400, 'invalid_grant')
  }
  return json(200, rotated)
}

export async function handleTokenRequest(
  request: Request,
  dependencies: OperatorOAuthDependencies = {},
): Promise<Response> {
  const state = ready(dependencies)
  if ('response' in state) return state.response
  if (request.method !== 'POST') return oauthError(405, 'invalid_request')
  if (new URL(request.url).search) {
    return oauthError(400, 'invalid_request', 'Credentials are never accepted in the URL.')
  }
  let params: Record<string, string> | null
  try {
    params = await readTokenParameters(request)
  } catch {
    return oauthError(400, 'invalid_request')
  }
  if (!params) return oauthError(400, 'invalid_request')
  const requestId = randomUUID()
  if (params.grant_type === 'authorization_code') {
    return exchangeAuthorizationCode(params, state.config, state.now, requestId, state.database)
  }
  if (params.grant_type === 'refresh_token') {
    return rotateRefreshToken(params, state.config, state.now, requestId, state.database)
  }
  return oauthError(400, 'unsupported_grant_type')
}

/** RFC 7009: always 200 unless the request itself is malformed. */
export async function handleRevocationRequest(
  request: Request,
  dependencies: OperatorOAuthDependencies = {},
): Promise<Response> {
  const state = ready(dependencies)
  if ('response' in state) return state.response
  if (request.method !== 'POST') return oauthError(405, 'invalid_request')
  let params: Record<string, string> | null
  try {
    params = await readTokenParameters(request)
  } catch {
    return oauthError(400, 'invalid_request')
  }
  if (!params || !params.token) return oauthError(400, 'invalid_request')
  const { config, database, now } = state
  const token = params.token
  const shaped =
    isOperatorTokenShape(token, 'access', config.environment) ||
    isOperatorTokenShape(token, 'refresh', config.environment)
  if (!shaped) return json(200, {})
  const row = await findTokenRow(config, token, database)
  if (!row) return json(200, {})
  const grant = await database.operatorGrant.findUnique({ where: { id: row.grantId } })
  if (!grant || (params.client_id !== undefined && params.client_id !== grant.clientId)) {
    return json(200, {})
  }
  const requestId = randomUUID()
  if (row.kind === 'REFRESH') {
    await revokeOperatorGrant(
      { grantId: row.grantId, reason: 'client_revoked', now, requestId },
      database,
    )
  } else {
    await database.operatorToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: now },
    })
    await writeOperatorAudit(
      {
        requestId,
        eventType: 'oauth.revoke',
        outcome: 'ACCESS_REVOKED',
        grantId: grant.id,
        clientId: grant.clientId,
      },
      database,
    )
  }
  return json(200, {})
}

// ---------------------------------------------------------------------------
// Access-token verification for the MCP resource
// ---------------------------------------------------------------------------

export type VerifiedOperatorGrant = Readonly<{
  grantId: string
  clientId: string
  userId: string
  allTenants: boolean
  tenantIds: readonly string[]
  capabilities: readonly OperatorCapability[]
}>

export type AccessTokenVerification =
  | { ok: true; grant: VerifiedOperatorGrant }
  | { ok: false; reason: 'MALFORMED' | 'UNKNOWN' | 'REVOKED' | 'EXPIRED' | 'AUDIENCE' | 'GRANT' }

/** Re-reads the token, grant and client rows on every call so revocation is immediate. */
export async function verifyOperatorAccessToken(
  token: string,
  config: OperatorServerConfig,
  now: Date,
  database: OperatorDatabase = db,
): Promise<AccessTokenVerification> {
  if (!isOperatorTokenShape(token, 'access', config.environment)) {
    return { ok: false, reason: 'MALFORMED' }
  }
  const row = await findTokenRow(config, token, database)
  if (!row || row.kind !== 'ACCESS') return { ok: false, reason: 'UNKNOWN' }
  if (row.revokedAt !== null) return { ok: false, reason: 'REVOKED' }
  if (row.expiresAt <= now) return { ok: false, reason: 'EXPIRED' }
  if (row.audience !== config.resource) return { ok: false, reason: 'AUDIENCE' }
  const grant = await database.operatorGrant.findUnique({
    where: { id: row.grantId },
    include: { client: { select: { revokedAt: true } } },
  })
  // The consenting human must still be an allowlisted approver: removing them from the
  // allowlist stops their connections immediately.
  if (
    !grant ||
    !grantUsable(grant, now) ||
    grant.client.revokedAt !== null ||
    !config.allowedUserIds.has(grant.userId)
  ) {
    return { ok: false, reason: 'GRANT' }
  }
  if (!grant.lastUsedAt || now.getTime() - grant.lastUsedAt.getTime() > 60_000) {
    await database.operatorGrant.updateMany({ where: { id: grant.id }, data: { lastUsedAt: now } })
  }
  return {
    ok: true,
    grant: {
      grantId: grant.id,
      clientId: grant.clientId,
      userId: grant.userId,
      allTenants: grant.allTenants,
      tenantIds: grant.tenantIds,
      capabilities: grant.capabilities.filter(
        (capability): capability is OperatorCapability =>
          OperatorCapability.safeParse(capability).success,
      ),
    },
  }
}
