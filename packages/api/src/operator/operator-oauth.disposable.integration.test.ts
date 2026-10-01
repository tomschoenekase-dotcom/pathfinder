import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { OperatorCapability } from '@pathfinder/contracts/operator-mcp'
import { createVenueAction, db, withTenantIsolationBypass } from '@pathfinder/db'

import { setAutonomyPolicy } from './autonomy'
import { resolveOperatorConfig, type OperatorServerConfig } from './config'
import { handleOperatorMcpRequest } from './http'
import {
  armOperatorConnection,
  completeAuthorization,
  handleClientRegistration,
  handleRevocationRequest,
  handleTokenRequest,
  validateAuthorizationRequest,
} from './oauth'
import { approveAndApplyPlan } from './plans'
import { approveAndApplyProposal, OperatorProposalError } from './proposals'
import { createOperatorRegistry } from './registry'

/**
 * Step 3 security tests on a real disposable PostgreSQL with every migration applied. Invented
 * names and example domains only. Runs only against a database named pathfinder_disposable_*.
 */
const enabled =
  process.env.RUN_OPERATOR_DB_INTEGRATION === '1' &&
  /^postgres(?:ql)?:\/\/[^/]+\/pathfinder_disposable_[a-z0-9_]+(?:\?|$)/u.test(
    process.env.DATABASE_URL ?? '',
  )

const peppers = `k1:${randomBytes(32).toString('base64url')}`
const baseEnvironment = {
  OPERATOR_OAUTH_ENABLED: true,
  OPERATOR_OAUTH_ISSUER: 'https://app.operator.test',
  OPERATOR_OAUTH_PEPPERS: peppers,
  OPERATOR_OAUTH_REDIRECT_ORIGINS: 'https://connector.example.com',
  OPERATOR_OAUTH_ALLOWED_USER_IDS: 'user_owner',
  RAILWAY_ENVIRONMENT: 'staging',
}
function configFor(overrides: Partial<typeof baseEnvironment> = {}): OperatorServerConfig {
  const resolution = resolveOperatorConfig({ ...baseEnvironment, ...overrides })
  if (resolution.status !== 'ready') throw new Error('operator config not ready')
  return resolution.config
}
const config = configFor()
const REDIRECT = 'https://connector.example.com/oauth/callback'
// A unique far-future clock per run keeps hour-window limits independent across reruns.
let clock = new Date(Date.UTC(2031, 0, 1) + Math.floor(Math.random() * 3_000_000) * 60_000)
const tick = (ms: number) => (clock = new Date(clock.getTime() + ms))
const deps = (overrides: { config?: OperatorServerConfig } = {}) => ({
  resolveConfig: () => ({ status: 'ready' as const, config: overrides.config ?? config }),
  database: db,
  now: () => clock,
})

const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
const tenantId = `op-tenant-${suffix}`
const otherTenantId = `op-other-${suffix}`
let venueId = ''
let otherVenueId = ''
const seenTokens: string[] = []
const grantIds: string[] = []

async function register(
  ip = `198.51.100.${Math.floor(Math.random() * 250)}`,
  body: Record<string, unknown> = {},
) {
  return handleClientRegistration(
    new Request('https://app.operator.test/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({
        client_name: 'Example connector',
        redirect_uris: [REDIRECT],
        ...body,
      }),
    }),
    deps(),
  )
}

