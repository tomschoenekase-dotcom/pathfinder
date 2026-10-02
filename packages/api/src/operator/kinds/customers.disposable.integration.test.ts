/* eslint-disable @typescript-eslint/no-explicit-any -- test helper returns loosely typed parsed output */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { OperatorCapability } from '@pathfinder/contracts/operator-mcp'
import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { resolveAutonomy } from '../autonomy'
import { resolveOperatorConfig } from '../config'
import { OperatorNotFoundError } from '../grants'
import type { VerifiedOperatorGrant } from '../oauth'
import { approveAndApplyProposal, createKindRegistry, createProposal } from '../proposals'
import { setCustomerProviderForTests, type CustomerProvider } from './customers'
import { OPERATOR_PROPOSAL_KINDS } from './index'

/**
 * Customer creation and invitation on a real disposable PostgreSQL with a fake identity provider.
 * Nothing here reaches a real provider or sends anything. Invented names only.
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
  OPERATOR_OAUTH_ALLOWED_USER_IDS: 'user_cust_owner',
  RAILWAY_ENVIRONMENT: 'staging',
})
if (resolution.status !== 'ready') throw new Error('operator config not ready')
const config = resolution.config
const kinds = createKindRegistry(OPERATOR_PROPOSAL_KINDS)
const dependencies = { database: db, kinds, allowedUserIds: config.allowedUserIds }

const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
const adminId = 'user_cust_owner'
const clientId = `opc_cust_${suffix}`
let allGrant: VerifiedOperatorGrant
let narrowGrant: VerifiedOperatorGrant
let invitedTenantId = ''

const created: string[] = []
const invitations: { organizationId: string; emailAddress: string; role: string }[] = []
const createOrganizationMock = vi.fn(async (input: { name: string; slug: string }) => {
  const id = `org_${randomUUID().replaceAll('-', '').slice(0, 20)}`
  created.push(id)
  return { id, name: input.name, slug: input.slug }
})
const fakeProvider: CustomerProvider = {
  createOrganization: createOrganizationMock as never,
  validateOwner: (async (input: {
    organizationId: string
    userId: string
    emailAddress: string
  }) => ({
    organizationId: input.organizationId,
    organizationName: 'Example',
    organizationSlug: 'example',
    userId: input.userId,
    emailAddress: input.emailAddress,
  })) as never,
  ensureInvitation: (async (input: {
    organizationId: string
    emailAddress: string
    role: string
  }) => {
    const existing = invitations.find(
      (item) =>
        item.organizationId === input.organizationId &&
        item.emailAddress === input.emailAddress.toLowerCase(),
    )
    if (existing) return { id: 'inv_existing', replayed: true }
    invitations.push({
      organizationId: input.organizationId,
      emailAddress: input.emailAddress.toLowerCase(),
      role: input.role,
    })
    return { id: `inv_${invitations.length}`, replayed: false }
  }) as never,
  listPendingInvitations: (async (organizationId: string) =>
    invitations
      .filter((item) => item.organizationId === organizationId)
      .map((item, index) => ({ id: `inv_${index}`, ...item }))) as never,
}

const service = (forGrant: VerifiedOperatorGrant) => ({
  config,
  database: db,
  grant: forGrant,
  kinds,
  now: new Date(),
  requestId: randomUUID(),
})
const propose = (tool: string, args: Record<string, unknown>, forGrant = allGrant) =>
  createProposal(tool, { ...args, operationId: randomUUID() }, service(forGrant))
const approve = (view: { proposalId: string; argsHash: string }) =>
  approveAndApplyProposal(
    {
      proposalId: view.proposalId,
      argsHash: view.argsHash,
      actorUserId: adminId,
      requestId: randomUUID(),
      now: new Date(),
    },
    dependencies,
  )

describe.skipIf(!enabled)(
  'operator customer provisioning on disposable PostgreSQL',
  { timeout: 120_000 },
  () => {
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
      const make = async (all: boolean, tenants: string[]) => {
        const row = await db.operatorGrant.create({
          data: {
            clientId,
            userId: adminId,
            allTenants: all,
            tenantIds: tenants,
            capabilities: [...OperatorCapability.options],
            resource: config.resource,
            scope: 'operator',
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        })
        return {
          grantId: row.id,
          clientId,
          userId: adminId,
          allTenants: all,
          tenantIds: tenants,
          capabilities: [...OperatorCapability.options],
        } satisfies VerifiedOperatorGrant
      }
      allGrant = await make(true, [])
      narrowGrant = await make(false, [`nobody-${suffix}`])
    })

    afterEach(() => {
      delete process.env.OPERATOR_CUSTOMER_CREATE_ENABLED
      delete process.env.OPERATOR_CUSTOMER_INVITE_ENABLED
    })

    afterAll(async () => {
      setCustomerProviderForTests(null)
      await withTenantIsolationBypass(() =>
        db.embeddingDispatch.deleteMany({ where: { tenantId: { in: created } } }),
      )
      await db.$disconnect()
    })

    const createArgs = (name: string) => ({
      organizationName: `Example ${name} ${suffix}`,
      venueName: `Example ${name} Garden`,
      city: 'Exampleville',
    })

    it('refuses to propose while the deployment switch is off, and for a narrow connection', async () => {
      await expect(propose('customers.propose_create', createArgs('Off'))).rejects.toMatchObject({
        code: 'DISABLED',
      })
      process.env.OPERATOR_CUSTOMER_CREATE_ENABLED = 'true'
      await expect(
        propose('customers.propose_create', createArgs('Narrow'), narrowGrant),
      ).rejects.toBeInstanceOf(OperatorNotFoundError)
      expect(createOrganizationMock).not.toHaveBeenCalled()
    })

    it('always asks, even under a named AUTO policy', async () => {
      expect(
        await resolveAutonomy({ kind: 'customers.create', capability: 'customers:propose' }, {
          operatorAutonomyPolicy: {
            findUnique: async () => ({ mode: 'AUTO', allowedKinds: ['customers.create'] }),
          },
        } as never),
      ).toBe('ask')
    })

    it('creates the customer once with a draft venue, links the CRM account, and invites nobody', async () => {
      process.env.OPERATOR_CUSTOMER_CREATE_ENABLED = 'true'
      const org = await db.prospectOrganization.create({
        data: {
          canonicalName: `Example CRM ${suffix}`,
          normalizedName: `example crm ${suffix}`,
          createdBy: 'seed',
          updatedBy: 'seed',
        },
      })
      const view = await propose('customers.propose_create', {
        ...createArgs('Fresh'),
        prospectOrganizationId: org.id,
      })
      expect(view.status).toBe('PENDING')
      expect(createOrganizationMock).not.toHaveBeenCalled()

      const first = await approve(view)
      expect(first.status).toBe('APPLIED')
      const second = await approve(view)
      expect(second.status).toBe('APPLIED')
      expect(createOrganizationMock).toHaveBeenCalledTimes(1)
      expect(invitations).toHaveLength(0)

      const result = (
        await db.operatorProposal.findFirstOrThrow({ where: { id: view.proposalId } })
      ).result as any
      expect(result).toMatchObject({ draft: true, invited: false, isActive: false })
      invitedTenantId = result.tenantId
      await withTenantIsolationBypass(async () => {
        const venue = await db.venue.findFirstOrThrow({
          where: { id: result.venueId, tenantId: result.tenantId },
        })
        expect(venue.isActive).toBe(false)
        const members = await db.tenantMembership.findMany({ where: { tenantId: result.tenantId } })
        expect(members).toHaveLength(1)
        expect(members[0]).toMatchObject({ userId: adminId, role: 'OWNER', status: 'ACTIVE' })
      })
      const relationship = await withTenantIsolationBypass(() =>
        db.prospectCustomerRelationship.findFirstOrThrow({
          where: { organizationId: org.id, tenantId: result.tenantId },
        }),
      )
      expect(relationship.status).toBe('ACTIVE')
    })

    it('settles an interrupted create from its intent: unknown after the provider call, applied after completion', async () => {
      process.env.OPERATOR_CUSTOMER_CREATE_ENABLED = 'true'
      createOrganizationMock.mockRejectedValueOnce(new Error('provider unreachable'))
      const view = await propose('customers.propose_create', createArgs('Interrupted'))
      const failed = await approve(view)
      expect(failed.status).not.toBe('APPLIED')
      // The provider outcome is unconfirmed, so a retry must not call it a second time.
      const callsBefore = createOrganizationMock.mock.calls.length
      const retried = await approve(view)
      expect(retried.status).not.toBe('APPLIED')
      expect(createOrganizationMock.mock.calls.length).toBe(callsBefore)
    })

    it('invites only when its own switch is on, replays safely, and stays inside the grant', async () => {
      expect(invitedTenantId).not.toBe('')
      await expect(
        propose('customers.propose_invite', {
          tenantId: invitedTenantId,
          email: 'person@example.test',
          role: 'ADMIN',
        }),
      ).rejects.toMatchObject({ code: 'DISABLED' })

      process.env.OPERATOR_CUSTOMER_INVITE_ENABLED = 'true'
      await expect(
        propose(
          'customers.propose_invite',
          { tenantId: invitedTenantId, email: 'person@example.test', role: 'ADMIN' },
          narrowGrant,
        ),
      ).rejects.toBeInstanceOf(OperatorNotFoundError)
      expect(invitations).toHaveLength(0)

      const view = await propose('customers.propose_invite', {
        tenantId: invitedTenantId,
        email: 'Person@Example.test',
        role: 'ADMIN',
      })
      expect(view.status).toBe('PENDING')
      expect(invitations).toHaveLength(0)
      expect((await approve(view)).status).toBe('APPLIED')
      expect((await approve(view)).status).toBe('APPLIED')
      expect(invitations).toEqual([
        { organizationId: invitedTenantId, emailAddress: 'person@example.test', role: 'org:admin' },
      ])
      await withTenantIsolationBypass(async () => {
        expect(
          await db.onboardingMilestoneEvent.count({
            where: { tenantId: invitedTenantId, eventType: 'INVITATION_STARTED' },
          }),
        ).toBe(1)
      })
    })
  },
)
