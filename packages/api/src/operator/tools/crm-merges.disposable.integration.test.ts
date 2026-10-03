import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { OPERATOR_MCP_OUTPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  createProspectAction,
  db,
  mergeProspectOrganizationsAction,
  previewProspectOrganizationMergeAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { OperatorCapability } from '@pathfinder/contracts/operator-mcp'

import { resolveOperatorConfig } from '../config'
import { decideRequest, requestDecision } from '../decisions'
import { OPERATOR_PROPOSAL_KINDS } from '../kinds'
import { createKindRegistry, createProposal } from '../proposals'
import { createOperatorRegistry, defaultVenueRead } from '../registry'

const enabled =
  process.env.RUN_OPERATOR_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('CRM merge canonical readback', () => {
  afterAll(async () => db.$disconnect())

  it('redirects an archived source ID and reveals retained immutable activity lineage', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const actor = {
        type: 'HUMAN' as const,
        id: `merge-owner-${suffix}`,
        role: 'PLATFORM_ADMIN' as const,
      }
      const source = await createProspectAction({
        organization: { canonicalName: `Example North ${suffix}` },
        actor,
      })
      const target = await createProspectAction({
        organization: { canonicalName: `Example Parent ${suffix}` },
        actor,
      })
      await db.prospectActivity.create({
        data: {
          organizationId: source.organization.id,
          type: 'NOTE_ADDED',
          summary: 'Historical source note',
          actorId: actor.id,
        },
      })
      const plan = await previewProspectOrganizationMergeAction({
        sourceOrganizationId: source.organization.id,
        targetOrganizationId: target.organization.id,
      })
      expect(plan.blockers).toEqual([])
      await mergeProspectOrganizationsAction({
        sourceOrganizationId: source.organization.id,
        targetOrganizationId: target.organization.id,
        expectedPlanHash: plan.planHash,
        note: 'Reviewed same account',
        actor,
      })

      const resolved = resolveOperatorConfig({
        OPERATOR_OAUTH_ENABLED: true,
        OPERATOR_OAUTH_ISSUER: 'https://app.operator.test',
        OPERATOR_OAUTH_PEPPERS: 'k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        OPERATOR_OAUTH_REDIRECT_ORIGINS: 'https://connector.example.com',
        OPERATOR_OAUTH_ALLOWED_USER_IDS: actor.id,
        RAILWAY_ENVIRONMENT: 'staging',
      })
      if (resolved.status !== 'ready') throw new Error('operator config not ready')
      const output = await createOperatorRegistry().callTool(
        'crm.get_account_context',
        { organizationId: source.organization.id },
        {
          config: resolved.config,
          database: db,
          grant: {
            grantId: `grant-${suffix}`,
            clientId: 'client-example',
            userId: actor.id,
            allTenants: true,
            tenantIds: [],
            capabilities: ['crm:read'],
          },
          now: new Date(),
          requestId: randomUUID(),
          venueRead: defaultVenueRead(db),
        },
      )
      const account = OPERATOR_MCP_OUTPUTS['crm.get_account_context'].parse(output)
      expect(account.organization.organizationId).toBe(target.organization.id)
      expect(account.mergeLineage).toMatchObject({
        redirectedFromOrganizationId: source.organization.id,
        sources: [
          {
            sourceOrganizationId: source.organization.id,
            retainedActivities: expect.any(Number),
            retainedEvidence: expect.any(Number),
          },
        ],
        truncated: false,
      })
      expect(account.mergeLineage.sources[0]!.retainedActivities).toBeGreaterThanOrEqual(1)
    })
  })

  it('waits for a person under the routine CRM default, then applies once on an allowlisted decision', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const owner = `merge-decider-${suffix}`
      const actor = { type: 'HUMAN' as const, id: owner, role: 'PLATFORM_ADMIN' as const }
      const resolved = resolveOperatorConfig({
        OPERATOR_OAUTH_ENABLED: true,
        OPERATOR_OAUTH_ISSUER: 'https://app.operator.test',
        OPERATOR_OAUTH_PEPPERS: 'k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        OPERATOR_OAUTH_REDIRECT_ORIGINS: 'https://connector.example.com',
        OPERATOR_OAUTH_ALLOWED_USER_IDS: owner,
        RAILWAY_ENVIRONMENT: 'staging',
      })
      if (resolved.status !== 'ready') throw new Error('operator config not ready')
      const config = resolved.config
      const clientId = `opc_merge_${suffix}`
      await db.operatorOAuthClient.create({
        data: {
          id: clientId,
          clientName: 'Example connector',
          redirectUris: ['https://connector.example.com/cb'],
          registrationIpHash: 'b'.repeat(64),
          consentedAt: new Date(),
        },
      })
      const grantRow = await db.operatorGrant.create({
        data: {
          clientId,
          userId: owner,
          allTenants: true,
          tenantIds: [],
          capabilities: [...OperatorCapability.options],
          resource: config.resource,
          scope: 'operator',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      })
      const grant = {
        grantId: grantRow.id,
        clientId,
        userId: owner,
        allTenants: true,
        tenantIds: [],
        capabilities: [...OperatorCapability.options],
      }
      const kinds = createKindRegistry(OPERATOR_PROPOSAL_KINDS)
      const source = await createProspectAction({
        organization: { canonicalName: `Example Merge North ${suffix}` },
        actor,
      })
      const target = await createProspectAction({
        organization: { canonicalName: `Example Merge ${suffix}` },
        actor,
      })
      const plan = await previewProspectOrganizationMergeAction({
        sourceOrganizationId: source.organization.id,
        targetOrganizationId: target.organization.id,
      })
      expect(plan.blockers).toEqual([])
      const view = await createProposal(
        'crm.propose_organization_merge',
        {
          sourceOrganizationId: source.organization.id,
          targetOrganizationId: target.organization.id,
          expectedPlanHash: plan.planHash,
          note: 'Reviewed duplicate account',
          operationId: randomUUID(),
        },
        { config, database: db, grant, kinds, now: new Date(), requestId: randomUUID() },
      )
      const pending = await db.operatorProposal.findUniqueOrThrow({
        where: { id: view.proposalId },
      })
      expect(pending).toMatchObject({ status: 'PENDING', autoApproved: false })
      expect(
        await db.prospectOrganizationMerge.count({
          where: { sourceOrganizationId: source.organization.id },
        }),
      ).toBe(0)

      // The chat side can only ask; a person on the allowlist decides and the merge resumes.
      const ticket = await requestDecision(view.proposalId, {
        config,
        database: db,
        grant,
        now: new Date(),
        requestId: randomUUID(),
      })
      await expect(
        decideRequest(
          {
            decisionRequestId: ticket.requestId!,
            argsHash: pending.argsHash,
            decision: 'approve',
            actorUserId: `not-an-owner-${suffix}`,
            requestId: randomUUID(),
            now: new Date(),
          },
          { database: db, kinds, allowedUserIds: config.allowedUserIds },
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN_ACTOR' })
      const decided = await decideRequest(
        {
          decisionRequestId: ticket.requestId!,
          argsHash: pending.argsHash,
          decision: 'approve',
          actorUserId: owner,
          requestId: randomUUID(),
          now: new Date(),
        },
        { database: db, kinds, allowedUserIds: config.allowedUserIds },
      )
      expect(decided).toMatchObject({ status: 'APPLIED', decidedByUserId: owner })
      const receipt = await db.prospectOrganizationMerge.findUniqueOrThrow({
        where: { sourceOrganizationId: source.organization.id },
      })
      expect(receipt).toMatchObject({
        targetOrganizationId: target.organization.id,
        actorId: owner,
      })
      expect(decided.result).toMatchObject({ mergeId: receipt.id, replayed: false })
    })
  }, 120_000)
})
