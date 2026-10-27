/* eslint-disable @typescript-eslint/no-explicit-any -- MCP JSON-RPC bodies are read loosely */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/venue-package-semantic-analysis', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/venue-package-semantic-analysis')>()
  // A distinct unit vector per candidate: no provider call, and nothing reads as a duplicate.
  let next = 0
  const vector = () => {
    const values = new Array<number>(1536).fill(0)
    values[next++ % 1536] = 1
    return values
  }
  return {
    ...original,
    generateVenuePackageCandidateEmbeddings: vi.fn(
      async (params: Parameters<typeof original.generateVenuePackageCandidateEmbeddings>[0]) => {
        await params.admissionGuard()
        const inputs = original.venuePackageSemanticInputs(params.payload)
        return {
          places: inputs.places.map((_, draftIndex) => ({ draftIndex, embedding: vector() })),
          knowledgeEntries: inputs.knowledgeEntries.map((_, draftIndex) => ({
            draftIndex,
            embedding: vector(),
          })),
        }
      },
    ),
  }
})
vi.mock('../lib/rate-limit', () => ({ checkRateLimit: vi.fn().mockResolvedValue(true) }))

import { OperatorCapability } from '@pathfinder/contracts/operator-mcp'
import { createVenueAction, db, withTenantIsolationBypass } from '@pathfinder/db'

import { resolveOperatorConfig } from './config'
import { handleOperatorMcpRequest } from './http'
import {
  armOperatorConnection,
  completeAuthorization,
  handleClientRegistration,
  handleTokenRequest,
} from './oauth'

/**
 * An agent with no repository context authors a venue through the real operator MCP endpoint, a
 * real OAuth grant and a disposable PostgreSQL: it discovers the authoring contract, checks a
 * broken package and reads field-level fixes, checks and imports the contract's own complete
 * example, updates a record by id, publishes, and switches that one venue's model by its spoken
 * name. The venue, places and owner are fictional; nothing here reaches a hosted environment.
 */
const enabled =
  process.env.RUN_OPERATOR_DB_INTEGRATION === '1' &&
  /^postgres(?:ql)?:\/\/[^/]+\/pathfinder_disposable_[a-z0-9_]+(?:\?|$)/u.test(
    process.env.DATABASE_URL ?? '',
  )

const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
const ownerId = `user_authoring_owner_${suffix}`
const REDIRECT = 'https://connector.example.com/oauth/callback'
const GUEST_ORIGIN = 'https://guide.example.com'
const resolution = resolveOperatorConfig({
  OPERATOR_OAUTH_ENABLED: true,
  OPERATOR_OAUTH_ISSUER: 'https://app.operator.test',
  OPERATOR_OAUTH_PEPPERS: `k1:${randomBytes(32).toString('base64url')}`,
  OPERATOR_OAUTH_REDIRECT_ORIGINS: 'https://connector.example.com',
  OPERATOR_OAUTH_ALLOWED_USER_IDS: ownerId,
  RAILWAY_ENVIRONMENT: 'staging',
})
if (resolution.status !== 'ready') throw new Error('operator config not ready')
const config = resolution.config
const deps = { resolveConfig: () => resolution, database: db }

const doc = readFileSync(
  fileURLToPath(new URL('../../../../docs/operator/venue-authoring.md', import.meta.url)),
  'utf8',
).replaceAll('\r\n', '\n')
function docJson(marker: string): any {
  const start = doc.indexOf(`<!-- venue-authoring-${marker}`)
  const match = doc.slice(start).match(/```json\n([\s\S]*?)\n```/u)
  return JSON.parse(match![1]!)
}

type ToolResult = { isError: boolean; structuredContent: Record<string, any> }
let access = ''

async function rpc(method: string, params?: unknown) {
  const response = await handleOperatorMcpRequest(
    new Request('https://app.operator.test/api/operator/mcp', {
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
    deps,
  )
  const text = await response.text()
  return { status: response.status, body: text ? (JSON.parse(text) as any) : null }
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const response = await rpc('tools/call', { name, arguments: args })
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  return response.body.result as ToolResult
}

async function connect() {
  const registered = (await (
    await handleClientRegistration(
      new Request('https://app.operator.test/oauth/register', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `198.51.100.${1 + Math.floor(Math.random() * 250)}`,
        },
        body: JSON.stringify({ client_name: 'Example connector', redirect_uris: [REDIRECT] }),
      }),
      // Registration is rate-limited per hour on the shared disposable database.
      {
        ...deps,
        now: () => new Date(Date.UTC(2032, 0, 1) + Math.floor(Math.random() * 3_000_000) * 60_000),
      },
    )
  ).json()) as { client_id?: string; error?: string }
  if (!registered.client_id) throw new Error(`registration failed: ${registered.error}`)
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  await armOperatorConnection({ userId: ownerId, requestId: randomUUID() })
  const outcome = await completeAuthorization({
    config,
    userId: ownerId,
    params: {
      response_type: 'code',
      client_id: registered.client_id!,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'authoring',
      resource: config.resource,
      scope: 'operator',
    },
    decision: {
      decision: 'approve',
      allTenants: true,
      tenantIds: [],
      capabilities: [...OperatorCapability.options],
      expiresInDays: 1,
    },
    now: new Date(),
    requestId: randomUUID(),
  })
  if (!('redirectTo' in outcome)) throw new Error(`consent failed: ${outcome.error}`)
  const code = new URL(outcome.redirectTo).searchParams.get('code')!
  const token = await handleTokenRequest(
    new Request('https://app.operator.test/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: registered.client_id,
        redirect_uri: REDIRECT,
        resource: config.resource,
      }).toString(),
    }),
    deps,
  )
  const body = (await token.json()) as { access_token?: string }
  if (!body.access_token) throw new Error('no access token')
  return body.access_token
}

