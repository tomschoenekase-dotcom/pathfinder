/* eslint-disable @typescript-eslint/no-explicit-any -- MCP JSON-RPC bodies are read loosely */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
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
vi.mock('../lib/guest-query-embedding', () => ({
  generateGuestQueryEmbedding: vi.fn(
    async (
      _text: string,
      _usageSink: unknown,
      _admissionGuard: unknown,
      _budgetGate: unknown,
      _invocationId: string | undefined,
      onBeforeFirstDispatch: (() => Promise<void>) | undefined,
    ) => {
      await onBeforeFirstDispatch?.()
      return null
    },
  ),
}))

import type { AnthropicMessagesClient } from '@pathfinder/ai'
import { OperatorCapability } from '@pathfinder/contracts/operator-mcp'
import { createVenueAction, db, withTenantIsolationBypass } from '@pathfinder/db'

import type { TRPCContext } from '../context'
import { router } from '../core'
import { _setAnthropicClientForTesting, chatRouter } from '../routers/chat'
import { venueRouter } from '../routers/venue'

import { resolveOperatorConfig } from './config'
import { handleOperatorMcpRequest } from './http'
import {
  armOperatorConnection,
  completeAuthorization,
  handleClientRegistration,
  handleTokenRequest,
} from './oauth'
import { setCustomerProviderForTests, type CustomerProvider } from './kinds/customers'
import { OperatorNotFoundError } from './grants'
import {
  resolvePackageAttachment,
  setPackageFileDownloadForTests,
} from './kinds/venues-package-import'

/**
 * Tom's whole onboarding flow, through the real operator MCP endpoint with a real OAuth
 * connection, on a disposable PostgreSQL: create a customer, create a venue, import a large venue
 * package, customize the look and the chatbot, publish and read the visitor link, then ask the
 * visitor chatbot a question that only the imported content answers. Retries, refusals and
 * readback are checked at each step. Invented names, a fake identity provider and a fake model.
 */
const enabled =
  process.env.RUN_OPERATOR_DB_INTEGRATION === '1' &&
  /^postgres(?:ql)?:\/\/[^/]+\/pathfinder_disposable_[a-z0-9_]+(?:\?|$)/u.test(
    process.env.DATABASE_URL ?? '',
  )

const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
const ownerId = `user_flow_owner_${suffix}`
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

const createdOrganizations: string[] = []
/** Like the real provider: the organization.created webhook lands the bare tenant first. */
const fakeProvider: CustomerProvider = {
  createOrganization: (async (input: { name: string; slug: string }) => {
    const id = `org_flow_${randomUUID().replaceAll('-', '').slice(0, 16)}`
    createdOrganizations.push(id)
    await withTenantIsolationBypass(() =>
      db.tenant.upsert({
        where: { id },
        create: { id, name: input.name, slug: `provider-${id}` },
        update: { name: input.name },
      }),
    )
    return { id, name: input.name, slug: `provider-${id}` }
  }) as never,
  validateOwner: (async (input: {
    organizationId: string
    userId: string
    emailAddress: string
  }) => ({
    organizationId: input.organizationId,
    organizationName: 'Example',
    organizationSlug: `provider-${input.organizationId}`,
    userId: input.userId,
    emailAddress: input.emailAddress,
  })) as never,
  ensureInvitation: (async () => ({ id: 'inv_unused', replayed: false })) as never,
  listPendingInvitations: (async () => []) as never,
  findOrganizations: (async () => ({ candidates: [], complete: true })) as never,
}

type ToolResult = { isError: boolean; structuredContent: Record<string, any> }