function pkce() {
  const verifier = randomBytes(48).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

async function authorize(
  clientId: string,
  challenge: string,
  capabilities = [...OperatorCapability.options],
) {
  await armOperatorConnection({ userId: 'user_owner', requestId: randomUUID() })
  const outcome = await completeAuthorization({
    config,
    userId: 'user_owner',
    params: {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'state-1',
      resource: config.resource,
      scope: 'operator',
    },
    decision: {
      decision: 'approve',
      allTenants: false,
      tenantIds: [tenantId],
      capabilities,
      expiresInDays: 90,
    },
    now: clock,
    requestId: randomUUID(),
  })
  if (!('redirectTo' in outcome)) throw new Error(`consent failed: ${outcome.error}`)
  const url = new URL(outcome.redirectTo)
  expect(url.origin + url.pathname).toBe(REDIRECT)
  expect(url.searchParams.get('state')).toBe('state-1')
  expect(url.searchParams.get('iss')).toBe(config.issuer)
  const code = url.searchParams.get('code')!
  seenTokens.push(code)
  return code
}

async function token(form: Record<string, string>, configOverride?: OperatorServerConfig) {
  const response = await handleTokenRequest(
    new Request('https://app.operator.test/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    }),
    deps(configOverride ? { config: configOverride } : {}),
  )
  const body = (await response.json()) as Record<string, string>
  if (body.access_token) seenTokens.push(body.access_token, body.refresh_token!)
  return { status: response.status, body, headers: response.headers }
}

async function connect() {
  const registered = (await (await register()).json()) as { client_id: string }
  const { verifier, challenge } = pkce()
  const code = await authorize(registered.client_id, challenge)
  const issued = await token({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: registered.client_id,
    redirect_uri: REDIRECT,
    resource: config.resource,
  })
  expect(issued.status).toBe(200)
  const grant = await db.operatorGrant.findFirst({
    where: { clientId: registered.client_id },
    orderBy: { createdAt: 'desc' },
  })
  grantIds.push(grant!.id)
  return {
    clientId: registered.client_id,
    access: issued.body.access_token!,
    refresh: issued.body.refresh_token!,
    grantId: grant!.id,
  }
}

async function mcp(
  access: string,
  method: string,
  params?: unknown,
  options: { config?: OperatorServerConfig; url?: string } = {},
) {
  const response = await handleOperatorMcpRequest(
    new Request(options.url ?? 'https://app.operator.test/api/operator/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${access}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method,
        ...(params === undefined ? {} : { params }),
      }),
    }),
    { ...deps(options.config ? { config: options.config } : {}) },
  )
  const text = await response.text()
  return {
    status: response.status,
    headers: response.headers,
    body: (text ? JSON.parse(text) : null) as {
      result?: {
        structuredContent?: ToolView
        isError?: boolean
        tools?: Array<{ name: string }>
      }
      error?: unknown
    },
  }
}

async function callTool(
  access: string,
  name: string,
  args: Record<string, unknown>,
  meta?: Record<string, unknown>,
) {
  const response = await mcp(access, 'tools/call', {
    name,
    arguments: args,
    ...(meta ? { _meta: meta } : {}),
  })
  expect(response.status).toBe(200)
  return response.body.result!
}

async function venueUpdatedAt(id = venueId) {
  const venue = await db.venue.findFirst({
    where: { id, tenantId },
    select: { updatedAt: true, chatTheme: true },
  })
  return venue!
}

const kinds = createOperatorRegistry().kinds

type ToolView = {
  proposalId: string
  argsHash: string
  status?: string
  approveUrl?: string
  error?: string
  [key: string]: unknown
}

