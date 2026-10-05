import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/venue-package-semantic-analysis', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../lib/venue-package-semantic-analysis')>()
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

import { OperatorCapability } from '@pathfinder/contracts/operator-mcp'
import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { resolveOperatorConfig } from '../config'
import type { VerifiedOperatorGrant } from '../oauth'
import { createKindRegistry, createProposal } from '../proposals'
import { setCustomerProviderForTests, type CustomerProvider } from './customers'
import { OPERATOR_PROPOSAL_KINDS } from './index'

/**
 * The default deployment (no approvals) on a real disposable PostgreSQL: the MCP creates a client
 * with its draft venue, changes the venue and its personality, and imports a venue package, each
 * applied in the same call. A fake identity provider; invented names only.
 */
const enabled =
  process.env.RUN_OPERATOR_DB_INTEGRATION === '1' &&
  /^postgres(?:ql)?:\/\/[^/]+\/pathfinder_disposable_[a-z0-9_]+(?:\?|$)/u.test(
    process.env.DATABASE_URL ?? '',
  )

const resolution = resolveOperatorConfig({
  OPERATOR_OAUTH_ENABLED: true,
  OPERATOR_OAUTH_ISSUER: 'https://app.operator.test',
  OPERATOR_OAUTH_PEPPERS: `k1:${randomBytes(32).toString('base64url')}`,
  OPERATOR_OAUTH_REDIRECT_ORIGINS: 'https://connector.example.com',
  OPERATOR_OAUTH_ALLOWED_USER_IDS: 'user_noapproval_owner',
  RAILWAY_ENVIRONMENT: 'staging',
})
if (resolution.status !== 'ready') throw new Error('operator config not ready')
const config = resolution.config
const kinds = createKindRegistry(OPERATOR_PROPOSAL_KINDS)

const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
const adminId = 'user_noapproval_owner'
const clientId = `opc_noappr_${suffix}`
const createdOrganizations: string[] = []
let grant: VerifiedOperatorGrant

/** Like the real provider: the organization.created webhook lands the bare tenant first. */
const fakeProvider: CustomerProvider = {
  createOrganization: (async (input: { name: string; slug: string }) => {
    const id = `org_${randomUUID().replaceAll('-', '').slice(0, 20)}`
    createdOrganizations.push(id)
    await withTenantIsolationBypass(() =>
      db.tenant.upsert({
        where: { id },
        create: { id, name: input.name, slug: 'example-provider-generated' },
        update: { name: input.name },
      }),
    )
    return { id, name: input.name, slug: 'example-provider-generated' }
  }) as never,
  validateOwner: (async (input: {
    organizationId: string
    userId: string
    emailAddress: string
  }) => ({
    organizationId: input.organizationId,
    organizationName: 'Example',
    organizationSlug: 'example-provider-generated',
    userId: input.userId,
    emailAddress: input.emailAddress,
  })) as never,
  ensureInvitation: (async () => ({ id: 'inv_1', replayed: false })) as never,
  listPendingInvitations: (async () => []) as never,
  findOrganizations: (async () => ({ candidates: [], complete: true })) as never,
}

const propose = (tool: string, args: Record<string, unknown>) =>
  createProposal(
    tool,
    { ...args, operationId: randomUUID() },
    { config, database: db, grant, kinds, now: new Date(), requestId: randomUUID() },
  )

