/* eslint-disable @typescript-eslint/no-explicit-any -- test helper returns loosely typed parsed output */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  OPERATOR_MCP_OUTPUTS,
  OperatorCapability,
  type OperatorReadToolName,
} from '@pathfinder/contracts/operator-mcp'
import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { resolveOperatorConfig } from '../config'
import type { VerifiedOperatorGrant } from '../oauth'
import { approveAndApplyPlan, createPlan } from '../plans'
import { createKindRegistry, createProposal } from '../proposals'
import { createOperatorRegistry, defaultVenueRead } from '../registry'
import { OPERATOR_PROPOSAL_KINDS } from './index'

/**
 * The sanitized historical-mail / duplicate-record case on a real disposable PostgreSQL: three
 * likely duplicate accounts with import-only history and no contacts, while a separate
 * investigation verified that one outbound message went out. Reconciliation records that effect
 * once, on the right account, keeps every import, and sends nothing. Invented names only.
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
const kinds = createKindRegistry(OPERATOR_PROPOSAL_KINDS)
const dependencies = { database: db, kinds, allowedUserIds: config.allowedUserIds }
const registry = createOperatorRegistry()

const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
const clientId = `opc_hist_${suffix}`
const domain = `${suffix}-parks.example.org`
const recipient = `director.${suffix}@${domain}`
const messageId = `verified-${suffix}`
const mailbox = 'sender@example.com'
const sentAt = '2026-09-20T15:00:00.000Z'
let grant: VerifiedOperatorGrant

const service = () => ({
  config,
  database: db,
  grant,
  kinds,
  now: new Date(),
  requestId: randomUUID(),
})
async function read(name: OperatorReadToolName, args: Record<string, unknown>) {
  const output = await registry.callTool(name, args, {
    config,
    database: db,
    grant,
    now: new Date(),
    requestId: randomUUID(),
    venueRead: defaultVenueRead(db),
  })
  return OPERATOR_MCP_OUTPUTS[name].parse(output) as any
}

/** Everything that could mean mail was staged or sent, counted across the whole database. */
async function outboundCounts() {
  return {
    batches: await db.prospectSendBatch.count(),
    items: await db.prospectSendItem.count(),
    outbox: await db.prospectSendOutbox.count(),
  }
}

async function importedPark(name: string) {
  const organization = await db.prospectOrganization.create({
    data: {
      canonicalName: name,
      normalizedName: name.toLowerCase(),
      website: `https://${domain}`,
      normalizedDomain: domain,
      createdBy: 'import',
      updatedBy: 'import',
      opportunity: {
        create: { stage: 'RESEARCHED', createdBy: 'import', updatedBy: 'import' },
      },
    },
  })
  // Import-only history: nothing a person did, and no contacts at all.
  await db.prospectActivity.create({
    data: {
      organizationId: organization.id,
      type: 'IMPORTED',
      summary: 'Imported from spreadsheet row',
      actorId: 'import',
      occurredAt: new Date('2026-08-01T00:00:00.000Z'),
    },
  })
  return organization.id
}