describe.skipIf(!enabled)(
  'operator OAuth and approvals on disposable PostgreSQL',
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      await withTenantIsolationBypass(async () => {
        for (const id of [tenantId, otherTenantId]) {
          await db.tenant.create({ data: { id, name: `Example ${id}`, slug: id } })
        }
        const make = async (tenant: string, slug: string) =>
          (
            await createVenueAction({
              tenantId: tenant,
              actor: { type: 'HUMAN', id: 'user_owner', role: 'OWNER' },
              name: 'Example Garden',
              baseSlug: slug,
              callerSuppliedSlug: true,
              guideMode: 'non_location',
            })
          ).record.id
        venueId = await make(tenantId, `example-garden-${suffix}`)
        otherVenueId = await make(otherTenantId, `example-museum-${suffix}`)
      })
    })

    afterAll(async () => {
      // No token plaintext may ever reach the audit trail.
      const rows = await db.operatorAuditEvent.findMany({
        where: { OR: [{ grantId: { in: grantIds } }, { eventType: 'oauth.register' }] },
      })
      const serialized = JSON.stringify(rows)
      for (const secret of seenTokens) expect(serialized).not.toContain(secret)
      expect(serialized).not.toMatch(/pf_o(ac|at|rt)_[A-Za-z0-9_-]{20}/u)
      // Leave no embedding work behind: later CI steps lease any pending dispatch in this database.
      await withTenantIsolationBypass(() =>
        db.embeddingDispatch.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } }),
      )
      await db.$disconnect()
    })

    it('registers only public clients on allowlisted exact redirects, audits rejections, and rate-limits by IP', async () => {
      const ok = await register()
      expect(ok.status).toBe(201)
      const body = (await ok.json()) as Record<string, unknown>
      expect(body.token_endpoint_auth_method).toBe('none')
      expect(body.client_id).toMatch(/^opc_/u)

      const rejected = await register(undefined, {
        redirect_uris: ['https://unlisted.example.org/cb'],
      })
      expect(rejected.status).toBe(400)
      const audit = await db.operatorAuditEvent.findFirst({
        where: { eventType: 'oauth.register', outcome: 'REDIRECT_URI_REJECTED' },
        orderBy: { occurredAt: 'desc' },
      })
      expect(JSON.stringify(audit?.redactedArgs)).toContain('https://unlisted.example.org')

      // A confidential method is downgraded to a public client; no secret is ever issued.
      const downgraded = await register(undefined, {
        token_endpoint_auth_method: 'client_secret_basic',
      })
      expect(downgraded.status).toBe(201)
      const downgradedBody = (await downgraded.json()) as Record<string, unknown>
      expect(downgradedBody.token_endpoint_auth_method).toBe('none')
      expect(downgradedBody.client_secret).toBeUndefined()
      expect(
        (await register(undefined, { token_endpoint_auth_method: 'private_key_jwt' })).status,
      ).toBe(400)
      expect((await register(undefined, { grant_types: ['client_credentials'] })).status).toBe(400)
      expect((await register(undefined, { redirect_uris: Array(6).fill(REDIRECT) })).status).toBe(
        400,
      )

      const ip = `203.0.113.${Math.floor(Math.random() * 250)}`
      for (let index = 0; index < 10; index += 1) expect((await register(ip)).status).toBe(201)
      expect((await register(ip)).status).toBe(429)
    })

    it('validates authorization requests with exact redirect URIs and S256 PKCE only', async () => {
      const { client_id: clientId } = (await (await register()).json()) as { client_id: string }
      const { challenge } = pkce()
      const base = {
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: config.resource,
      }
      expect((await validateAuthorizationRequest(base, config, clock, db)).kind).toBe('valid')
      for (const redirect_uri of [
        `${REDIRECT}/`,
        `${REDIRECT}#x`,
        REDIRECT.replace('.com/', '.com:8443/'),
        'https://connector.example.com/oauth',
        `${REDIRECT}?x=1`,
      ]) {
        expect(
          await validateAuthorizationRequest({ ...base, redirect_uri }, config, clock, db),
        ).toEqual({
          kind: 'show-error',
          error: 'invalid_redirect_uri',
        })
      }
      expect(
        (
          await validateAuthorizationRequest(
            { ...base, client_id: 'opc_unknown' },
            config,
            clock,
            db,
          )
        ).kind,
      ).toBe('show-error')
      const plain = await validateAuthorizationRequest(
        { ...base, code_challenge_method: 'plain' },
        config,
        clock,
        db,
      )
      expect(
        plain.kind === 'redirect-error' && new URL(plain.redirectTo).searchParams.get('error'),
      ).toBe('invalid_request')
      const missing = await validateAuthorizationRequest(
        { ...base, code_challenge: undefined },
        config,
        clock,
        db,
      )
      expect(missing.kind).toBe('redirect-error')
      const wrongResource = await validateAuthorizationRequest(
        { ...base, resource: 'https://other.example/api' },
        config,
        clock,
        db,
      )
      expect(wrongResource.kind === 'redirect-error' && wrongResource.redirectTo).toContain(
        'invalid_target',
      )
      // An unconsented registration expires after 24 hours.
      const expired = await validateAuthorizationRequest(
        base,
        config,
        new Date(clock.getTime() + 25 * 3_600_000),
        db,
      )
      expect(expired).toEqual({ kind: 'show-error', error: 'invalid_client' })
    })

    it('exchanges a code once; a replayed code revokes the whole grant', async () => {
      const connection = await connect()
      expect((await mcp(connection.access, 'tools/list')).status).toBe(200)
      const code = seenTokens.find((value) => value.startsWith('pf_oac_'))!
      const grant = await db.operatorGrant.findUnique({ where: { id: connection.grantId } })
      const row = await db.operatorAuthorizationCode.findFirst({ where: { grantId: grant!.id } })
      expect(row?.consumedAt).not.toBeNull()
      // Replay the exact code that produced this connection.
      const codes = seenTokens.filter((value) => value.startsWith('pf_oac_'))
      const replay = await token({
        grant_type: 'authorization_code',
        code: codes.at(-1)!,
        code_verifier: 'x'.repeat(43),
        client_id: connection.clientId,
        redirect_uri: REDIRECT,
      })
      expect(replay.status).toBe(400)
      expect(replay.body.error).toBe('invalid_grant')
      expect(
        (await db.operatorGrant.findUnique({ where: { id: connection.grantId } }))?.revokedAt,
      ).not.toBeNull()
      expect((await mcp(connection.access, 'tools/list')).status).toBe(401)
      void code
    })

    it('burns a code on a wrong verifier, redirect or client, and refuses expired codes', async () => {
      const { client_id: clientId } = (await (await register()).json()) as { client_id: string }
      const attempts: Array<[string, (form: Record<string, string>) => Record<string, string>]> = [
        ['verifier', (form) => ({ ...form, code_verifier: randomBytes(48).toString('base64url') })],
        ['short verifier', (form) => ({ ...form, code_verifier: 'a'.repeat(42) })],
        ['redirect', (form) => ({ ...form, redirect_uri: `${REDIRECT}/` })],
        ['client', (form) => ({ ...form, client_id: 'opc_other' })],
        ['resource', (form) => ({ ...form, resource: 'https://other.example/api' })],
      ]
      for (const [, mutate] of attempts) {
        const { verifier, challenge } = pkce()
        const code = await authorize(clientId, challenge)
        const form = {
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: clientId,
          redirect_uri: REDIRECT,
        }
        expect((await token(mutate(form))).status).toBe(400)
        // The code is single use even when the first attempt failed.
        expect((await token(form)).status).toBe(400)
      }
      const { verifier, challenge } = pkce()
      const code = await authorize(clientId, challenge)
      tick(61_000)
      expect(
        (
          await token({
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            client_id: clientId,
            redirect_uri: REDIRECT,
          })
        ).status,
      ).toBe(400)
      // Credentials in the URL are refused outright.
      const inQuery = await handleTokenRequest(
        new Request(`https://app.operator.test/oauth/token?code=${code}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: '',
        }),
        deps(),
      )
      expect(inQuery.status).toBe(400)
    })

    it('rotates refresh tokens and revokes the family when an old one is reused', async () => {
      const connection = await connect()
      const rotated = await token({
        grant_type: 'refresh_token',
        refresh_token: connection.refresh,
        client_id: connection.clientId,
      })
      expect(rotated.status).toBe(200)
      expect(rotated.body.refresh_token).not.toBe(connection.refresh)
      expect((await mcp(rotated.body.access_token!, 'tools/list')).status).toBe(200)
      const reuse = await token({
        grant_type: 'refresh_token',
        refresh_token: connection.refresh,
        client_id: connection.clientId,
      })
      expect(reuse.status).toBe(400)
      expect(
        (await db.operatorGrant.findUnique({ where: { id: connection.grantId } }))?.revokeReason,
      ).toBe('refresh_reuse')
      expect((await mcp(rotated.body.access_token!, 'tools/list')).status).toBe(401)
      expect(
        (
          await token({
            grant_type: 'refresh_token',
            refresh_token: rotated.body.refresh_token!,
            client_id: connection.clientId,
          })
        ).status,
      ).toBe(400)
    })

    it('rejects access tokens after revoke, after expiry, for another audience, from another environment, or in the URL', async () => {
      const connection = await connect()
      const ok = await mcp(connection.access, 'tools/list')
      expect(ok.status).toBe(200)

      const unauthenticated = await handleOperatorMcpRequest(
        new Request('https://app.operator.test/api/operator/mcp', {
          method: 'POST',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
          },
          body: '{}',
        }),
        deps(),
      )
      expect(unauthenticated.status).toBe(401)
      expect(unauthenticated.headers.get('www-authenticate')).toContain(
        'resource_metadata="https://app.operator.test/.well-known/oauth-protected-resource/api/operator/mcp"',
      )

      const otherAudience = configFor({ OPERATOR_OAUTH_ISSUER: 'https://other.operator.test' })
      expect(
        (await mcp(connection.access, 'tools/list', undefined, { config: otherAudience })).status,
      ).toBe(401)
      const production = configFor({ RAILWAY_ENVIRONMENT: 'production' })
      const wrongEnvironment = await mcp(connection.access, 'tools/list', undefined, {
        config: production,
      })
      expect(wrongEnvironment.status).toBe(401)
      expect(wrongEnvironment.headers.get('www-authenticate')).toContain('error="invalid_token"')
      expect(
        (
          await mcp(connection.access, 'tools/list', undefined, {
            url: `https://app.operator.test/api/operator/mcp?access_token=${connection.access}`,
          })
        ).status,
      ).toBe(400)

      const later = clock
      tick(61 * 60_000)
      expect((await mcp(connection.access, 'tools/list')).status).toBe(401)
      clock = later

      const revoke = await handleRevocationRequest(
        new Request('https://app.operator.test/oauth/revoke', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token: connection.access,
            client_id: connection.clientId,
          }).toString(),
        }),
        deps(),
      )
      expect(revoke.status).toBe(200)
      expect((await mcp(connection.access, 'tools/list')).status).toBe(401)
      // Revoking the refresh token revokes the grant: a new access token from it cannot exist.
      await handleRevocationRequest(
        new Request('https://app.operator.test/oauth/revoke', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token: connection.refresh,
            client_id: connection.clientId,
          }).toString(),
        }),
        deps(),
      )
      expect(
        (await db.operatorGrant.findUnique({ where: { id: connection.grantId } }))?.revokedAt,
      ).not.toBeNull()
    })

    it('scopes tools to the grant: out-of-grant and missing tenants are both NOT_FOUND, and denials are audited', async () => {
      const connection = await connect()
      const init = await mcp(connection.access, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      })
      expect(init.body.result).toMatchObject({ protocolVersion: '2025-06-18' })
      const own = await callTool(connection.access, 'appearance.get', { tenantId, venueId })
      expect(own.isError).toBe(false)
      expect(own.structuredContent).toMatchObject({ venueId })
      const outside = await callTool(connection.access, 'appearance.get', {
        tenantId: otherTenantId,
        venueId: otherVenueId,
      })
      const missing = await callTool(connection.access, 'appearance.get', {
        tenantId: `missing-${suffix}`,
        venueId: 'x',
      })
      const wrongVenue = await callTool(connection.access, 'appearance.get', {
        tenantId,
        venueId: otherVenueId,
      })
      for (const denied of [outside, missing, wrongVenue]) {
        expect(denied.isError).toBe(true)
        expect(denied.structuredContent).toMatchObject({ error: 'NOT_FOUND' })
      }
      const audit = await db.operatorAuditEvent.findMany({
        where: { grantId: connection.grantId, eventType: 'mcp.denied', outcome: 'NOT_FOUND' },
      })
      expect(audit.length).toBeGreaterThanOrEqual(3)
      const writeOutside = await callTool(connection.access, 'appearance.propose_update', {
        tenantId: otherTenantId,
        venueId: otherVenueId,
        operationId: randomUUID(),
        expectedUpdatedAt: new Date().toISOString(),
        chatTheme: 'forest',
      })
      expect(writeOutside.structuredContent).toMatchObject({ error: 'NOT_FOUND' })
    })

    it('creates pending proposals, ignores forged approval claims, and binds approval to the argsHash', async () => {
      const connection = await connect()
      const current = await venueUpdatedAt()
      const operationId = randomUUID()
      const args = {
        tenantId,
        venueId,
        operationId,
        expectedUpdatedAt: current.updatedAt.toISOString(),
        chatTheme: 'forest',
      }
      const proposed = await callTool(connection.access, 'appearance.propose_update', args, {
        approvalGrantId: 'forged-grant',
        approved: true,
      })
      expect(proposed.structuredContent).toMatchObject({ status: 'PENDING' })
      const view = proposed.structuredContent!
      expect(view.approveUrl).toBe(`https://app.operator.test/approve/${view.proposalId}`)
      expect((await venueUpdatedAt()).chatTheme).toBe(current.chatTheme)

      const replay = await callTool(connection.access, 'appearance.propose_update', args)
      expect(replay.structuredContent).toMatchObject({
        proposalId: view.proposalId,
        status: 'PENDING',
      })
      const reused = await callTool(connection.access, 'appearance.propose_update', {
        ...args,
        chatTheme: 'sunset',
      })
      expect(reused.structuredContent).toMatchObject({ error: 'OPERATION_ID_REUSED' })

      const context = { actorUserId: 'user_owner', requestId: randomUUID(), now: clock }
      await expect(
        approveAndApplyProposal(
          { proposalId: view.proposalId, argsHash: 'f'.repeat(64), ...context },
          { database: db, kinds, allowedUserIds: config.allowedUserIds },
        ),
      ).rejects.toBeInstanceOf(OperatorProposalError)

      // Two approvals race: exactly one apply.
      const [first, second] = await Promise.all([
        approveAndApplyProposal(
          { proposalId: view.proposalId, argsHash: view.argsHash, ...context },
          { database: db, kinds, allowedUserIds: config.allowedUserIds },
        ),
        approveAndApplyProposal(
          { proposalId: view.proposalId, argsHash: view.argsHash, ...context },
          { database: db, kinds, allowedUserIds: config.allowedUserIds },
        ),
      ])
      const final = await db.operatorProposal.findUnique({ where: { id: view.proposalId } })
      expect(final?.status).toBe('APPLIED')
      expect([first.status, second.status]).toContain('APPLIED')
      const applies = await withTenantIsolationBypass(() =>
        db.auditLog.count({
          where: {
            tenantId,
            targetId: venueId,
            action: 'venue.chat-design.updated',
            actorId: 'user_owner',
          },
        }),
      )
      expect(applies).toBe(1)
      // A replayed approve POST is a no-op.
      const replayed = await approveAndApplyProposal(
        { proposalId: view.proposalId, argsHash: view.argsHash, ...context },
        { database: db, kinds, allowedUserIds: config.allowedUserIds },
      )
      expect(replayed.status).toBe('APPLIED')
      expect(
        await withTenantIsolationBypass(() =>
          db.auditLog.count({
            where: {
              tenantId,
              targetId: venueId,
              action: 'venue.chat-design.updated',
              actorId: 'user_owner',
            },
          }),
        ),
      ).toBe(1)
      expect((await venueUpdatedAt()).chatTheme).toBe('forest')
      const status = await callTool(connection.access, 'operator.get_proposal', {
        proposalId: view.proposalId,
      })
      expect(status.structuredContent).toMatchObject({ status: 'APPLIED' })
    })

    it('marks a proposal STALE when its target moved, and refuses approval after REJECTED or EXPIRED', async () => {
      const connection = await connect()
      const before = await venueUpdatedAt()
      const staleView = (
        await callTool(connection.access, 'appearance.propose_update', {
          tenantId,
          venueId,
          operationId: randomUUID(),
          expectedUpdatedAt: before.updatedAt.toISOString(),
          chatTheme: 'midnight',
        })
      ).structuredContent!
      const moverView = (
        await callTool(connection.access, 'appearance.propose_update', {
          tenantId,
          venueId,
          operationId: randomUUID(),
          expectedUpdatedAt: before.updatedAt.toISOString(),
          chatTheme: 'rose',
        })
      ).structuredContent!
      const context = { actorUserId: 'user_owner', requestId: randomUUID(), now: clock }
      expect(
        (
          await approveAndApplyProposal(
            { proposalId: moverView.proposalId, argsHash: moverView.argsHash, ...context },
            { database: db, kinds, allowedUserIds: config.allowedUserIds },
          )
        ).status,
      ).toBe('APPLIED')
      expect(
        (
          await approveAndApplyProposal(
            { proposalId: staleView.proposalId, argsHash: staleView.argsHash, ...context },
            { database: db, kinds, allowedUserIds: config.allowedUserIds },
          )
        ).status,
      ).toBe('STALE')
      expect((await venueUpdatedAt()).chatTheme).toBe('rose')

      const expiring = (
        await callTool(connection.access, 'appearance.propose_update', {
          tenantId,
          venueId,
          operationId: randomUUID(),
          expectedUpdatedAt: (await venueUpdatedAt()).updatedAt.toISOString(),
          chatTheme: 'dark',
        })
      ).structuredContent!
      const expired = await approveAndApplyProposal(
        {
          proposalId: expiring.proposalId,
          argsHash: expiring.argsHash,
          ...context,
          now: new Date(clock.getTime() + 73 * 3_600_000),
        },
        { database: db, kinds, allowedUserIds: config.allowedUserIds },
      )
      expect(expired.status).toBe('EXPIRED')
      expect(
        (
          await approveAndApplyProposal(
            { proposalId: expiring.proposalId, argsHash: expiring.argsHash, ...context },
            { database: db, kinds, allowedUserIds: config.allowedUserIds },
          )
        ).status,
      ).toBe('EXPIRED')
      expect((await venueUpdatedAt()).chatTheme).toBe('rose')
    })

    it('auto-applies only unlocked capabilities; reverts always ask and restore the before snapshot', async () => {
      const connection = await connect()
      await setAutonomyPolicy({
        capability: 'appearance:propose',
        mode: 'auto',
        userId: 'user_owner',
        requestId: randomUUID(),
      })
      // A bad stored row for a locked capability must not widen autonomy.
      await db.operatorAutonomyPolicy.upsert({
        where: { capability: 'operator:revert' },
        create: { capability: 'operator:revert', mode: 'AUTO', updatedByUserId: 'test' },
        update: { mode: 'AUTO' },
      })
      try {
        const before = await venueUpdatedAt()
        const auto = await callTool(connection.access, 'appearance.propose_update', {
          tenantId,
          venueId,
          operationId: randomUUID(),
          expectedUpdatedAt: before.updatedAt.toISOString(),
          chatTheme: 'sunset',
        })
        expect(auto.structuredContent).toMatchObject({ status: 'APPLIED' })
        expect(auto.structuredContent?.approveUrl).toBeUndefined()
        expect((await venueUpdatedAt()).chatTheme).toBe('sunset')
        const autoRow = await db.operatorProposal.findUnique({
          where: { id: auto.structuredContent!.proposalId },
        })
        expect(autoRow?.autoApproved).toBe(true)

        const revert = await callTool(connection.access, 'operator.propose_revert', {
          proposalId: auto.structuredContent!.proposalId,
          operationId: randomUUID(),
        })
        expect(revert.structuredContent).toMatchObject({ status: 'PENDING' })
        expect((await venueUpdatedAt()).chatTheme).toBe('sunset')
        const applied = await approveAndApplyProposal(
          {
            proposalId: revert.structuredContent!.proposalId,
            argsHash: revert.structuredContent!.argsHash,
            actorUserId: 'user_owner',
            requestId: randomUUID(),
            now: clock,
          },
          { database: db, kinds, allowedUserIds: config.allowedUserIds },
        )
        expect(applied.status).toBe('APPLIED')
        expect((await venueUpdatedAt()).chatTheme).toBe(before.chatTheme)
      } finally {
        await setAutonomyPolicy({
          capability: 'appearance:propose',
          mode: 'ask',
          userId: 'user_owner',
          requestId: randomUUID(),
        })
        await db.operatorAutonomyPolicy.update({
          where: { capability: 'operator:revert' },
          data: { mode: 'ASK' },
        })
      }
    })

    it('applies a plan in order after one approval and stops at the first failing step', async () => {
      const connection = await connect()
      const current = (await venueUpdatedAt()).updatedAt.toISOString()
      const plan = await callTool(connection.access, 'operator.propose_plan', {
        operationId: randomUUID(),
        title: 'Refresh the example garden look',
        steps: [
          {
            tool: 'appearance.propose_update',
            arguments: { tenantId, venueId, expectedUpdatedAt: current, chatTheme: 'forest' },
          },
          // Written against the old version: it goes STALE once step 0 lands.
          {
            tool: 'appearance.propose_update',
            arguments: { tenantId, venueId, expectedUpdatedAt: current, chatFont: 'inter' },
          },
          {
            tool: 'appearance.propose_update',
            arguments: {
              tenantId,
              venueId,
              expectedUpdatedAt: current,
              chatAccentColor: '#123456',
            },
          },
        ],
      })
      expect(plan.structuredContent).toMatchObject({ status: 'PENDING' })
      const view = plan.structuredContent!
      expect(view.approveUrl).toBe(`https://app.operator.test/approve/${view.proposalId}`)
      // Steps cannot be approved one by one.
      const firstStep = await db.operatorProposal.findFirst({
        where: { planId: view.proposalId, planStepIndex: 0 },
      })
      await expect(
        approveAndApplyProposal(
          {
            proposalId: firstStep!.id,
            argsHash: firstStep!.argsHash,
            actorUserId: 'user_owner',
            requestId: randomUUID(),
            now: clock,
          },
          { database: db, kinds, allowedUserIds: config.allowedUserIds },
        ),
      ).rejects.toBeInstanceOf(OperatorProposalError)
      const result = await approveAndApplyPlan(
        {
          planId: view.proposalId,
          argsHash: view.argsHash,
          actorUserId: 'user_owner',
          requestId: randomUUID(),
          now: clock,
        },
        { database: db, kinds, allowedUserIds: config.allowedUserIds },
      )
      expect(result.status).toBe('FAILED')
      expect(result.failedStepIndex).toBe(1)
      const steps = await db.operatorProposal.findMany({
        where: { planId: view.proposalId },
        orderBy: { planStepIndex: 'asc' },
      })
      expect(steps.map((step) => step.status)).toEqual(['APPLIED', 'STALE', 'REJECTED'])
      expect(steps[2]?.failureCode).toBe('PLAN_STOPPED')
      expect(steps[2]?.applyClaimedAt).toBeNull()
      const venue = await db.venue.findFirst({
        where: { id: venueId, tenantId },
        select: { chatTheme: true, chatAccentColor: true },
      })
      expect(venue).toMatchObject({ chatTheme: 'forest' })
      expect(venue?.chatAccentColor).not.toBe('#123456')
      // Replaying the plan approval does nothing.
      const again = await approveAndApplyPlan(
        {
          planId: view.proposalId,
          argsHash: view.argsHash,
          actorUserId: 'user_owner',
          requestId: randomUUID(),
          now: clock,
        },
        { database: db, kinds, allowedUserIds: config.allowedUserIds },
      )
      expect(again.status).toBe('FAILED')
    })

    it('refuses consent that Tom did not arm, and each arming covers one consent', async () => {
      const { client_id: clientId } = (await (await register()).json()) as { client_id: string }
      const params = {
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
      }
      const decision = {
        decision: 'approve' as const,
        allTenants: true,
        tenantIds: [],
        capabilities: ['operator:read' as const],
        expiresInDays: 1,
      }
      const userId = `user_phish_target_${suffix}`
      const consent = () =>
        completeAuthorization({
          config,
          userId,
          params,
          decision,
          now: clock,
          requestId: randomUUID(),
        })
      expect(await consent()).toEqual({ error: 'not_armed' })
      await armOperatorConnection({ userId, requestId: randomUUID() })
      expect('redirectTo' in (await consent())).toBe(true)
      expect(await consent()).toEqual({ error: 'not_armed' })
    })

    it('stops a connection as soon as its owner leaves the approver allowlist', async () => {
      const connection = await connect()
      const proposal = (
        await callTool(connection.access, 'appearance.propose_update', {
          tenantId,
          venueId,
          operationId: randomUUID(),
          expectedUpdatedAt: (await venueUpdatedAt()).updatedAt.toISOString(),
          chatFont: 'poppins',
        })
      ).structuredContent!
      const without = configFor({ OPERATOR_OAUTH_ALLOWED_USER_IDS: 'user_someone_else' })
      expect(
        (await mcp(connection.access, 'tools/list', undefined, { config: without })).status,
      ).toBe(401)
      const applied = await approveAndApplyProposal(
        {
          proposalId: proposal.proposalId,
          argsHash: proposal.argsHash,
          actorUserId: 'user_someone_else',
          requestId: randomUUID(),
          now: clock,
        },
        { database: db, kinds, allowedUserIds: without.allowedUserIds },
      )
      expect(applied.status).toBe('FAILED')
      expect(applied.failureCode).toBe('GRANT_REVOKED')
    })

    it('keeps another grant from reading, listing or reverting its proposals', async () => {
      const owner = await connect()
      const intruder = await connect()
      const view = (
        await callTool(owner.access, 'appearance.propose_update', {
          tenantId,
          venueId,
          operationId: randomUUID(),
          expectedUpdatedAt: (await venueUpdatedAt()).updatedAt.toISOString(),
          chatFont: 'dmSans',
        })
      ).structuredContent!
      expect(
        (await callTool(intruder.access, 'operator.get_proposal', { proposalId: view.proposalId }))
          .structuredContent,
      ).toMatchObject({ error: 'NOT_FOUND' })
      const listed = await callTool(intruder.access, 'operator.list_proposals', {})
      expect(JSON.stringify(listed.structuredContent)).not.toContain(view.proposalId)
      expect(
        (
          await callTool(intruder.access, 'operator.propose_revert', {
            proposalId: view.proposalId,
            operationId: randomUUID(),
          })
        ).structuredContent,
      ).toMatchObject({ error: 'NOT_FOUND' })
    })

    it('does not write audit rows for guessed tokens', async () => {
      const before = await db.operatorAuditEvent.count({ where: { eventType: 'mcp.denied' } })
      for (let index = 0; index < 5; index += 1) {
        const guessed = `pf_oat_stg_${randomBytes(32).toString('base64url')}`
        expect((await mcp(guessed, 'tools/list')).status).toBe(401)
      }
      expect(await db.operatorAuditEvent.count({ where: { eventType: 'mcp.denied' } })).toBe(before)
    })

    it('keeps the operator audit trail append-only in the database itself', async () => {
      const row = await db.operatorAuditEvent.findFirst({ where: { grantId: { in: grantIds } } })
      expect(row).not.toBeNull()
      await expect(
        db.$executeRawUnsafe(
          'UPDATE operator_audit_events SET outcome = $1 WHERE id = $2',
          'TAMPERED',
          row!.id,
        ),
      ).rejects.toThrow(/append-only/u)
      await expect(
        db.$executeRawUnsafe('DELETE FROM operator_audit_events WHERE id = $1', row!.id),
      ).rejects.toThrow(/append-only/u)
      await expect(db.operatorAuditEvent.deleteMany({ where: { id: row!.id } })).rejects.toThrow()
    })
  },
)
