/* eslint-disable @typescript-eslint/no-explicit-any -- test helper returns loosely typed parsed output */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  OPERATOR_MCP_OUTPUTS,
  OPERATOR_MCP_TOOLS,
  OperatorCapability,
  type OperatorReadToolName,
} from '@pathfinder/contracts/operator-mcp'
import { createVenueAction, db, withTenantIsolationBypass } from '@pathfinder/db'

import { resolveOperatorConfig } from '../config'
import { OperatorNotFoundError } from '../grants'
import type { VerifiedOperatorGrant } from '../oauth'
import { createOperatorRegistry, defaultVenueRead } from '../registry'
import { OperatorInvalidCursorError } from './page'

/**
 * Discovery, completeness and operation-recovery reads on a real disposable PostgreSQL. Invented
 * names and example domains only. Runs only against a database named pathfinder_disposable_*.
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
  OPERATOR_OAUTH_ALLOWED_USER_IDS: 'user_owner',
  RAILWAY_ENVIRONMENT: 'staging',
})
if (resolution.status !== 'ready') throw new Error('operator config not ready')
const config = resolution.config

const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
const tenantA = `dc-a-${suffix}`
const tenantB = `dc-b-${suffix}`
const clientId = `dc-client-${suffix}`
const grantId = `dc-grant-${suffix}`
const otherGrantId = `dc-other-grant-${suffix}`

function grant(
  overrides: Partial<{
    tenantIds: string[]
    allTenants: boolean
    capabilities: OperatorCapability[]
    grantId: string
  }> = {},
): VerifiedOperatorGrant {
  return {
    grantId: overrides.grantId ?? grantId,
    clientId,
    userId: 'user_owner',
    allTenants: overrides.allTenants ?? false,
    tenantIds: overrides.tenantIds ?? [tenantA],
    capabilities: overrides.capabilities ?? [...OperatorCapability.options],
  }
}

const registry = createOperatorRegistry()
async function call(
  name: OperatorReadToolName,
  args: Record<string, unknown>,
  operatorGrant = grant(),
) {
  const output = await registry.callTool(name, args, {
    config,
    database: db,
    grant: operatorGrant,
    now: new Date(),
    requestId: randomUUID(),
    venueRead: defaultVenueRead(db),
  })
  return OPERATOR_MCP_OUTPUTS[name].parse(output) as any
}

async function allPages(
  name: OperatorReadToolName,
  args: Record<string, unknown>,
  operatorGrant = grant(),
) {
  const items: any[] = []
  const sizes: number[] = []
  let cursor: string | undefined
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await call(name, { ...args, ...(cursor ? { cursor } : {}) }, operatorGrant)
    expect(page.complete).toBe(page.nextCursor === null)
    items.push(...page.items)
    sizes.push(page.items.length)
    if (page.nextCursor === null) return { items, sizes }
    cursor = page.nextCursor
  }
  throw new Error('pagination did not terminate')
}

describe.skipIf(!enabled)(
  'operator discovery and operation reads on disposable PostgreSQL',
  { timeout: 120_000 },
  () => {
    const aVenueIds: string[] = []
    let bVenueId = ''
    let campaignId = ''
    const memberIds: string[] = []
    const orgIds: string[] = []

    beforeAll(async () => {
      await db.operatorOAuthClient.create({
        data: {
          id: clientId,
          clientName: 'Example connector',
          redirectUris: ['https://connector.example.com/callback'],
          registrationIpHash: 'a'.repeat(64),
        },
      })
      for (const id of [grantId, otherGrantId]) {
        await db.operatorGrant.create({
          data: {
            id,
            clientId,
            userId: 'user_owner',
            allTenants: false,
            tenantIds: [tenantA],
            capabilities: [...OperatorCapability.options],
            resource: config.resource,
            scope: 'operator',
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        })
      }
      await withTenantIsolationBypass(async () => {
        for (const [id, name] of [
          [tenantA, `Example Alpha ${suffix}`],
          [tenantB, `Example Beta ${suffix}`],
        ] as const) {
          await db.tenant.create({ data: { id, name, slug: id } })
        }
        // 30 venues in tenant A forces a second page; one venue in tenant B is out of scope.
        for (let index = 0; index < 30; index += 1) {
          aVenueIds.push(
            (
              await createVenueAction({
                tenantId: tenantA,
                actor: { type: 'HUMAN', id: 'user_owner', role: 'OWNER' },
                name: `Example Garden ${index}`,
                baseSlug: `dc-garden-${suffix}-${index}`,
                callerSuppliedSlug: true,
                guideMode: 'non_location',
              })
            ).record.id,
          )
        }
        bVenueId = (
          await createVenueAction({
            tenantId: tenantB,
            actor: { type: 'HUMAN', id: 'user_owner', role: 'OWNER' },
            name: 'Example Hall',
            baseSlug: `dc-hall-${suffix}`,
            callerSuppliedSlug: true,
            guideMode: 'non_location',
          })
        ).record.id
        // 30 support requests with an identical updatedAt: equal timestamps must not skip or repeat.
        const tie = new Date('2026-09-01T12:00:00.000Z')
        for (let index = 0; index < 30; index += 1) {
          await db.supportRequest.create({
            data: {
              tenantId: tenantA,
              venueId: aVenueIds[0]!,
              category: 'CONTENT_CORRECTION',
              subject: `Tie request ${index}`,
              createdByKind: 'OPERATOR',
              createdById: clientId,
              updatedByKind: 'OPERATOR',
              updatedById: clientId,
              updatedAt: tie,
            },
          })
        }
      })

      campaignId = (
        await db.prospectOutreachCampaign.create({
          data: {
            name: `Example campaign ${suffix}`,
            cohortSnapshot: {},
            playbookVersion: 'example',
            createdBy: 'seed',
            updatedBy: 'seed',
          },
        })
      ).id
      for (let index = 0; index < 3; index += 1) {
        const org = await db.prospectOrganization.create({
          data: {
            canonicalName: `Example Org ${index} ${suffix}`,
            normalizedName: `example org ${index} ${suffix}`,
            createdBy: 'seed',
            updatedBy: 'seed',
            opportunity: { create: { stage: 'RESEARCHED', createdBy: 'seed', updatedBy: 'seed' } },
          },
        })
        orgIds.push(org.id)
        memberIds.push(
          (await db.prospectCampaignMember.create({ data: { campaignId, organizationId: org.id } }))
            .id,
        )
      }
    })

    afterAll(async () => {
      await withTenantIsolationBypass(() =>
        db.embeddingDispatch.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } }),
      )
      await db.$disconnect()
    })

    it('operator.get_context lists every declared tool and reports scope truthfully', async () => {
      const limited = await call(
        'operator.get_context',
        {},
        grant({ capabilities: ['operator:read'] }),
      )
      expect(limited.tools).toHaveLength(OPERATOR_MCP_TOOLS.length)
      const byName = new Map<string, any>(limited.tools.map((tool: any) => [tool.name, tool]))
      // Declared but unbuilt tools are shown as such rather than hidden.
      for (const name of [
        'crm.propose_campaign_membership',
        'venues.propose_source',
        'customers.propose_invite',
        'support.propose_triage',
      ]) {
        expect(byName.get(name)?.implemented, name).toBe(false)
        expect(byName.get(name)?.approvalMode, name).toBeNull()
      }
      expect(byName.get('operator.get_context')).toMatchObject({
        implemented: true,
        authorized: true,
      })
      expect(byName.get('crm.get_organization')).toMatchObject({
        implemented: true,
        authorized: false,
      })
      expect(byName.get('crm.propose_stage_change')).toMatchObject({
        implemented: true,
        authorized: false,
        approvalMode: 'ask',
      })
      expect(limited.grant.tenantIds).toEqual([tenantA])
      expect(limited.scopeNotes.join(' ')).toMatch(/platform-wide CRM/u)
      expect(limited.scopeNotes.join(' ')).toMatch(/lacks capabilities/u)
      // Unmeasured health is null, never a guess.
      for (const tool of limited.tools) {
        expect(tool.providerConnected).toBeNull()
        expect(tool.workerAvailable).toBeNull()
      }
    })

    it('customers.list shows a limited grant only its tenants and refuses a foreign cursor', async () => {
      const mine = await allPages('customers.list', {})
      expect(mine.items.map((item) => item.tenantId)).toEqual([tenantA])
      expect(mine.items[0].venueCount).toBe(30)
      // Tenant B's id is a real row outside the grant: it must not work as a cursor oracle.
      await expect(call('customers.list', { cursor: tenantB })).rejects.toBeInstanceOf(
        OperatorInvalidCursorError,
      )
      await expect(call('customers.list', { query: 'beta' })).resolves.toMatchObject({
        items: [],
        complete: true,
      })
      const everything = await allPages(
        'customers.list',
        { query: suffix },
        grant({ allTenants: true }),
      )
      expect(everything.items.map((item) => item.tenantId).sort()).toEqual(
        [tenantA, tenantB].sort(),
      )
      const stepped = await allPages(
        'customers.list',
        { query: suffix, limit: 1 },
        grant({ allTenants: true }),
      )
      expect(stepped.sizes).toEqual([1, 1])
    })

    it('venues.list is complete across the old 25 and 100 boundaries and keeps cursors in scope', async () => {
      const pages = await allPages('venues.list', { tenantId: tenantA })
      expect(pages.sizes).toEqual([25, 5])
      expect(new Set(pages.items.map((item) => item.venueId)).size).toBe(30)
      await expect(
        call('venues.list', { tenantId: tenantA, cursor: bVenueId }),
      ).rejects.toBeInstanceOf(OperatorInvalidCursorError)
      await expect(call('venues.list', { tenantId: tenantB })).rejects.toBeInstanceOf(
        OperatorNotFoundError,
      )
    })

    it('support.list pages through equal timestamps without skipping or repeating', async () => {
      const pages = await allPages('support.list', { tenantId: tenantA })
      expect(pages.sizes).toEqual([25, 5])
      expect(new Set(pages.items.map((item) => item.requestId)).size).toBe(30)
      for (const item of pages.items) expect(item.priority).toBeNull()
      await expect(
        call('support.list', { tenantId: tenantA, cursor: 'not-a-keyset' }),
      ).rejects.toBeInstanceOf(OperatorInvalidCursorError)
    })

    it('crm campaign discovery returns the ids draft proposals need', async () => {
      const campaigns = await allPages('crm.list_campaigns', {})
      const mine = campaigns.items.find((item) => item.campaignId === campaignId)
      expect(mine).toMatchObject({ memberCount: 3, status: 'DRAFT' })
      const members = await allPages('crm.list_campaign_members', { campaignId, limit: 2 })
      expect(members.sizes).toEqual([2, 1])
      expect(members.items.map((item) => item.campaignMemberId).sort()).toEqual(
        [...memberIds].sort(),
      )
      const one = await call('crm.list_campaign_members', { campaignId, organizationId: orgIds[1] })
      expect(one.items).toHaveLength(1)
      expect(one.items[0].organizationName).toContain('Example Org 1')
      await expect(
        call('crm.list_campaign_members', { campaignId: 'missing' }),
      ).rejects.toBeInstanceOf(OperatorNotFoundError)
      // A member id is not a valid cursor for a different campaign's listing.
      const otherCampaign = (
        await db.prospectOutreachCampaign.create({
          data: {
            name: `Second ${suffix}`,
            cohortSnapshot: {},
            playbookVersion: 'example',
            createdBy: 'seed',
            updatedBy: 'seed',
          },
        })
      ).id
      await expect(
        call('crm.list_campaign_members', { campaignId: otherCampaign, cursor: memberIds[0] }),
      ).rejects.toBeInstanceOf(OperatorInvalidCursorError)
    })

    it('operator.get_operation recovers a past write from its operationId and hides other grants', async () => {
      const operationId = randomUUID()
      const written = await registry.callTool(
        'crm.propose_stage_change',
        { organizationId: orgIds[0], expectedVersion: 1, stage: 'RESEARCHED', operationId },
        {
          config,
          database: db,
          grant: grant(),
          now: new Date(),
          requestId: randomUUID(),
          venueRead: defaultVenueRead(db),
        },
      )
      const found = await call('operator.get_operation', { originalOperationId: operationId })
      expect(found).toMatchObject({
        proposalId: (written as any).proposalId,
        operationId,
        status: 'PENDING',
        effect: 'none',
      })
      await expect(
        call(
          'operator.get_operation',
          { originalOperationId: operationId },
          grant({ grantId: otherGrantId }),
        ),
      ).rejects.toBeInstanceOf(OperatorNotFoundError)
      await expect(
        call('operator.get_operation', { originalOperationId: randomUUID() }),
      ).rejects.toBeInstanceOf(OperatorNotFoundError)
    })

    it('reports partial and unknown effects from recorded step state, not from plan status', async () => {
      const expiresAt = new Date(Date.now() + 86_400_000)
      const step = (index: number, status: string, extra: Record<string, unknown> = {}) => ({
        grantId,
        clientId,
        operationId: randomUUID(),
        kind: 'crm.stage-change',
        tool: 'crm.propose_stage_change',
        capability: 'crm:propose',
        args: {},
        argsHash: 'b'.repeat(64),
        status: status as never,
        planStepIndex: index,
        expiresAt,
        ...extra,
      })
      const planOperationId = randomUUID()
      const plan = await db.operatorPlan.create({
        data: {
          grantId,
          clientId,
          operationId: planOperationId,
          title: 'Example plan',
          argsHash: 'c'.repeat(64),
          status: 'FAILED',
          failedStepIndex: 1,
          expiresAt,
        },
      })
      await db.operatorProposal.createMany({
        data: [
          step(0, 'APPLIED', {
            planId: plan.id,
            applyClaimedAt: new Date(),
            appliedAt: new Date(),
          }),
          step(1, 'FAILED', {
            planId: plan.id,
            applyClaimedAt: new Date(),
            failureCode: 'APPLY_FAILED',
          }),
          step(2, 'REJECTED', { planId: plan.id, failureCode: 'PLAN_STOPPED' }),
        ],
      })
      const view = await call('operator.get_operation', { originalOperationId: planOperationId })
      expect(view).toMatchObject({ status: 'FAILED', effect: 'partial', kind: 'operator.plan' })
      expect(
        (await call('operator.list_plans', {})).items.map((item: any) => item.proposalId),
      ).toContain(plan.id)
      const failedStep = await db.operatorProposal.findFirstOrThrow({
        where: { planId: plan.id, planStepIndex: 1 },
      })
      const stepView = await call('operator.get_proposal', { proposalId: failedStep.id })
      // A failed apply that began is unknown until the target is read; it is never "did not happen".
      expect(stepView).toMatchObject({
        status: 'FAILED',
        effect: 'unknown',
        failureCode: 'APPLY_FAILED',
      })
      const stopped = await db.operatorProposal.findFirstOrThrow({
        where: { planId: plan.id, planStepIndex: 2 },
      })
      expect(await call('operator.get_proposal', { proposalId: stopped.id })).toMatchObject({
        effect: 'none',
      })
    })

    it('check_can_contact finds a suppression beyond 1,000 archived aliases', async () => {
      const address = `alias-${suffix}@example.com`
      const org = await db.prospectOrganization.create({
        data: {
          canonicalName: `Alias Org ${suffix}`,
          normalizedName: `alias org ${suffix}`,
          createdBy: 'seed',
          updatedBy: 'seed',
        },
      })
      const archivedAt = new Date()
      await db.prospectContact.createMany({
        data: Array.from({ length: 1_050 }, (_, index) => ({
          organizationId: org.id,
          fullName: `Alias ${index}`,
          email: address,
          normalizedEmail: address,
          archivedAt,
          createdBy: 'seed',
          updatedBy: 'seed',
        })),
      })
      // The only blocked row sorts last (archived, id after every generated id).
      await db.prospectContact.create({
        data: {
          id: `zz-blocked-${suffix}`,
          organizationId: org.id,
          fullName: 'Blocked alias',
          email: address,
          normalizedEmail: address,
          archivedAt,
          suppressedAt: new Date(),
          createdBy: 'seed',
          updatedBy: 'seed',
        },
      })
      const answer = await call('crm.check_can_contact', { email: address })
      expect(answer).toMatchObject({ allowed: false, reason: 'suppressed' })
    })
  },
)