describe.skipIf(!enabled)(
  'historical mail and duplicate reconciliation on disposable PostgreSQL',
  { timeout: 120_000 },
  () => {
    let a = ''
    let b = ''
    let c = ''

    beforeAll(async () => {
      await db.operatorOAuthClient.create({
        data: {
          id: clientId,
          clientName: 'Example connector',
          redirectUris: ['https://connector.example.com/cb'],
          registrationIpHash: 'a'.repeat(64),
          consentedAt: new Date(),
        },
      })
      const created = await db.operatorGrant.create({
        data: {
          clientId,
          userId: 'user_owner',
          allTenants: true,
          tenantIds: [],
          capabilities: [...OperatorCapability.options],
          resource: config.resource,
          scope: 'operator',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      })
      grant = {
        grantId: created.id,
        clientId,
        userId: 'user_owner',
        allTenants: true,
        tenantIds: [],
        capabilities: [...OperatorCapability.options],
      }
      a = await importedPark(`Example Park ${suffix}`)
      b = await importedPark(`Example Park ${suffix} Inc`)
      c = await importedPark(`The Example Park ${suffix}`)
    })

    afterAll(async () => {
      await withTenantIsolationBypass(() => db.$disconnect())
    })

    it('shows three import-only, uncontacted lookalikes, and resolves the name to a question, not a guess', async () => {
      const resolved = await read('crm.resolve_account', { domain })
      expect(resolved.resolution).toBe('ambiguous')
      expect(resolved.candidates.map((candidate: any) => candidate.organizationId).sort()).toEqual(
        [a, b, c].sort(),
      )
      for (const candidate of resolved.candidates) {
        expect(candidate.contacted).toBe(false)
      }
      const context = await read('crm.get_account_context', { organizationId: a })
      expect(context.contacts.total).toBe(0)
      expect(context.history).toMatchObject({ activityCount: 1, outboundMessages: 0 })
    })

    it('records the verified send once on the chosen account, keeps every import, and sends nothing', async () => {
      const before = {
        activities: await db.prospectActivity.count({
          where: { organizationId: { in: [a, b, c] } },
        }),
        outbound: await outboundCounts(),
      }
      const plan = await createPlan(
        {
          operationId: randomUUID(),
          title: 'Reconcile one verified historical send',
          steps: [
            {
              tool: 'crm.propose_contact_create',
              arguments: {
                organizationId: a,
                fullName: 'Park Director',
                email: recipient,
                source: `Recipient of verified message ${messageId}`,
              },
            },
            {
              tool: 'crm.log_outreach_sent',
              arguments: {
                organizationId: a,
                contactId: '{{steps.0.result.contactId}}',
                gmailMessageId: messageId,
                mailbox,
                sentAt,
              },
              dependsOn: [0],
            },
            {
              tool: 'crm.propose_duplicate_resolution',
              arguments: {
                organizationId: a,
                otherOrganizationId: b,
                resolution: 'CONFIRMED_DUPLICATE',
                note: 'Same domain and name; the import created a second record',
              },
            },
            {
              tool: 'crm.propose_duplicate_resolution',
              arguments: {
                organizationId: a,
                otherOrganizationId: c,
                resolution: 'CONFIRMED_DUPLICATE',
                note: 'Same domain and name; the import created a third record',
              },
            },
          ],
        },
        service(),
      )
      // A plan that mentions a duplicate decision is never applied by policy: a person decides.
      expect(plan.status).toBe('PENDING')
      const applied = await approveAndApplyPlan(
        {
          planId: plan.proposalId,
          argsHash: plan.argsHash,
          actorUserId: 'user_owner',
          requestId: randomUUID(),
          now: new Date(),
        },
        dependencies,
      )
      expect(applied.status).toBe('APPLIED')

      // The send is recorded exactly once, under its mailbox-namespaced receipt, still unverified.
      const receipts = await db.prospectActivity.findMany({
        where: { externalReceiptKey: `gmail:${mailbox}:${messageId}` },
      })
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({ organizationId: a, type: 'OUTREACH_SENT' })
      expect(receipts[0]!.evidence).toMatchObject({ verification: 'unverified' })
      expect(receipts[0]!.occurredAt.toISOString()).toBe(sentAt)

      // Last activity reflects the real send date (it was null before, never rewound).
      expect(
        (
          await db.prospectOpportunity.findUniqueOrThrow({ where: { organizationId: a } })
        ).lastActivityAt?.toISOString(),
      ).toBeDefined()

      // Every import survives; the duplicates are marked, not merged, moved or emptied.
      expect(
        await db.prospectActivity.count({
          where: { organizationId: { in: [a, b, c] }, type: 'IMPORTED' },
        }),
      ).toBe(3)
      expect(await db.prospectContact.count({ where: { organizationId: { in: [b, c] } } })).toBe(0)
      const pairs = await db.prospectDuplicateCandidate.findMany({
        where: { OR: [{ organizationAId: a }, { organizationBId: a }] },
      })
      expect(pairs.map((pair) => pair.status)).toEqual([
        'CONFIRMED_DUPLICATE',
        'CONFIRMED_DUPLICATE',
      ])
      expect(pairs.every((pair) => pair.resolutionNote?.includes('operator proposal'))).toBe(true)
      expect(
        await db.prospectActivity.count({ where: { organizationId: { in: [a, b, c] } } }),
      ).toBe(
        before.activities + 2, // the contact added and the send logged; the imports are untouched
      )

      // And nothing was sent, staged or drafted: reconciliation never creates an outbound effect.
      expect(await outboundCounts()).toEqual(before.outbound)
      expect(
        await db.prospectOutreachDraft.count({ where: { organizationId: { in: [a, b, c] } } }),
      ).toBe(0)
      expect(
        await db.prospectEmailMessage.count({ where: { organizationId: { in: [a, b, c] } } }),
      ).toBe(0)
    })

    it('now reads as one contacted account and two flagged duplicates, with the history in the right place', async () => {
      const duplicates = await read('crm.list_duplicates', { organizationId: a })
      expect(duplicates.items).toHaveLength(2)
      for (const item of duplicates.items) {
        expect(item.status).toBe('CONFIRMED_DUPLICATE')
        const sides = Object.fromEntries(
          item.accounts.map((side: any) => [side.organizationId, side]),
        )
        expect(sides[a]).toMatchObject({ contacted: true, importOnly: false, contactCount: 1 })
        const other = Object.values(sides).find((side: any) => side.organizationId !== a) as any
        expect(other).toMatchObject({ contacted: false, importOnly: true, contactCount: 0 })
      }
      const context = await read('crm.get_account_context', { organizationId: a })
      expect(context.duplicates.map((entry: any) => entry.status)).toEqual([
        'CONFIRMED_DUPLICATE',
        'CONFIRMED_DUPLICATE',
      ])
      expect(context.history.activityCount).toBeGreaterThanOrEqual(3)
    })

    it('refuses to claim the same verified message for a duplicate, and replays the same log harmlessly', async () => {
      const contact = await db.prospectContact.findFirstOrThrow({ where: { organizationId: a } })
      await expect(
        createProposal(
          'crm.log_outreach_sent',
          {
            organizationId: b,
            contactId: (
              await db.prospectContact.create({
                data: {
                  organizationId: b,
                  fullName: 'Someone Else',
                  createdBy: 'seed',
                  updatedBy: 'seed',
                },
              })
            ).id,
            gmailMessageId: messageId,
            mailbox,
            sentAt,
            operationId: randomUUID(),
          },
          service(),
        ),
      ).rejects.toMatchObject({ code: 'RECEIPT_CONFLICT' })
      // The same message logged again for the same account is a replay: still one receipt.
      const again = await createProposal(
        'crm.log_outreach_sent',
        {
          organizationId: a,
          contactId: contact.id,
          gmailMessageId: messageId,
          mailbox,
          sentAt,
          operationId: randomUUID(),
        },
        service(),
      )
      expect(again.status).toBe('PENDING')
      expect(
        await db.prospectActivity.count({
          where: { externalReceiptKey: `gmail:${mailbox}:${messageId}` },
        }),
      ).toBe(1)
    })
  },
)
