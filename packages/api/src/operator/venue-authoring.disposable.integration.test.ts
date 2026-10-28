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

// Exercise configuration writes without a real provider credential or inference call.
const providers = vi.hoisted(() => ({ available: true }))
vi.mock('../routers/admin/ai-provider-connections', () => ({
  providerHasExecutionKey: (provider: string) => provider === 'openai' && providers.available,
}))

import { OperatorCapability } from '@pathfinder/contracts/operator-mcp'
import {
  createVenueAction,
  db,
  saveAiWorkloadConfigurationOverrideAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

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
 * example, reads record ids, sees a second package predicted to fail until embeddings refresh,
 * publishes, and switches that one venue's model by its spoken name. The venue, places and owner are fictional; nothing here reaches a hosted environment.
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

async function connect(scope?: { tenantIds: string[]; capabilities: OperatorCapability[] }) {
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
      allTenants: scope === undefined,
      tenantIds: scope?.tenantIds ?? [],
      capabilities: scope?.capabilities ?? [...OperatorCapability.options],
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
      // Venues the MCP creates start as drafts; mirror that so publish is a real step.
      await db.venue.updateMany({
        where: { tenantId, id: { in: [venueId, siblingVenueId] } },
        data: { isActive: false },
      })
    })
    access = await connect()
  })

  afterAll(async () => {
    // Imports queue embedding work for this test tenant. The outbox is leased across tenants, so
    // leave none behind for later suites on the shared disposable database.
    await db.embeddingDispatch.deleteMany({ where: { tenantId } })
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

  it('reads ids from venues.list_content, and predicts the refusal until embeddings refresh', async () => {
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
    // The other imported places have no embeddings yet (the refresher is an operator step), so
    // the import's duplicate scan would refuse this package. The check says so before importing.
    const checked = await call('venues.check_package', { tenantId, venueId, payload: update })
    expect(checked.structuredContent).toMatchObject({ importable: false, ready: false })
    expect(checked.structuredContent.errors[0]).toMatchObject({
      code: 'SEMANTIC_SCAN_INCOMPLETE',
      path: 'places',
    })
    expect(checked.structuredContent.errors[0].fix).toContain('embedding refresh')
    const refused = await call('venues.propose_package_import', {
      operationId: randomUUID(),
      tenantId,
      venueId,
      payload: update,
    })
    expect(refused.structuredContent).toMatchObject({
      status: 'FAILED',
      result: { failureCode: 'PACKAGE_REJECTED' },
    })
    const row = await withTenantIsolationBypass(() =>
      db.place.findFirstOrThrow({ where: { tenantId, venueId, id: comet.id } }),
    )
    expect(row.longDescription).toContain('Height: 42 in to ride; 36 in with an adult')

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

    expect(terra[0].available).toBe(true)
    const set = await call('venues.propose_guest_model', {
      operationId: randomUUID(),
      tenantId,
      venueId,
      modelKey: terra[0].modelKey,
      expectedRevision: view.structuredContent.venueOverride?.revision ?? null,
    })
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

  it('checks only relevant embedding coverage and never creates package or embedding work', async () => {
    const counts = async () => ({
      packages: await db.venuePackage.count({ where: { tenantId, venueId } }),
      dispatches: await db.embeddingDispatch.count({ where: { tenantId } }),
      proposals: await db.operatorProposal.count({ where: { targetTenantId: tenantId } }),
    })
    const before = await counts()
    const settingsOnly = await call('venues.check_package', {
      tenantId,
      venueId,
      payload: {
        schemaVersion: 3,
        venue: { identity: { description: 'A fictional family park.' } },
        places: {},
        knowledgeEntries: {},
      },
    })
    expect(settingsOnly.structuredContent).toMatchObject({ importable: true, errorCount: 0 })
    const topicOnly = await call('venues.check_package', {
      tenantId,
      venueId,
      payload: {
        schemaVersion: 3,
        places: {},
        knowledgeEntries: {
          create: [
            {
              itemKey: randomUUID(),
              provenance: { sourceType: 'venue_staff', contentOrigin: 'HUMAN_AUTHORED' },
              value: {
                title: 'Lost belongings',
                category: 'Visiting',
                content: 'Lost belongings are held at the front desk.',
              },
            },
          ],
        },
      },
    })
    expect(
      topicOnly.structuredContent.errors.map((entry: any) => [entry.code, entry.path]),
    ).toEqual([['SEMANTIC_SCAN_INCOMPLETE', 'knowledgeEntries']])
    const places = await withTenantIsolationBypass(() =>
      db.place.findMany({ where: { tenantId, venueId } }),
    )
    const allPlacesUpdated = await call('venues.check_package', {
      tenantId,
      venueId,
      payload: {
        schemaVersion: 3,
        knowledgeEntries: {},
        places: {
          update: places.map((place) => ({
            itemKey: randomUUID(),
            id: place.id,
            provenance: { sourceType: 'venue_staff', contentOrigin: 'HUMAN_AUTHORED' },
            value: {
              name: place.name,
              type: place.type,
              itemType: place.itemType,
              shortDescription: place.shortDescription,
              longDescription: place.longDescription,
              tags: place.tags,
              importanceScore: place.importanceScore,
              areaName: place.areaName,
              hours: '10am-6pm daily',
              photoUrl: place.photoUrl,
              lat: place.lat,
              lng: place.lng,
              isActive: true,
            },
          })),
        },
      },
    })
    // Every existing place is replaced in this package, so none needs a comparison vector.
    // Missing topic vectors must not block a places-only change.
    expect(allPlacesUpdated.structuredContent).toMatchObject({ importable: true, errorCount: 0 })
    expect(await counts()).toEqual(before)
    const placesAfter = await withTenantIsolationBypass(() =>
      db.place.findMany({ where: { tenantId, venueId }, orderBy: { id: 'asc' } }),
    )
    expect(placesAfter).toEqual(places.sort((a, b) => a.id.localeCompare(b.id)))
  })

  it('refuses unavailable providers without changing the effective venue model', async () => {
    providers.available = false
    try {
      const before = await call('venues.get_guest_model', { tenantId, venueId })
      const refused = await call('venues.propose_guest_model', {
        operationId: randomUUID(),
        tenantId,
        venueId,
        modelKey: 'guest-chat-terra-fast',
      })
      expect(refused.structuredContent.error).toBe('MODEL_UNAVAILABLE')
      const after = await call('venues.get_guest_model', { tenantId, venueId })
      expect(after.structuredContent.effective).toEqual(before.structuredContent.effective)
      expect(after.structuredContent.venueOverride).toEqual(before.structuredContent.venueOverride)
    } finally {
      providers.available = true
    }
  })

  it('replays a model-change receipt without another write, and refuses changed arguments', async () => {
    const args = { tenantId, venueId, modelKey: 'guest-chat-sol-fast', operationId: randomUUID() }
    const first = await call('venues.propose_guest_model', args)
    expect(first.structuredContent.status).toBe('APPLIED')
    const before = await call('venues.get_guest_model', { tenantId, venueId })
    const historyBefore = await db.aiScopedWorkloadConfigurationHistory.count({
      where: { tenantId, venueId },
    })
    const replay = await call('venues.propose_guest_model', args)
    expect(replay.structuredContent.proposalId).toBe(first.structuredContent.proposalId)
    expect(replay.structuredContent.result).toEqual(first.structuredContent.result)
    const reused = await call('venues.propose_guest_model', {
      ...args,
      modelKey: 'guest-chat-terra-fast',
    })
    expect(reused.structuredContent.error).toBe('OPERATION_ID_REUSED')
    const after = await call('venues.get_guest_model', { tenantId, venueId })
    expect(after.structuredContent).toEqual(before.structuredContent)
    expect(
      await db.aiScopedWorkloadConfigurationHistory.count({ where: { tenantId, venueId } }),
    ).toBe(historyBefore)
  })

  it('allows only one of two competing model edits at the same revision', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await call('venues.get_guest_model', { tenantId, venueId })
      const modelKeys = ['guest-chat-sol-fast', 'guest-chat-terra-fast', 'guest-chat-luna'].filter(
        (key) => key !== before.structuredContent.effective.modelKey,
      )
      const results = await Promise.all(
        modelKeys.map((modelKey) =>
          call('venues.propose_guest_model', {
            tenantId,
            venueId,
            modelKey,
            expectedRevision: before.structuredContent.venueOverride.revision,
            operationId: randomUUID(),
          }),
        ),
      )
      expect(results.map((result) => result.structuredContent.status).sort()).toEqual([
        'APPLIED',
        'STALE',
      ])
      const winner = results.find((result) => result.structuredContent.status === 'APPLIED')!
      const after = await call('venues.get_guest_model', { tenantId, venueId })
      expect(after.structuredContent.effective.modelKey).toBe(
        winner.structuredContent.result.modelKey,
      )
      expect(after.structuredContent.venueOverride.revision).toBe(
        before.structuredContent.venueOverride.revision + 1,
      )
    }
  })

  it('keeps unrelated dashboard settings through model changes and reset', async () => {
    const before = await call('venues.get_guest_model', { tenantId, venueId })
    await saveAiWorkloadConfigurationOverrideAction(
      {
        scope: { level: 'VENUE', tenantId, venueId, workloadId: 'guest-chat' },
        actor: { type: 'HUMAN', id: ownerId, role: 'PLATFORM_ADMIN' },
        expectedRevision: before.structuredContent.venueOverride.revision,
        enabled: true,
        values: { primaryModelKey: 'guest-chat-terra-fast', timeoutMs: 9000 },
        unsafeChangesEnabled: true,
        reason: 'Disposable dashboard settings fixture',
      },
      db,
    )
    const set = await call('venues.propose_guest_model', {
      tenantId,
      venueId,
      modelKey: 'guest-chat-sol-fast',
      operationId: randomUUID(),
    })
    expect(set.structuredContent.status).toBe('APPLIED')
    const reset = await call('venues.propose_guest_model_reset', {
      tenantId,
      venueId,
      operationId: randomUUID(),
    })
    expect(reset.structuredContent.status).toBe('APPLIED')
    const row = await db.aiScopedWorkloadConfigurationOverride.findFirstOrThrow({
      where: { tenantId, venueId, workloadId: 'guest-chat' },
    })
    expect(row).toMatchObject({
      timeoutMs: 9000,
      timeoutMsSet: true,
      primaryModelKeySet: false,
      isTombstone: false,
    })
    const after = await call('venues.get_guest_model', { tenantId, venueId })
    expect(after.structuredContent.effective.source).not.toBe('VENUE_OVERRIDE')
    expect(after.structuredContent.venueOverride.otherSettings).toEqual(['timeoutMs'])
  })

  it('limits a real read-only OAuth grant to its tenant and refuses model writes', async () => {
    const foreignTenantId = `authoring-other-${suffix}`
    const foreignVenueId = await withTenantIsolationBypass(async () => {
      await db.tenant.create({
        data: { id: foreignTenantId, name: 'Silver Birch Museum', slug: foreignTenantId },
      })
      const created = await createVenueAction({
        tenantId: foreignTenantId,
        actor: { type: 'HUMAN', id: ownerId, role: 'OWNER' },
        name: 'Silver Birch Museum',
        baseSlug: `silver-birch-${suffix}`,
        callerSuppliedSlug: true,
        guideMode: 'non_location',
      })
      return created.record.id
    })
    const originalAccess = access
    const before = await call('venues.get_guest_model', { tenantId, venueId })
    const proposalCount = await db.operatorProposal.count({ where: { targetTenantId: tenantId } })
    try {
      access = await connect({
        tenantIds: [tenantId],
        capabilities: ['operator:read', 'venues:read'],
      })
      const manual = await call('operator.get_manual', { section: 'venue-authoring' })
      expect(manual.isError).toBe(false)
      const own = await call('venues.get_guest_model', { tenantId, venueId })
      expect(own.structuredContent).toEqual(before.structuredContent)
      const foreign = await call('venues.get_guest_model', {
        tenantId: foreignTenantId,
        venueId: foreignVenueId,
      })
      expect(foreign.structuredContent.error).toBe('NOT_FOUND')
      expect(foreign.structuredContent.effective).toBeUndefined()
      const write = await call('venues.propose_guest_model', {
        tenantId,
        venueId,
        modelKey: 'guest-chat-terra-fast',
        operationId: randomUUID(),
      })
      expect(write.structuredContent.error).toBe('CAPABILITY_DENIED')
      expect(await db.operatorProposal.count({ where: { targetTenantId: tenantId } })).toBe(
        proposalCount,
      )
      const after = await call('venues.get_guest_model', { tenantId, venueId })
      expect(after.structuredContent).toEqual(before.structuredContent)
    } finally {
      access = originalAccess
    }
  })
})