describe.skipIf(!enabled)(
  'operator with no approvals on disposable PostgreSQL',
  { timeout: 120_000 },
  () => {
    let tenantId = ''
    let venueId = ''

    beforeAll(async () => {
      setCustomerProviderForTests(fakeProvider)
      await db.user.upsert({
        where: { id: adminId },
        create: { id: adminId, email: `admin-${suffix}@example.test` },
        update: { email: `admin-${suffix}@example.test` },
      })
      await db.operatorOAuthClient.create({
        data: {
          id: clientId,
          clientName: 'Example connector',
          redirectUris: ['https://connector.example.com/cb'],
          registrationIpHash: 'a'.repeat(64),
          consentedAt: new Date(),
        },
      })
      const row = await db.operatorGrant.create({
        data: {
          clientId,
          userId: adminId,
          allTenants: true,
          tenantIds: [],
          capabilities: [...OperatorCapability.options],
          resource: config.resource,
          scope: 'operator',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      })
      grant = {
        grantId: row.id,
        clientId,
        userId: adminId,
        allTenants: true,
        tenantIds: [],
        capabilities: [...OperatorCapability.options],
      }
      // Even an old stored Ask-first row no longer holds anything back.
      await db.operatorAutonomyPolicy.upsert({
        where: { capability: 'venues:propose' },
        create: { capability: 'venues:propose', mode: 'ASK', updatedByUserId: adminId },
        update: { mode: 'ASK', allowedKinds: [] },
      })
    })

    beforeEach(() => {
      delete process.env.OPERATOR_APPROVAL_MODE
      process.env.OPERATOR_CUSTOMER_CREATE_ENABLED = 'true'
    })

    afterAll(async () => {
      process.env.OPERATOR_APPROVAL_MODE = 'review'
      delete process.env.OPERATOR_CUSTOMER_CREATE_ENABLED
      setCustomerProviderForTests(null)
      await db.operatorAutonomyPolicy.deleteMany({ where: { capability: 'venues:propose' } })
      await withTenantIsolationBypass(() =>
        db.embeddingDispatch.deleteMany({ where: { tenantId: { in: createdOrganizations } } }),
      )
      await db.$disconnect()
    })

    it('creates the client and its draft venue in one call, even when the webhook got there first', async () => {
      const view = await propose('customers.propose_create', {
        organizationName: `Example Museum ${suffix}`,
        venueName: 'Example Main Hall',
        city: 'Exampleville',
      })
      expect(view.status).toBe('APPLIED')
      expect(view.result).toMatchObject({ draft: true, invited: false })
      tenantId = (view.result as { tenantId: string }).tenantId
      venueId = (view.result as { venueId: string }).venueId
      const venue = await withTenantIsolationBypass(() =>
        db.venue.findFirst({ where: { id: venueId, tenantId }, select: { isActive: true } }),
      )
      expect(venue).toEqual({ isActive: false })
      const owner = await db.tenantMembership.findUnique({
        where: { tenantId, tenantId_userId: { tenantId, userId: adminId } },
        select: { role: true, status: true },
      })
      expect(owner).toEqual({ role: 'OWNER', status: 'ACTIVE' })
    })

    it('changes venue details, AI tone and notes, greeting, depth and banner in one call', async () => {
      const view = await propose('venues.propose_update', {
        tenantId,
        venueId,
        name: 'Example Main Hall and Garden',
        description: 'A small example museum.',
        aiGuideName: 'Ada',
        aiGuideNotes: 'Speak like a warm, curious docent.',
        tonePreset: 'enthusiastic',
        responseDepth: 'DETAILED',
        greeting: 'Welcome! Ask me anything about the hall.',
        chatBannerUrl: 'https://images.example.com/hall.jpg',
      })
      expect(view.status).toBe('APPLIED')
      const venue = await withTenantIsolationBypass(() =>
        db.venue.findFirst({
          where: { id: venueId, tenantId },
          select: {
            name: true,
            aiGuideName: true,
            aiGuideNotes: true,
            tonePreset: true,
            chatBannerUrl: true,
          },
        }),
      )
      expect(venue).toEqual({
        name: 'Example Main Hall and Garden',
        aiGuideName: 'Ada',
        aiGuideNotes: 'Speak like a warm, curious docent.',
        tonePreset: 'enthusiastic',
        chatBannerUrl: 'https://images.example.com/hall.jpg',
      })
      const bot = await withTenantIsolationBypass(() =>
        db.venueBotConfiguration.findFirst({
          where: { tenantId, venueId },
          select: { tonePreset: true, responseDepth: true, greeting: true },
        }),
      )
      expect(bot).toEqual({
        tonePreset: 'enthusiastic',
        responseDepth: 'DETAILED',
        greeting: 'Welcome! Ask me anything about the hall.',
      })
    })

    it('imports the dashboard venue-package JSON and applies it in one call', async () => {
      const view = await propose('venues.propose_package_import', {
        tenantId,
        venueId,
        payload: {
          schemaVersion: 1,
          places: [],
          knowledgeEntries: [
            {
              title: 'Hours',
              category: 'Visiting',
              content: 'Open 10 AM to 5 PM, Tuesday to Sunday.',
              isEnabled: true,
            },
            {
              title: 'Accessibility',
              category: 'Accessibility',
              content: 'Step-free entrance at the north door.',
              isEnabled: true,
            },
          ],
        },
      })
      expect(view.status).toBe('APPLIED')
      expect(view.result).toMatchObject({ status: 'APPLIED' })
      const titles = await withTenantIsolationBypass(() =>
        db.venueKnowledgeEntry.findMany({
          where: { tenantId, venueId },
          select: { title: true },
          orderBy: { title: 'asc' },
        }),
      )
      expect(titles.map((row) => row.title)).toEqual(['Accessibility', 'Hours'])
    })

    it('refuses an invalid package before recording anything', async () => {
      const before = await db.venuePackage.count({ where: { tenantId, venueId } })
      await expect(
        propose('venues.propose_package_import', {
          tenantId,
          venueId,
          payload: { schemaVersion: 1, places: [], knowledgeEntries: [] },
        }),
      ).rejects.toThrow(/at least one guide item or knowledge entry/u)
      expect(await db.venuePackage.count({ where: { tenantId, venueId } })).toBe(before)
    })
  },
)
