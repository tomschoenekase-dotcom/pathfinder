/* eslint-disable @typescript-eslint/no-explicit-any -- test helper returns loosely typed parsed output */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { OperatorCapability } from '@pathfinder/contracts/operator-mcp'
import { createProspectContactAction, db, withTenantIsolationBypass } from '@pathfinder/db'

import { resolveAutonomy } from '../autonomy'
import { resolveOperatorConfig } from '../config'
import { recoverOperation } from '../execution'
import type { VerifiedOperatorGrant } from '../oauth'
import {
  approveAndApplyProposal,
  createKindRegistry,
  createProposal,
  createRevertProposal,
} from '../proposals'
import { OPERATOR_PROPOSAL_KINDS } from './index'

/**
 * Everyday CRM upkeep on a real disposable PostgreSQL. Invented names and example domains only.
 * Runs only against a database named pathfinder_disposable_*.
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

const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
const clientId = `opc_maint_${suffix}`
const admin = { type: 'HUMAN', id: 'user_owner', role: 'PLATFORM_ADMIN' } as const
let grant: VerifiedOperatorGrant

const service = () => ({
  config,
  database: db,
  grant,
  kinds,
  now: new Date(),
  requestId: randomUUID(),
})
const propose = (tool: string, args: Record<string, unknown>, operationId = randomUUID()) =>
  createProposal(tool, { ...args, operationId }, service())
const approve = (view: { proposalId: string; argsHash: string }) =>
  approveAndApplyProposal(
    {
      proposalId: view.proposalId,
      argsHash: view.argsHash,
      actorUserId: 'user_owner',
      requestId: randomUUID(),
      now: new Date(),
    },
    dependencies,
  )
async function revert(proposalId: string) {
  const view = await createRevertProposal(
    { proposalId, operationId: randomUUID() },
    (raw) => raw as { proposalId: string; operationId: string },
    service(),
  )
  expect(view.status).toBe('PENDING')
  return approve(view)
}

async function newOrganization(name = `Maint Org ${randomUUID().slice(0, 8)}`) {
  const organization = await db.prospectOrganization.create({
    data: {
      canonicalName: name,
      normalizedName: name.toLowerCase(),
      createdBy: 'seed',
      updatedBy: 'seed',
      opportunity: { create: { stage: 'RESEARCHED', createdBy: 'seed', updatedBy: 'seed' } },
    },
  })
  return organization.id
}
const version = async (id: string) =>
  1 + (await db.prospectActivity.count({ where: { organizationId: id } }))
const row = (proposalId: string) =>
  db.operatorProposal.findUniqueOrThrow({ where: { id: proposalId } })

describe.skipIf(!enabled)(
  'operator CRM maintenance on disposable PostgreSQL',
  { timeout: 120_000 },
  () => {
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
    })

    afterAll(async () => {
      await withTenantIsolationBypass(() => db.$disconnect())
    })

    describe('contacts', () => {
      it('adds a contact once, records where it came from, and reverts by archiving', async () => {
        const org = await newOrganization()
        const address = `new.${suffix}@example.com`
        const args = {
          organizationId: org,
          fullName: 'New Person',
          title: 'Director',
          email: address.toUpperCase(),
          source: 'Introduced by email thread',
        }
        const operationId = randomUUID()
        const view = await propose('crm.propose_contact_create', args, operationId)
        expect(view.status).toBe('PENDING')
        expect((await propose('crm.propose_contact_create', args, operationId)).proposalId).toBe(
          view.proposalId,
        )
        // Two approvals racing apply once.
        await Promise.all([approve(view), approve(view)])
        const contacts = await db.prospectContact.findMany({ where: { organizationId: org } })
        expect(contacts).toHaveLength(1)
        expect(contacts[0]).toMatchObject({
          email: address,
          normalizedEmail: address,
          emailReadiness: 'UNKNOWN',
          permissionState: 'UNKNOWN',
          doNotContact: false,
        })
        expect(JSON.stringify(contacts[0]!.provenance)).toContain('Introduced by email thread')
        expect((await row(view.proposalId)).status).toBe('APPLIED')
        // The created contact is not send-ready on its own: a human review still gates sending.
        expect((await revert(view.proposalId)).status).toBe('APPLIED')
        expect(
          (await db.prospectContact.findUniqueOrThrow({ where: { id: contacts[0]!.id } }))
            .archivedAt,
        ).not.toBeNull()
      })

      it('refuses an address that is blocked anywhere in the CRM, archived rows included', async () => {
        const blockedOrg = await newOrganization()
        const address = `declined.${suffix}@example.com`
        await db.prospectContact.create({
          data: {
            organizationId: blockedOrg,
            fullName: 'Declined Person',
            email: address,
            normalizedEmail: address,
            suppressedAt: new Date(),
            archivedAt: new Date(),
            createdBy: 'seed',
            updatedBy: 'seed',
          },
        })
        const other = await newOrganization()
        await expect(
          propose('crm.propose_contact_create', {
            organizationId: other,
            email: address,
            source: 'A different account lists the same person',
          }),
        ).rejects.toMatchObject({ code: 'ADDRESS_SUPPRESSED' })
        // The canonical action refuses it too, independent of the operator's own check.
        await expect(
          createProspectContactAction({
            organizationId: other,
            email: address,
            source: 'direct',
            actor: admin,
          }),
        ).rejects.toMatchObject({ code: 'SUPPRESSED' })
        expect(await db.prospectContact.count({ where: { organizationId: other } })).toBe(0)
      })

      it('turns a duplicate address into a clear no-effect failure, not a second row', async () => {
        const org = await newOrganization()
        const address = `dupe.${suffix}@example.com`
        await db.prospectContact.create({
          data: {
            organizationId: org,
            email: address,
            normalizedEmail: address,
            fullName: 'Existing',
            createdBy: 'seed',
            updatedBy: 'seed',
          },
        })
        const view = await propose('crm.propose_contact_create', {
          organizationId: org,
          email: address,
          source: 'Seen again',
        })
        // Another writer adds the address after the proposal: its target version moved.
        const applied = await approve(view)
        expect(applied.status).toBe('STALE')
        expect(await db.prospectContact.count({ where: { organizationId: org } })).toBe(1)
        const settled = await row(view.proposalId)
        expect(settled.failureCode).toBe('TARGET_CHANGED')
      })

      it('corrects a contact under compare-and-swap; the address and suppression cannot change', async () => {
        const org = await newOrganization()
        const contact = await db.prospectContact.create({
          data: {
            organizationId: org,
            fullName: 'Old Name',
            title: 'Assistant',
            email: `edit.${suffix}@example.com`,
            normalizedEmail: `edit.${suffix}@example.com`,
            createdBy: 'seed',
            updatedBy: 'seed',
          },
        })
        const view = await propose('crm.propose_contact_update', {
          contactId: contact.id,
          expectedUpdatedAt: contact.updatedAt.toISOString(),
          fullName: 'New Name',
          title: null,
          phone: '555-0100',
        })
        expect((await approve(view)).status).toBe('APPLIED')
        const edited = await db.prospectContact.findUniqueOrThrow({ where: { id: contact.id } })
        expect(edited).toMatchObject({
          fullName: 'New Name',
          title: null,
          phone: '555-0100',
          email: `edit.${suffix}@example.com`,
          doNotContact: false,
        })
        // The contact input has no field for the address or any suppression.
        await expect(
          propose('crm.propose_contact_update', {
            contactId: contact.id,
            expectedUpdatedAt: edited.updatedAt.toISOString(),
            email: 'other@example.com',
          } as never),
        ).rejects.toThrow()
        // Revert restores the old values, because nothing moved since.
        expect((await revert(view.proposalId)).status).toBe('APPLIED')
        expect(
          await db.prospectContact.findUniqueOrThrow({ where: { id: contact.id } }),
        ).toMatchObject({
          fullName: 'Old Name',
          title: 'Assistant',
          phone: null,
        })
      })

      it('two edits holding one version: one wins and the other is a conflict, never a lost update', async () => {
        const org = await newOrganization()
        const contact = await db.prospectContact.create({
          data: {
            organizationId: org,
            fullName: 'Race Person',
            createdBy: 'seed',
            updatedBy: 'seed',
          },
        })
        const stamp = contact.updatedAt.toISOString()
        const first = await propose('crm.propose_contact_update', {
          contactId: contact.id,
          expectedUpdatedAt: stamp,
          title: 'First',
        })
        const second = await propose('crm.propose_contact_update', {
          contactId: contact.id,
          expectedUpdatedAt: stamp,
          title: 'Second',
        })
        const results = await Promise.all([approve(first), approve(second)])
        expect(results.map((result) => result.status).sort()).toEqual(['APPLIED', 'STALE'])
        const final = await db.prospectContact.findUniqueOrThrow({ where: { id: contact.id } })
        expect(['First', 'Second']).toContain(final.title)
      })

      it('archives and restores a contact without losing its block; an old address stays blocked', async () => {
        const org = await newOrganization()
        const address = `old.${suffix}@example.com`
        const contact = await db.prospectContact.create({
          data: {
            organizationId: org,
            fullName: 'Old Address',
            email: address,
            normalizedEmail: address,
            unsubscribedAt: new Date(),
            createdBy: 'seed',
            updatedBy: 'seed',
          },
        })
        const view = await propose('crm.propose_contact_archive', {
          contactId: contact.id,
          expectedUpdatedAt: contact.updatedAt.toISOString(),
          archived: true,
          reason: 'Replaced by a new address',
        })
        expect((await approve(view)).status).toBe('APPLIED')
        const archived = await db.prospectContact.findUniqueOrThrow({ where: { id: contact.id } })
        expect(archived.archivedAt).not.toBeNull()
        // The decline survives archiving: the address is still refused for every account.
        const other = await newOrganization()
        await expect(
          propose('crm.propose_contact_create', {
            organizationId: other,
            email: address,
            source: 'Someone tries the old address again',
          }),
        ).rejects.toMatchObject({ code: 'ADDRESS_SUPPRESSED' })
        expect((await revert(view.proposalId)).status).toBe('APPLIED')
        expect(
          (await db.prospectContact.findUniqueOrThrow({ where: { id: contact.id } })).archivedAt,
        ).toBeNull()
      })
    })

    describe('follow-up, notes and archive', () => {
      it('sets owner, next action and due date; a note meanwhile makes it stale; revert restores', async () => {
        const org = await newOrganization()
        const due = '2026-11-01T15:00:00.000Z'
        const view = await propose('crm.propose_followup_update', {
          organizationId: org,
          expectedVersion: await version(org),
          ownerId: 'user_owner',
          nextAction: 'Call the director',
          nextActionAt: due,
          priority: 'HIGH',
        })
        expect((await approve(view)).status).toBe('APPLIED')
        expect(
          await db.prospectOpportunity.findUniqueOrThrow({ where: { organizationId: org } }),
        ).toMatchObject({
          ownerId: 'user_owner',
          nextAction: 'Call the director',
          priority: 'HIGH',
          stage: 'RESEARCHED',
        })
        expect((await revert(view.proposalId)).status).toBe('APPLIED')
        expect(
          await db.prospectOpportunity.findUniqueOrThrow({ where: { organizationId: org } }),
        ).toMatchObject({ ownerId: null, nextAction: null, priority: 'NORMAL' })

        // A newer record of the account since it was read: the change is stale, nothing moves.
        const stale = await propose('crm.propose_followup_update', {
          organizationId: org,
          expectedVersion: await version(org),
          ownerId: 'someone_else',
        })
        await db.prospectActivity.create({
          data: {
            organizationId: org,
            type: 'NOTE_ADDED',
            summary: 'Operator note added',
            detail: 'A person wrote something',
            actorId: 'seed',
          },
        })
        expect((await approve(stale)).status).toBe('STALE')
        expect(
          (await db.prospectOpportunity.findUniqueOrThrow({ where: { organizationId: org } }))
            .ownerId,
        ).toBeNull()
      })

      it('appends a note once, never rewinds last activity, and keeps updates out of the note list', async () => {
        const org = await newOrganization()
        await db.prospectOpportunity.update({
          where: { organizationId: org },
          data: { lastActivityAt: new Date('2027-01-01T00:00:00.000Z') },
        })
        const operationId = randomUUID()
        const args = {
          organizationId: org,
          note: 'Met at the conference.',
          source: 'Calendar entry',
        }
        const view = await propose('crm.propose_note', args, operationId)
        await Promise.all([approve(view), approve(view)])
        const notes = await db.prospectActivity.findMany({
          where: { organizationId: org, summary: 'Operator note added' },
        })
        expect(notes).toHaveLength(1)
        expect(notes[0]).toMatchObject({ detail: 'Met at the conference.' })
        // A note dated now never moves a later last activity backwards.
        expect(
          (
            await db.prospectOpportunity.findUniqueOrThrow({ where: { organizationId: org } })
          ).lastActivityAt?.toISOString(),
        ).toBe('2027-01-01T00:00:00.000Z')
        // A follow-up update writes a NOTE_ADDED row too, but it is not a note.
        const followup = await propose('crm.propose_followup_update', {
          organizationId: org,
          expectedVersion: await version(org),
          nextAction: 'Send the deck',
        })
        await approve(followup)
        expect(
          await db.prospectActivity.count({ where: { organizationId: org, type: 'NOTE_ADDED' } }),
        ).toBe(2)
        expect(
          await db.prospectActivity.count({
            where: { organizationId: org, summary: 'Operator note added' },
          }),
        ).toBe(1)
      })

      it('archive always asks, even under an old broad AUTO switch, and restores from a person', async () => {
        const org = await newOrganization()
        await db.operatorAutonomyPolicy.upsert({
          where: { capability: 'crm:propose' },
          create: { capability: 'crm:propose', mode: 'AUTO', updatedByUserId: 'test' },
          update: { mode: 'AUTO', allowedKinds: [] },
        })
        try {
          // The legacy switch covers no new maintenance kind and never the archive.
          for (const kind of ['crm.account-archive', 'crm.contact-create', 'crm.note']) {
            expect(await resolveAutonomy({ kind, capability: 'crm:propose' })).toBe('ask')
          }
          const view = await propose('crm.propose_account_archive', {
            organizationId: org,
            expectedVersion: await version(org),
            archived: true,
            reason: 'Closed down',
          })
          expect(view.status).toBe('PENDING')
          expect((await approve(view)).status).toBe('APPLIED')
          expect(
            (await db.prospectOrganization.findUniqueOrThrow({ where: { id: org } })).archivedAt,
          ).not.toBeNull()
          expect((await revert(view.proposalId)).status).toBe('APPLIED')
          expect(
            (await db.prospectOrganization.findUniqueOrThrow({ where: { id: org } })).archivedAt,
          ).toBeNull()
        } finally {
          await db.operatorAutonomyPolicy.update({
            where: { capability: 'crm:propose' },
            data: { mode: 'ASK' },
          })
        }
      })
    })

    describe('interrupted applies are settled from receipts', () => {
      it('a contact create that committed before the crash is reconciled, not repeated', async () => {
        const org = await newOrganization()
        const view = await propose('crm.propose_contact_create', {
          organizationId: org,
          fullName: 'Crash Person',
          email: `crash.${suffix}@example.com`,
          source: 'Crash test',
        })
        const stored = await row(view.proposalId)
        // The domain write committed under this operation's key, then the worker died.
        await createProspectContactAction({
          organizationId: org,
          fullName: 'Crash Person',
          email: `crash.${suffix}@example.com`,
          source: 'Crash test',
          operationKey: stored.operationId,
          actor: admin,
        })
        const now = Date.now()
        await db.operatorProposal.update({
          where: { id: view.proposalId },
          data: {
            status: 'APPROVED',
            decidedByUserId: 'user_owner',
            decidedAt: new Date(now - 600_000),
            applyClaimedAt: new Date(now - 600_000),
            applyStartedAt: new Date(now - 600_000),
            leaseExpiresAt: new Date(now - 300_000),
            attempt: 1,
            fenceToken: 1,
          },
        })
        await recoverOperation(view.proposalId, dependencies, {
          requestId: randomUUID(),
          now: new Date(),
        })
        const settled = await row(view.proposalId)
        expect(settled.status).toBe('APPLIED')
        expect(settled.result).toMatchObject({ reconciled: true })
        expect(await db.prospectContact.count({ where: { organizationId: org } })).toBe(1)
      })

      it('a refused write proves no effect: a conflict records no change and a clear code', async () => {
        const org = await newOrganization()
        const view = await propose('crm.propose_followup_update', {
          organizationId: org,
          expectedVersion: await version(org),
          ownerId: 'user_owner',
        })
        await db.prospectActivity.create({
          data: {
            organizationId: org,
            type: 'NOTE_ADDED',
            summary: 'Operator note added',
            detail: 'moved',
            actorId: 'seed',
          },
        })
        const applied = await approve(view)
        expect(applied.status).toBe('STALE')
        const stored = await row(view.proposalId)
        // Refused atomically: the "may have started" mark is cleared, so the effect is known to be none.
        expect(stored.applyStartedAt).toBeNull()
      })
    })
  },
)