describe.skipIf(!enabled)('venue authoring through the operator MCP', { timeout: 300_000 }, () => {
  const tenantId = `authoring-${suffix}`
  let venueId = ''
  let siblingVenueId = ''

  beforeAll(async () => {
    delete process.env.OPERATOR_APPROVAL_MODE
    delete process.env.GUEST_CHAT_DEFAULT_MODEL_KEY
    process.env.NEXT_PUBLIC_WEB_URL = GUEST_ORIGIN
    await db.user.upsert({
      where: { id: ownerId },
      create: { id: ownerId, email: `owner-${suffix}@example.test` },
      update: {},
    })
    await withTenantIsolationBypass(async () => {
      await db.tenant.create({ data: { id: tenantId, name: 'Quillbrook Parks', slug: tenantId } })
      const actor = { type: 'HUMAN' as const, id: ownerId, role: 'OWNER' as const }
      venueId = (
        await createVenueAction({
          tenantId,
          actor,
          name: `Quillbrook Fun Park ${suffix}`,
          baseSlug: `quillbrook-${suffix}`,
          callerSuppliedSlug: true,
          guideMode: 'location_aware',
        })
      ).record.id
      siblingVenueId = (
        await createVenueAction({
          tenantId,
          actor,
          name: `Quillbrook Splash Pad ${suffix}`,
          baseSlug: `quillbrook-splash-${suffix}`,
          callerSuppliedSlug: true,
          guideMode: 'non_location',
        })
      ).record.id
    })
    access = await connect()
  })

  afterAll(async () => {
    process.env.OPERATOR_APPROVAL_MODE = 'review'
    delete process.env.NEXT_PUBLIC_WEB_URL
    await db.$disconnect()
  })

  it('tells a new client where the authoring contract is, and serves it with its schema', async () => {
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    expect(init.body.result.instructions).toContain('section "venue-authoring"')
    const listed = await rpc('tools/list')
    const manual = (listed.body.result.tools as Array<Record<string, any>>).find(
      (tool) => tool.name === 'operator.get_manual',
    )!
    expect(manual.description).toContain('venue-authoring')
    expect(manual.inputSchema.properties.section.enum).toEqual(['full', 'venue-authoring'])
    const contract = await call('operator.get_manual', { section: 'venue-authoring' })
    expect(contract.isError).toBe(false)
    expect(contract.structuredContent.text).toBe(doc)
    expect(contract.structuredContent.schema.properties.schemaVersion.const).toBe(3)
  })

  it('names each broken field with a fix, then checks the contract example as ready', async () => {
    const broken = await call('venues.check_package', {
      tenantId,
      venueId,
      payload: docJson('mistake:research-fields'),
    })
    expect(broken.isError).toBe(false)
    expect(broken.structuredContent.importable).toBe(false)
    const fields = broken.structuredContent.errors.map((error: any) => error.path)
    expect(fields).toEqual(['places.0.latitude', 'places.0.longitude', 'places.0.notes'])
    for (const error of broken.structuredContent.errors)
      expect(error.fix.length).toBeGreaterThan(20)

    const advised = await call('venues.check_package', {
      tenantId,
      venueId,
      payload: docJson('mistake:placeholders'),
    })
    expect(advised.structuredContent.importable).toBe(true)
    expect(advised.structuredContent.authoring.shown.map((f: any) => f.code)).toEqual(
      expect.arrayContaining(['PLACEHOLDER_FACT', 'UNDATED_SEASON', 'AMBIGUOUS_DATE']),
    )

    const complete = await call('venues.check_package', {
      tenantId,
      venueId,
      payload: docJson('example:complete'),
    })
    expect(complete.structuredContent).toMatchObject({
      importable: true,
      ready: true,
      errorCount: 0,
      plan: {
        places: { create: 3, update: 0, remove: 0 },
        knowledgeEntries: { create: 7, update: 0, remove: 0 },
      },
    })
    expect(complete.structuredContent.venueSetup.map((f: any) => f.code)).toContain(
      'VENUE_SETUP_TIME_ZONE',
    )
  })

  it('imports the example once with provenance; records stay hidden until published', async () => {
    const payload = docJson('example:complete')
    const args = { operationId: randomUUID(), tenantId, venueId, payload }
    const imported = await call('venues.propose_package_import', args)
    expect(imported.isError, JSON.stringify(imported.structuredContent)).toBe(false)
    expect(imported.structuredContent.status).toBe('APPLIED')
    const replay = await call('venues.propose_package_import', args)
    expect(replay.structuredContent.proposalId).toBe(imported.structuredContent.proposalId)

    await withTenantIsolationBypass(async () => {
      const places = await db.place.findMany({ where: { tenantId, venueId } })
      expect(places.map((place) => place.name).sort()).toEqual([
        'Comet Chaser',
        'Hollow Log Grill',
        'Lily Pad Leap',
      ])
      const grill = await db.venueKnowledgeEntry.findFirstOrThrow({
        where: { tenantId, venueId, title: 'Hours and season' },
      })
      expect(grill).toMatchObject({
        sourceName: 'Quillbrook hours page',
        sourceType: 'official_website',
      })
    })
    const link = await call('venues.get_guest_link', { tenantId, venueId })
    expect(link.structuredContent.usable).toBe(false)
  })

  it('updates a record by the id venues.list_content returns, then publishes', async () => {
    const listed = await call('venues.list_content', {
      tenantId,
      venueId,
      representation: 'LEGACY_PLACE',
    })
    expect(listed.isError, JSON.stringify(listed.structuredContent)).toBe(false)
    const comet = (listed.structuredContent.items as any[]).find((row) =>
      JSON.stringify(row).includes('Comet Chaser'),
    )!
    const update = docJson('example:update-and-retire')
    update.places.update = [{ ...update.places.update[0], id: comet.id }]
    const checked = await call('venues.check_package', { tenantId, venueId, payload: update })
    expect(checked.structuredContent).toMatchObject({ importable: true, ready: true })
    const applied = await call('venues.propose_package_import', {
      operationId: randomUUID(),
      tenantId,
      venueId,
      payload: update,
    })
    expect(applied.structuredContent.status, JSON.stringify(applied.structuredContent)).toBe(
      'APPLIED',
    )
    const row = await withTenantIsolationBypass(() =>
      db.place.findFirstOrThrow({ where: { tenantId, venueId, id: comet.id } }),
    )
    expect(row.longDescription).toContain('Height: 44 in to ride; 38 in with an adult')

    const published = await call('venues.propose_publish', {
      operationId: randomUUID(),
      tenantId,
      venueId,
    })
    expect(published.structuredContent.status).toBe('APPLIED')
    const link = await call('venues.get_guest_link', { tenantId, venueId })
    expect(link.structuredContent).toMatchObject({ usable: true, blockers: [] })
  })

  it('switches only this venue to "6.1 Terra" by name, with a receipt, and restores it', async () => {
    const view = await call('venues.get_guest_model', { tenantId, venueId })
    const terra = (view.structuredContent.choices as any[]).filter((choice) =>
      choice.alsoKnownAs.includes('6.1 Terra'),
    )
    expect(terra.map((choice) => choice.modelKey)).toEqual(['guest-chat-terra-fast'])
    const refused = await call('venues.propose_guest_model', {
      operationId: randomUUID(),
      tenantId,
      venueId,
      modelKey: '6.1 Terra',
    })
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent.error).toBe('INVALID_ARGUMENTS')
    expect(refused.structuredContent.issues[0].allowed).toContain('guest-chat-terra-fast')
    expect(refused.structuredContent.hint).toContain('venues.get_guest_model')

    const set = await call('venues.propose_guest_model', {
      operationId: randomUUID(),
      tenantId,
      venueId,
      modelKey: terra[0].modelKey,
      expectedRevision: view.structuredContent.venueOverride?.revision ?? null,
    })
    if (!terra[0].available) {
      expect(set.structuredContent.error).toBe('MODEL_UNAVAILABLE')
      return
    }
    expect(set.structuredContent).toMatchObject({
      status: 'APPLIED',
      result: {
        scope: 'this venue only',
        effective: {
          modelKey: 'guest-chat-terra-fast',
          model: 'gpt-6.1-terra',
          source: 'VENUE_OVERRIDE',
        },
      },
    })
    const sibling = await call('venues.get_guest_model', { tenantId, venueId: siblingVenueId })
    expect(sibling.structuredContent.effective.source).not.toBe('VENUE_OVERRIDE')
    const reset = await call('venues.propose_guest_model_reset', {
      operationId: randomUUID(),
      tenantId,
      venueId,
    })
    expect(reset.structuredContent).toMatchObject({
      status: 'APPLIED',
      result: { previous: { modelKey: 'guest-chat-terra-fast', source: 'VENUE_OVERRIDE' } },
    })
    const after = await call('venues.get_guest_model', { tenantId, venueId })
    expect(after.structuredContent.effective.source).not.toBe('VENUE_OVERRIDE')
  })
})