async function rpc(access: string, method: string, params?: unknown, rawBody?: string) {
  const response = await handleOperatorMcpRequest(
    new Request('https://app.operator.test/api/operator/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${access}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body:
        rawBody ??
        JSON.stringify({
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

let access = ''
async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const response = await rpc(access, 'tools/call', { name, arguments: args })
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  return response.body.result as ToolResult
}

async function connect() {
  const registered = (await (
    await handleClientRegistration(
      new Request('https://app.operator.test/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
        body: JSON.stringify({ client_name: 'Example connector', redirect_uris: [REDIRECT] }),
      }),
      deps,
    )
  ).json()) as { client_id: string }
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  await armOperatorConnection({ userId: ownerId, requestId: randomUUID() })
  const outcome = await completeAuthorization({
    config,
    userId: ownerId,
    params: {
      response_type: 'code',
      client_id: registered.client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'flow',
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

/**
 * A realistic large package: 160 knowledge records of full prose with typographic punctuation,
 * accents and emoji, each with its own provenance. One record holds the fact the visitor asks
 * about. Serialized with escaped non-ASCII, as many MCP clients send it, it is well over 128 KiB.
 */
const FACT_TITLE = 'Lantern Lagoon boat ride'
const FACT =
  'The Lantern Lagoon boat ride leaves every 20 minutes from Pier Seven between 11:00 and 18:40; riders must be at least 107 cm tall.'
function largePackage() {
  const prose = (index: number) =>
    `Record ${index} — “Ocean Grove” guide notes: the café near Gate ${index % 9} serves crêpes and ` +
    'açaí bowls 🍓, and staff can point you to step-free routes. '.repeat(14) +
    `Ends with marker ${index}.`
  return {
    schemaVersion: 3,
    places: { create: [], update: [], delete: [] },
    knowledgeEntries: {
      create: Array.from({ length: 160 }, (_, index) => ({
        itemKey: randomUUID(),
        provenance: {
          sourceType: 'OFFICIAL_WEBSITE',
          sourceName: `Ocean Grove official page ${index}`,
          sourceUrl: `https://www.ocean-grove.example.com/guide/${index}`,
          contentOrigin: 'HUMAN_AUTHORED',
        },
        value:
          index === 42
            ? { title: FACT_TITLE, category: 'Rides', content: FACT, isEnabled: true }
            : {
                title: `Ocean Grove record ${index}`,
                category: index % 2 ? 'Dining' : 'Accessibility',
                content: prose(index),
                isEnabled: true,
              },
      })),
      update: [],
      delete: [],
    },
  }
}
const asciiEscapedJson = (value: unknown) =>
  JSON.stringify(value).replace(
    /[\u007f-￿]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )

describe.skipIf(!enabled)('operator onboarding flow end to end', { timeout: 300_000 }, () => {
  let otherTenantId = ''
  let otherVenueId = ''
  const sharedName = `Harbor Hall ${suffix}`
  const sharedSlug = `harbor-hall-${suffix}`

  beforeAll(async () => {
    delete process.env.OPERATOR_APPROVAL_MODE
    process.env.OPERATOR_CUSTOMER_CREATE_ENABLED = 'true'
    process.env.NEXT_PUBLIC_WEB_URL = GUEST_ORIGIN
    setCustomerProviderForTests(fakeProvider)
    await db.user.upsert({
      where: { id: ownerId },
      create: { id: ownerId, email: `owner-${suffix}@example.test` },
      update: {},
    })
    // Another customer already has a live venue whose name the new customer will reuse.
    otherTenantId = `flow-other-${suffix}`
    await withTenantIsolationBypass(async () => {
      await db.tenant.create({
        data: { id: otherTenantId, name: 'Another customer', slug: otherTenantId },
      })
      otherVenueId = (
        await createVenueAction({
          tenantId: otherTenantId,
          actor: { type: 'HUMAN', id: ownerId, role: 'OWNER' },
          name: sharedName,
          baseSlug: sharedSlug,
          callerSuppliedSlug: true,
          guideMode: 'non_location',
        })
      ).record.id
      await db.venue.update({ where: { id: otherVenueId }, data: { isActive: true } })
    })
    access = await connect()
  })

  afterAll(async () => {
    process.env.OPERATOR_APPROVAL_MODE = 'review'
    delete process.env.OPERATOR_CUSTOMER_CREATE_ENABLED
    delete process.env.NEXT_PUBLIC_WEB_URL
    setCustomerProviderForTests(null)
    setPackageFileDownloadForTests(null)
    _setAnthropicClientForTesting(null)
    await db.$disconnect()
  })

  let tenantId = ''
  let venueId = ''
  let slug = ''
  let welcomeVenueId = ''

  it('reports every onboarding tool as available and applied without approval', async () => {
    const listed = await rpc(access, 'tools/list')
    const names = (listed.body.result.tools as Array<{ name: string }>).map((tool) => tool.name)
    for (const name of [
      'customers.propose_create',
      'venues.propose_create',
      'venues.propose_package_import',
      'appearance.propose_update',
      'venues.propose_update',
      'venues.propose_publish',
      'venues.get_guest_link',
    ]) {
      expect(names).toContain(name)
    }
    const context = await call('operator.get_context', {})
    const tools = context.structuredContent.tools as Array<Record<string, any>>
    for (const name of [
      'customers.propose_create',
      'venues.propose_create',
      'venues.propose_package_import',
      'appearance.propose_update',
      'venues.propose_update',
      'venues.propose_publish',
    ]) {
      const tool = tools.find((entry) => entry.name === name)!
      expect(tool, name).toMatchObject({
        implemented: true,
        authorized: true,
        approvalMode: 'auto',
      })
      if (tool.deploymentPrerequisite) expect(tool.deploymentPrerequisite.enabled).toBe(true)
    }
  })

  it('1. creates the customer once, even when the call is retried', async () => {
    const args = {
      operationId: randomUUID(),
      organizationName: `Ocean Grove Parks ${suffix}`,
      venueName: `Ocean Grove Welcome Center ${suffix}`,
      city: 'Exampleville',
    }
    const first = await call('customers.propose_create', args)
    expect(first.isError, JSON.stringify(first.structuredContent)).toBe(false)
    expect(first.structuredContent).toMatchObject({ status: 'APPLIED' })
    tenantId = first.structuredContent.result.tenantId
    welcomeVenueId = first.structuredContent.result.venueId
    const retry = await call('customers.propose_create', args)
    expect(retry.structuredContent).toMatchObject({
      status: 'APPLIED',
      proposalId: first.structuredContent.proposalId,
    })
    expect(createdOrganizations).toHaveLength(1)
    const tenants = await db.tenant.count({ where: { name: args.organizationName } })
    expect(tenants).toBe(1)
  })

  it('2. creates a venue whose visitor link cannot collide with another customer', async () => {
    const args = { operationId: randomUUID(), tenantId, name: sharedName }
    const first = await call('venues.propose_create', args)
    expect(first.isError, JSON.stringify(first.structuredContent)).toBe(false)
    expect(first.structuredContent).toMatchObject({ status: 'APPLIED' })
    venueId = first.structuredContent.result.venueId
    slug = first.structuredContent.result.slug
    // The other customer's venue already owns this public path; ours must get its own.
    expect(slug).not.toBe(sharedSlug)
    const retry = await call('venues.propose_create', args)
    expect(retry.structuredContent).toMatchObject({
      status: 'APPLIED',
      proposalId: first.structuredContent.proposalId,
    })
    const venues = await withTenantIsolationBypass(() =>
      db.venue.count({ where: { tenantId, name: sharedName } }),
    )
    expect(venues).toBe(1)
    // A caller-chosen slug held by another customer is refused with a useful error, not adopted.
    const taken = await call('venues.propose_create', {
      operationId: randomUUID(),
      tenantId,
      name: 'Another hall',
      slug: sharedSlug,
    })
    expect(taken.isError).toBe(true)
    expect(taken.structuredContent).toMatchObject({ error: 'SLUG_TAKEN', outcome: 'none' })
  })

  it('3. imports a package larger than 128 KiB with every record exact, once', async () => {
    const payload = largePackage()
    const operationId = randomUUID()
    const body = asciiEscapedJson({
      jsonrpc: '2.0',
      id: 'import',
      method: 'tools/call',
      params: {
        name: 'venues.propose_package_import',
        arguments: { operationId, tenantId, venueId, payload },
      },
    })
    expect(Buffer.byteLength(body)).toBeGreaterThan(128 * 1024)
    const response = await rpc(access, 'tools/call', undefined, body)
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    const view = response.body.result as ToolResult
    expect(view.isError, JSON.stringify(view.structuredContent)).toBe(false)
    expect(view.structuredContent).toMatchObject({ status: 'APPLIED' })
    const packageId = view.structuredContent.result.packageId
    const replay = await rpc(access, 'tools/call', undefined, body)
    expect(replay.body.result.structuredContent).toMatchObject({
      status: 'APPLIED',
      proposalId: view.structuredContent.proposalId,
    })
    await withTenantIsolationBypass(async () => {
      const stored = await db.venuePackage.findFirstOrThrow({ where: { id: packageId, tenantId } })
      expect(stored.payload).toEqual(payload)
      expect(await db.venuePackage.count({ where: { tenantId, venueId } })).toBe(1)
      const rows = await db.venueKnowledgeEntry.findMany({ where: { tenantId, venueId } })
      expect(rows).toHaveLength(160)
      const versions = await db.contentVersion.findMany({
        where: { tenantId, venueId, venuePackageId: packageId, venuePackageAction: 'APPLY' },
      })
      expect(versions).toHaveLength(160)
      for (const item of payload.knowledgeEntries.create) {
        const row = rows.find((candidate) => candidate.title === item.value.title)!
        expect(row).toMatchObject({
          ...item.value,
          sourceType: item.provenance.sourceType,
          sourceName: item.provenance.sourceName,
          sourceUrl: item.provenance.sourceUrl,
          sourcePackageId: packageId,
        })
        const version = versions.find((entry) => entry.venuePackageItemKey === item.itemKey)!
        expect(version.sourceProvenance).toMatchObject(item.provenance)
      }
    })
    // A broken package names the problem and changes nothing.
    const invalid = await call('venues.propose_package_import', {
      operationId: randomUUID(),
      tenantId,
      venueId,
      payload: { schemaVersion: 1, places: [], knowledgeEntries: [] },
    })
    expect(invalid.isError).toBe(true)
    expect(invalid.structuredContent).toMatchObject({ outcome: 'none' })
    expect(JSON.stringify(invalid.structuredContent)).toMatch(/knowledge entry/u)
  })

  it('3b. imports an attached package file exactly, and a re-attached file replays', async () => {
    const payload = largePackage()
    // How a user's .json export arrives: pretty-printed, with a byte-order mark.
    const files = new Map([['file_ok', `\uFEFF${JSON.stringify({ payload }, null, 2)}`]])
    files.set('file_broken', '{"schemaVersion": 3, "places": ')
    const fetched: string[] = []
    setPackageFileDownloadForTests(async (file) => {
      fetched.push(file.download_url)
      return files.get(file.file_id)!
    })
    const operationId = randomUUID()
    const attach = (url: string, fileId = 'file_ok') => ({
      operationId,
      tenantId,
      venueId: welcomeVenueId,
      file: {
        download_url: url,
        file_id: fileId,
        mime_type: 'application/json',
        file_name: 'package.json',
      },
    })
    const first = await call('venues.propose_package_import', attach('https://files.example.com/a'))
    expect(first.isError, JSON.stringify(first.structuredContent)).toBe(false)
    expect(first.structuredContent).toMatchObject({ status: 'APPLIED' })
    // The attachment link is signed per message; the same file under a new link is the same work.
    const again = await call('venues.propose_package_import', attach('https://files.example.com/b'))
    expect(again.structuredContent).toMatchObject({
      status: 'APPLIED',
      proposalId: first.structuredContent.proposalId,
    })
    expect(fetched).toHaveLength(2)
    await withTenantIsolationBypass(async () => {
      const stored = await db.venuePackage.findFirstOrThrow({
        where: { id: first.structuredContent.result.packageId, tenantId },
      })
      expect(stored.payload).toEqual(payload)
      const rows = await db.venueKnowledgeEntry.findMany({
        where: { tenantId, venueId: welcomeVenueId },
      })
      expect(rows).toHaveLength(160)
      for (const item of payload.knowledgeEntries.create) {
        expect(rows.find((row) => row.title === item.value.title)).toMatchObject({
          content: item.value.content,
          sourceName: item.provenance.sourceName,
          sourceUrl: item.provenance.sourceUrl,
        })
      }
    })
    const broken = await call('venues.propose_package_import', {
      ...attach('https://files.example.com/c', 'file_broken'),
      operationId: randomUUID(),
    })
    expect(broken).toMatchObject({
      isError: true,
      structuredContent: { error: 'PACKAGE_REJECTED', outcome: 'none', retryable: false },
    })
    // A connection limited to this customer cannot make the server fetch for another one.
    const before = fetched.length
    await expect(
      resolvePackageAttachment(
        {
          ...attach('https://files.example.com/d'),
          tenantId: otherTenantId,
          venueId: otherVenueId,
        },
        {
          database: db,
          grant: {
            grantId: 'narrow',
            clientId: 'narrow',
            userId: ownerId,
            allTenants: false,
            tenantIds: [tenantId],
            capabilities: [...OperatorCapability.options],
          },
        },
      ),
    ).rejects.toBeInstanceOf(OperatorNotFoundError)
    expect(fetched.length).toBe(before)
  })

  it('4. customizes the look and the chatbot, and explains a stale version', async () => {
    const before = await call('appearance.get', { tenantId, venueId })
    const look = await call('appearance.propose_update', {
      operationId: randomUUID(),
      tenantId,
      venueId,
      expectedUpdatedAt: before.structuredContent.updatedAt,
      chatTheme: 'forest',
      chatAccentColor: '#1F6F5C',
      chatFont: 'poppins',
    })
    expect(look.isError, JSON.stringify(look.structuredContent)).toBe(false)
    expect(look.structuredContent).toMatchObject({ status: 'APPLIED' })
    const bot = await call('venues.propose_update', {
      operationId: randomUUID(),
      tenantId,
      venueId,
      aiGuideName: 'Marina',
      aiGuideNotes: 'Answer like a cheerful park host. Keep it short.',
      tonePreset: 'enthusiastic',
      responseDepth: 'DETAILED',
      greeting: 'Ahoy! Ask me anything about Ocean Grove.',
      publicDisplayName: 'Marina',
    })
    expect(bot.isError, JSON.stringify(bot.structuredContent)).toBe(false)
    expect(bot.structuredContent).toMatchObject({ status: 'APPLIED' })
    // The version read before the bot change is now stale: the write is refused and says why.
    const stale = await call('appearance.propose_update', {
      operationId: randomUUID(),
      tenantId,
      venueId,
      expectedUpdatedAt: before.structuredContent.updatedAt,
      chatTheme: 'sunset',
    })
    expect(stale.structuredContent.status ?? stale.structuredContent.error).toMatch(/STALE/u)
    // Without a version, the change applies to the venue as it is now: no read-modify loop.
    const titled = await call('appearance.propose_update', {
      operationId: randomUUID(),
      tenantId,
      venueId,
      title: 'Ocean Grove Guide',
    })
    expect(titled.isError, JSON.stringify(titled.structuredContent)).toBe(false)
    expect(titled.structuredContent).toMatchObject({ status: 'APPLIED' })
    const after = await call('appearance.get', { tenantId, venueId })
    expect(after.structuredContent).toMatchObject({
      title: 'Ocean Grove Guide',
      chatTheme: 'forest',
      chatAccentColor: '#1F6F5C',
      chatFont: 'poppins',
    })
  })

  it('5. publishes and returns the visitor link that opens this venue', async () => {
    const draftLink = await call('venues.get_guest_link', { tenantId, venueId })
    expect(draftLink.isError, JSON.stringify(draftLink.structuredContent)).toBe(false)
    expect(draftLink.structuredContent).toMatchObject({
      usable: false,
      publicUrl: `${GUEST_ORIGIN}/${slug}/chat`,
    })
    const publish = { operationId: randomUUID(), tenantId, venueId }
    const published = await call('venues.propose_publish', publish)
    expect(published.isError, JSON.stringify(published.structuredContent)).toBe(false)
    expect(published.structuredContent).toMatchObject({
      status: 'APPLIED',
      result: { isActive: true, publicUrl: `${GUEST_ORIGIN}/${slug}/chat` },
    })
    const republished = await call('venues.propose_publish', publish)
    expect(republished.structuredContent.proposalId).toBe(published.structuredContent.proposalId)
    const link = await call('venues.get_guest_link', { tenantId, venueId })
    expect(link.structuredContent).toMatchObject({
      venueId,
      slug,
      usable: true,
      publicUrl: `${GUEST_ORIGIN}/${slug}/chat`,
      blockers: [],
    })
    // The link's path resolves, through the public visitor lookup, to this venue and its look.
    const visitor = router({ venue: venueRouter }).createCaller({
      db,
      headers: new Headers(),
      session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
    } as TRPCContext)
    const pathSlug = decodeURIComponent(
      new URL(link.structuredContent.publicUrl).pathname.split('/')[1]!,
    )
    const resolved = await visitor.venue.getBySlug({ slug: pathSlug })
    expect(resolved).toMatchObject({
      id: venueId,
      chatTheme: 'forest',
      chatAccentColor: '#1F6F5C',
    })
    expect(resolved.id).not.toBe(otherVenueId)
  })

  it('answers a visitor from the imported content', async () => {
    const create = vi
      .fn()
      .mockImplementation(async (request: { system: Array<{ text: string }> }) => {
        const prompt = request.system.map((block) => block.text).join('')
        // A stand-in model that can only answer from what the guide was given.
        const text = prompt.includes(FACT)
          ? 'The Lantern Lagoon boat ride leaves every 20 minutes from Pier Seven.'
          : 'I do not have that information.'
        return {
          content: [{ type: 'text', text }],
          usage: {
            input_tokens: 10,
            output_tokens: 10,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        }
      })
    _setAnthropicClientForTesting({ messages: { create } } as unknown as AnthropicMessagesClient)
    const guest = router({ chat: chatRouter }).createCaller({
      db,
      headers: new Headers(),
      session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
    } as TRPCContext)
    const reply = await guest.chat.send({
      venueId,
      anonymousToken: randomUUID(),
      operationId: randomUUID(),
      message: 'When does the Lantern Lagoon boat ride leave?',
    })
    expect(create).toHaveBeenCalled()
    expect(JSON.stringify(reply)).toContain('Pier Seven')
  })
})
