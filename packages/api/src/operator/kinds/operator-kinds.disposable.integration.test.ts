import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { OperatorCapability } from '@pathfinder/contracts/operator-mcp'
import {
  createVenueAction,
  db,
  updateProspectPipelineAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { resolveAutonomy, setAutonomyPolicy } from '../autonomy'
import { resolveOperatorConfig } from '../config'
import type { VerifiedOperatorGrant } from '../oauth'
import { approveAndApplyPlan } from '../plans'
import {
  approveAndApplyProposal,
  createProposal,
  createRevertProposal,
  createKindRegistry,
} from '../proposals'
import { OPERATOR_PROPOSAL_KINDS } from './index'

/**
 * Per-kind proposal tests on a real disposable PostgreSQL. Invented names and example domains only.
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
const tenantId = `kind-tenant-${suffix}`
const clientId = `opc_kinds_${suffix}`
const askFixtureCapabilities = [
  'crm:propose',
  'crm:log',
  'venues:propose',
  'customers:propose',
] as const
let originalAutonomyPolicies: Awaited<ReturnType<typeof db.operatorAutonomyPolicy.findMany>> = []
let autonomyPoliciesSnapshotTaken = false
let grant: VerifiedOperatorGrant
let venueId = ''
let organizationId = ''
let otherOrganizationId = ''
let contactId = ''
let memberId = ''
let sendBatchesAtStart = 0

const now = () => new Date()
const ids = { organizations: [] as string[] }

async function propose(tool: string, args: Record<string, unknown>, operationId = randomUUID()) {
  return createProposal(
    tool,
    { ...args, operationId },
    { config, database: db, grant, kinds, now: now(), requestId: randomUUID() },
  )
}

async function approve(view: { proposalId: string; argsHash: string }) {
  return approveAndApplyProposal(
    {
      proposalId: view.proposalId,
      argsHash: view.argsHash,
      actorUserId: 'user_owner',
      requestId: randomUUID(),
      now: now(),
    },
    dependencies,
  )
}

async function withAuto<T>(capability: OperatorCapability, fn: () => Promise<T>): Promise<T> {
  const change = (mode: 'ask' | 'auto') =>
    setAutonomyPolicy({ capability, mode, userId: 'user_owner', requestId: randomUUID() })
  await change('auto')
  try {
    return await fn()
  } finally {
    await change('ask')
  }
}

async function revert(proposalId: string) {
  const view = await createRevertProposal(
    { proposalId, operationId: randomUUID() },
    (raw) => raw as { proposalId: string; operationId: string },
    { config, database: db, grant, kinds, now: now(), requestId: randomUUID() },
  )
  expect(view.status).toBe('PENDING')
  return approve(view)
}

async function venueRow(id = venueId) {
  return (await db.venue.findFirst({
    where: { id, tenantId },
    select: { isActive: true, updatedAt: true },
  }))!
}

async function newOrganization(stage: 'DISCOVERED' | 'RESEARCHED' = 'DISCOVERED') {
  const organization = await db.prospectOrganization.create({
    data: {
      canonicalName: `Example Org ${randomUUID().slice(0, 8)}`,
      normalizedName: `example org ${randomUUID()}`,
      createdBy: 'seed',
      updatedBy: 'seed',
    },
  })
  ids.organizations.push(organization.id)
  await db.prospectOpportunity.create({
    data: { organizationId: organization.id, stage, createdBy: 'seed', updatedBy: 'seed' },
  })
  return organization.id
}

async function opportunityVersion(id: string) {
  return 1 + (await db.prospectActivity.count({ where: { organizationId: id } }))
}

async function newVenue(slug: string) {
  return (
    await withTenantIsolationBypass(() =>
      createVenueAction({
        tenantId,
        actor: { type: 'HUMAN', id: 'user_owner', role: 'OWNER' },
        name: 'Example Garden',
        baseSlug: slug,
        callerSuppliedSlug: true,
        guideMode: 'non_location',
      }),
    )
  ).record
}

describe.skipIf(!enabled)(
  'operator proposal kinds on disposable PostgreSQL',
  { timeout: 90_000 },
  () => {
    beforeAll(async () => {
      sendBatchesAtStart = await db.prospectSendBatch.count()
      await withTenantIsolationBypass(async () => {
        await db.tenant.create({
          data: { id: tenantId, name: `Example ${tenantId}`, slug: tenantId },
        })
      })
      venueId = (await newVenue(`example-garden-${suffix}`)).id
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
          userId: 'user_owner',
          allTenants: false,
          tenantIds: [tenantId],
          capabilities: [...OperatorCapability.options],
          resource: config.resource,
          scope: 'operator',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      })
      grant = {
        grantId: row.id,
        clientId,
        userId: 'user_owner',
        allTenants: false,
        tenantIds: [tenantId],
        capabilities: [...OperatorCapability.options],
      }
      organizationId = await newOrganization()
      otherOrganizationId = await newOrganization()
      const contact = await db.prospectContact.create({
        data: {
          organizationId,
          fullName: 'Casey Example',
          email: 'casey@example.com',
          normalizedEmail: 'casey@example.com',
          emailReadiness: 'VALID',
          createdBy: 'seed',
          updatedBy: 'seed',
        },
      })
      contactId = contact.id
      const campaign = await db.prospectOutreachCampaign.create({
        data: {
          name: 'Example campaign',
          cohortSnapshot: {},
          playbookVersion: 'test',
          createdBy: 'seed',
          updatedBy: 'seed',
        },
      })
      const member = await db.prospectCampaignMember.create({
        data: { campaignId: campaign.id, organizationId, contactId, status: 'SELECTED' },
      })
      memberId = member.id
      originalAutonomyPolicies = await db.operatorAutonomyPolicy.findMany({
        where: { capability: { in: [...askFixtureCapabilities] } },
      })
      autonomyPoliciesSnapshotTaken = true
      for (const capability of askFixtureCapabilities) {
        await db.operatorAutonomyPolicy.upsert({
          where: { capability },
          create: { capability, mode: 'ASK', updatedByUserId: 'user_owner' },
          update: { mode: 'ASK' },
        })
      }
    })

    afterAll(async () => {
      if (autonomyPoliciesSnapshotTaken) {
        for (const capability of askFixtureCapabilities) {
          const original = originalAutonomyPolicies.find((row) => row.capability === capability)
          if (original) {
            await db.operatorAutonomyPolicy.upsert({
              where: { capability },
              create: {
                capability,
                mode: original.mode,
                allowedKinds: original.allowedKinds,
                updatedByUserId: original.updatedByUserId,
              },
              update: {
                mode: original.mode,
                allowedKinds: original.allowedKinds,
                updatedByUserId: original.updatedByUserId,
              },
            })
          } else {
            await db.operatorAutonomyPolicy.deleteMany({ where: { capability } })
          }
        }
      }
      // Leave no embedding work behind: later CI steps lease any pending dispatch in this database.
      await withTenantIsolationBypass(() =>
        db.embeddingDispatch.deleteMany({ where: { tenantId: { in: [tenantId] } } }),
      )
      await db.$disconnect()
    })

    it('registers exactly the kinds with a canonical action, each with its contract capability', () => {
      expect([...kinds.keys()].sort()).toEqual(
        [
          'appearance.propose_update',
          'crm.log_outreach_sent',
          'crm.propose_account_archive',
          'crm.propose_batch_approve',
          'crm.propose_batch_release',
          'crm.propose_batch_stage',
          'crm.propose_campaign_create',
          'crm.propose_campaign_membership',
          'crm.propose_draft_review',
          'crm.propose_contact_archive',
          'crm.propose_contact_create',
          'crm.propose_contact_update',
          'crm.propose_duplicate_resolution',
          'crm.propose_followup_update',
          'crm.propose_note',
          'support.propose_completion',
          'support.propose_triage',
          'customers.propose_onboarding_questions',
          'customers.propose_create',
          'customers.propose_invite',
          'offboarding.propose_execution',
          'support.propose_information_request',
          'support.propose_internal_note',
          'crm.propose_outreach_draft',
          'crm.propose_stage_change',
          'venues.propose_create',
          'venues.propose_knowledge',
          'venues.propose_publish',
          'venues.propose_operational_update',
          'venues.propose_operational_update_schedule',
          'venues.propose_operational_update_end',
          'reports.propose_generate',
          'reports.propose_publish',
          'routines.propose_create',
          'routines.propose_update',
          'routines.propose_enable',
          'routines.propose_disable',
          'crm.propose_account_update',
          'crm.propose_contact_address_change',
          'crm.propose_prospect_create',
          'crm.propose_import_commit',
          'support.propose_create_request',
          'support.propose_client_reply',
          'venues.propose_source',
          'venues.propose_content_changeset',
        ].sort(),
      )
    })

    it('keeps customers.invite ask-only even with an AUTO policy row', async () => {
      await db.operatorAutonomyPolicy.upsert({
        where: { capability: 'customers:propose' },
        create: { capability: 'customers:propose', mode: 'AUTO', updatedByUserId: 'test' },
        update: { mode: 'AUTO' },
      })
      try {
        expect(
          await resolveAutonomy({ kind: 'customers.invite', capability: 'customers:propose' }),
        ).toBe('ask')
      } finally {
        await db.operatorAutonomyPolicy.update({
          where: { capability: 'customers:propose' },
          data: { mode: 'ASK' },
        })
      }
    })

    describe('crm.propose_stage_change', () => {
      it('ask path: pending, replay returns the same proposal, double approve applies once, no revert', async () => {
        const id = await newOrganization()
        const args = {
          organizationId: id,
          expectedVersion: await opportunityVersion(id),
          stage: 'RESEARCHED',
        }
        const operationId = randomUUID()
        const view = await propose('crm.propose_stage_change', args, operationId)
        expect(view.status).toBe('PENDING')
        expect(
          (await db.prospectOpportunity.findUnique({ where: { organizationId: id } }))?.stage,
        ).toBe('DISCOVERED')
        expect((await propose('crm.propose_stage_change', args, operationId)).proposalId).toBe(
          view.proposalId,
        )
        await Promise.all([approve(view), approve(view)])
        const row = await db.operatorProposal.findUnique({ where: { id: view.proposalId } })
        expect(row?.status).toBe('APPLIED')
        expect(row?.beforeSnapshot).toMatchObject({ stage: 'DISCOVERED' })
        expect(
          await db.prospectStageHistory.count({ where: { opportunity: { organizationId: id } } }),
        ).toBe(1)
        expect(
          (await db.prospectOpportunity.findUnique({ where: { organizationId: id } }))?.stage,
        ).toBe('RESEARCHED')
        await expect(
          createRevertProposal(
            { proposalId: view.proposalId, operationId: randomUUID() },
            (raw) => raw as { proposalId: string; operationId: string },
            { config, database: db, grant, kinds, now: now(), requestId: randomUUID() },
          ),
        ).rejects.toMatchObject({ code: 'NOT_REVERTIBLE' })
      })

      it('auto path applies at once; a moved organization goes STALE', async () => {
        const id = await newOrganization()
        const version = await opportunityVersion(id)
        const stale = await propose('crm.propose_stage_change', {
          organizationId: id,
          expectedVersion: version,
          stage: 'RESEARCHED',
        })
        await db.prospectActivity.create({
          data: { organizationId: id, type: 'NOTE_ADDED', summary: 'moved', actorId: 'seed' },
        })
        expect((await approve(stale)).status).toBe('STALE')
        const auto = await withAuto('crm:propose', () =>
          propose('crm.propose_stage_change', {
            organizationId: id,
            expectedVersion: version + 1,
            stage: 'NEEDS_REVIEW',
          }),
        )
        expect(auto.status).toBe('APPLIED')
        expect(
          (await db.prospectOpportunity.findUnique({ where: { organizationId: id } }))?.stage,
        ).toBe('NEEDS_REVIEW')
      })

      it('an unknown organization is NOT_FOUND', async () => {
        await expect(
          propose('crm.propose_stage_change', {
            organizationId: 'missing',
            expectedVersion: 1,
            stage: 'RESEARCHED',
          }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      })
    })

    describe('crm safety locks', () => {
      it('never lets the operator lift do-not-contact, even on auto', async () => {
        const locked = await newOrganization()
        await db.prospectOpportunity.update({
          where: { organizationId: locked },
          data: { stage: 'DO_NOT_CONTACT' },
        })
        const args = {
          organizationId: locked,
          expectedVersion: await opportunityVersion(locked),
          stage: 'READY_FOR_OUTREACH',
        }
        await expect(propose('crm.propose_stage_change', args)).rejects.toMatchObject({
          code: 'DO_NOT_CONTACT_LOCKED',
        })
        await expect(
          withAuto('crm:propose', () => propose('crm.propose_stage_change', args)),
        ).rejects.toMatchObject({ code: 'DO_NOT_CONTACT_LOCKED' })
        expect(
          (await db.prospectOpportunity.findUnique({ where: { organizationId: locked } }))?.stage,
        ).toBe('DO_NOT_CONTACT')
      })

      it('lets exactly one of two writers holding the same version win, and never lifts a suppression set meanwhile', async () => {
        const admin = { type: 'HUMAN', id: 'user_owner', role: 'PLATFORM_ADMIN' } as const
        const organization = await newOrganization('RESEARCHED')
        const version = await opportunityVersion(organization)
        const attempt = (stage: 'QUALIFIED' | 'PARKED') =>
          updateProspectPipelineAction({
            organizationId: organization,
            stage,
            reason: 'race',
            actor: admin,
            expectedVersion: version,
            refuseLiftingDoNotContact: true,
          })
        const outcomes = await Promise.allSettled([attempt('QUALIFIED'), attempt('PARKED')])
        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
        const lost = outcomes.find(
          (outcome) => outcome.status === 'rejected',
        ) as PromiseRejectedResult
        expect(lost.reason).toMatchObject({ code: 'CONFLICT' })

        // A human sets do-not-contact after the operator read the record: the stale write loses.
        const guarded = await newOrganization('RESEARCHED')
        const guardedVersion = await opportunityVersion(guarded)
        await updateProspectPipelineAction({
          organizationId: guarded,
          stage: 'DO_NOT_CONTACT',
          reason: 'asked to stop',
          actor: admin,
        })
        await expect(
          updateProspectPipelineAction({
            organizationId: guarded,
            stage: 'READY_FOR_OUTREACH',
            actor: admin,
            expectedVersion: guardedVersion,
            refuseLiftingDoNotContact: true,
          }),
        ).rejects.toMatchObject({ code: 'CONFLICT' })
        // Even with the right version the lock holds.
        await expect(
          updateProspectPipelineAction({
            organizationId: guarded,
            stage: 'READY_FOR_OUTREACH',
            actor: admin,
            expectedVersion: await opportunityVersion(guarded),
            refuseLiftingDoNotContact: true,
          }),
        ).rejects.toMatchObject({ code: 'CONFLICT' })
        expect(
          (await db.prospectOpportunity.findUnique({ where: { organizationId: guarded } }))?.stage,
        ).toBe('DO_NOT_CONTACT')
      })

      it('treats an archived organization as NOT_FOUND for writes', async () => {
        const archived = await newOrganization()
        await db.prospectOrganization.update({
          where: { id: archived },
          data: { archivedAt: new Date() },
        })
        await expect(
          propose('crm.propose_stage_change', {
            organizationId: archived,
            expectedVersion: await opportunityVersion(archived),
            stage: 'RESEARCHED',
          }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      })

      it('refuses to log a send dated in the future', async () => {
        await expect(
          propose('crm.log_outreach_sent', {
            organizationId,
            contactId,
            gmailMessageId: `gmail-${randomUUID()}`,
            sentAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
          }),
        ).rejects.toMatchObject({ code: 'SENT_AT_IN_FUTURE' })
      })
    })

    describe('crm.log_outreach_sent', () => {
      it('ask path writes one activity, replays, applies once and stays unrevertable', async () => {
        const args = {
          organizationId,
          contactId,
          gmailMessageId: `gmail-${randomUUID()}`,
          sentAt: '2026-09-01T15:00:00.000Z',
        }
        const operationId = randomUUID()
        const view = await propose('crm.log_outreach_sent', args, operationId)
        expect(view.status).toBe('PENDING')
        expect((await propose('crm.log_outreach_sent', args, operationId)).proposalId).toBe(
          view.proposalId,
        )
        await Promise.all([approve(view), approve(view)])
        const activities = await db.prospectActivity.findMany({
          where: {
            organizationId,
            type: 'OUTREACH_SENT',
            evidence: { path: ['gmailMessageId'], equals: args.gmailMessageId },
          },
        })
        expect(activities).toHaveLength(1)
        expect(activities[0]?.occurredAt.toISOString()).toBe(args.sentAt)
        // Logging a send never stages a batch: the count is whatever other suites left, unchanged.
        expect(await db.prospectSendBatch.count()).toBe(sendBatchesAtStart)
        const reverted = await createRevertProposal(
          { proposalId: view.proposalId, operationId: randomUUID() },
          (raw) => raw as { proposalId: string; operationId: string },
          { config, database: db, grant, kinds, now: now(), requestId: randomUUID() },
        ).catch((error: { code?: string }) => error)
        expect(reverted).toMatchObject({ code: 'NOT_REVERTIBLE' })
      })

      it('records one namespaced receipt under concurrency and never rewinds last activity', async () => {
        const gmailMessageId = `gmail-${randomUUID()}`
        const base = { organizationId, contactId, gmailMessageId, mailbox: 'sender@example.com' }
        // Two different proposals for the same provider message, approved at the same moment.
        const first = await propose('crm.log_outreach_sent', {
          ...base,
          sentAt: '2026-08-01T10:00:00.000Z',
        })
        const second = await propose('crm.log_outreach_sent', {
          ...base,
          sentAt: '2026-08-01T10:00:00.000Z',
        })
        await Promise.all([approve(first), approve(second)])
        const key = `gmail:sender@example.com:${gmailMessageId}`
        expect(await db.prospectActivity.count({ where: { externalReceiptKey: key } })).toBe(1)
        const receipt = await db.prospectActivity.findUniqueOrThrow({
          where: { externalReceiptKey: key },
        })
        expect(receipt.evidence).toMatchObject({ verification: 'unverified' })
        // The same provider id from another mailbox is a different message.
        const otherMailbox = await propose('crm.log_outreach_sent', {
          ...base,
          mailbox: 'someone-else@example.com',
          sentAt: '2026-08-01T10:00:00.000Z',
        })
        expect((await approve(otherMailbox)).status).toBe('APPLIED')

        // An older historical send must not move the account's last activity backwards.
        const target = await newOrganization('RESEARCHED')
        const targetContact = await db.prospectContact.create({
          data: {
            organizationId: target,
            fullName: 'Example Person',
            email: `hist-${randomUUID().slice(0, 8)}@example.com`,
            normalizedEmail: `hist-${randomUUID().slice(0, 8)}@example.com`,
            createdBy: 'seed',
            updatedBy: 'seed',
          },
        })
        const log = (messageId: string, sentAt: string) =>
          propose('crm.log_outreach_sent', {
            organizationId: target,
            contactId: targetContact.id,
            gmailMessageId: messageId,
            sentAt,
          }).then(approve)
        await log(`recent-${randomUUID()}`, '2026-09-20T10:00:00.000Z')
        await log(`older-${randomUUID()}`, '2026-07-01T10:00:00.000Z')
        const opportunity = await db.prospectOpportunity.findUniqueOrThrow({
          where: { organizationId: target },
        })
        expect(opportunity.lastActivityAt?.toISOString()).toBe('2026-09-20T10:00:00.000Z')

        // Another organization cannot claim a message already logged for this one.
        const outsider = await newOrganization('RESEARCHED')
        const outsiderContact = await db.prospectContact.create({
          data: {
            organizationId: outsider,
            fullName: 'Other Person',
            email: `other-${randomUUID().slice(0, 8)}@example.com`,
            normalizedEmail: `other-${randomUUID().slice(0, 8)}@example.com`,
            createdBy: 'seed',
            updatedBy: 'seed',
          },
        })
        await expect(
          propose('crm.log_outreach_sent', {
            organizationId: outsider,
            contactId: outsiderContact.id,
            gmailMessageId,
            mailbox: 'sender@example.com',
            sentAt: '2026-08-01T10:00:00.000Z',
          }),
        ).rejects.toMatchObject({ code: 'RECEIPT_CONFLICT' })
      })

      it('auto path applies; a message logged meanwhile makes the proposal STALE', async () => {
        const gmailMessageId = `gmail-${randomUUID()}`
        const args = {
          organizationId,
          contactId,
          gmailMessageId,
          sentAt: '2026-09-02T15:00:00.000Z',
        }
        const first = await propose('crm.log_outreach_sent', args)
        const auto = await withAuto('crm:log', () =>
          propose('crm.log_outreach_sent', args, randomUUID()),
        )
        expect(auto.status).toBe('APPLIED')
        expect((await approve(first)).status).toBe('STALE')
      })

      it('refuses a contact from another organization as NOT_FOUND', async () => {
        await expect(
          propose('crm.log_outreach_sent', {
            organizationId: otherOrganizationId,
            contactId,
            gmailMessageId: 'x',
            sentAt: '2026-09-02T15:00:00.000Z',
          }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      })
    })

    describe('crm.propose_outreach_draft', () => {
      it('ask path saves a draft for review, applies once, and revert discards it', async () => {
        const args = {
          campaignMemberId: memberId,
          subject: 'Hello from Example',
          textBody: 'A short note.',
        }
        const operationId = randomUUID()
        const view = await propose('crm.propose_outreach_draft', args, operationId)
        expect(view.status).toBe('PENDING')
        expect(await db.prospectOutreachDraft.count({ where: { memberId } })).toBe(0)
        expect((await propose('crm.propose_outreach_draft', args, operationId)).proposalId).toBe(
          view.proposalId,
        )
        await Promise.all([approve(view), approve(view)])
        const drafts = await db.prospectOutreachDraft.findMany({ where: { memberId } })
        expect(drafts).toHaveLength(1)
        expect(drafts[0]).toMatchObject({ status: 'NEEDS_REVIEW', generatedById: 'user_owner' })
        // Logging a send never stages a batch: the count is whatever other suites left, unchanged.
        expect(await db.prospectSendBatch.count()).toBe(sendBatchesAtStart)
        const reverted = await revert(view.proposalId)
        expect(reverted.status).toBe('APPLIED')
        expect(
          (await db.prospectOutreachDraft.findUnique({ where: { id: drafts[0]!.id } }))?.status,
        ).toBe('REJECTED')
      })

      it('auto path applies; a newer draft made meanwhile goes STALE', async () => {
        const before = await propose('crm.propose_outreach_draft', {
          campaignMemberId: memberId,
          subject: 'First idea',
          textBody: 'Body one.',
        })
        const auto = await withAuto('crm:propose', () =>
          propose('crm.propose_outreach_draft', {
            campaignMemberId: memberId,
            subject: 'Second idea',
            textBody: 'Body two.',
          }),
        )
        expect(auto.status).toBe('APPLIED')
        expect((await approve(before)).status).toBe('STALE')
      })

      it('reverting a draft that was already reviewed is refused as STALE', async () => {
        const view = await propose('crm.propose_outreach_draft', {
          campaignMemberId: memberId,
          subject: 'Third idea',
          textBody: 'Body three.',
        })
        await approve(view)
        const row = await db.operatorProposal.findUnique({ where: { id: view.proposalId } })
        await db.prospectOutreachDraft.update({
          where: { id: (row!.afterSnapshot as { draftId: string }).draftId },
          data: { status: 'SUPERSEDED' },
        })
        expect((await revert(view.proposalId)).status).toBe('STALE')
      })
    })

    describe('venues.propose_create', () => {
      it('ask path creates an inactive draft venue once; revert keeps it archived', async () => {
        const slug = `draft-${randomUUID().slice(0, 8)}`
        const args = { tenantId, name: 'Example Draft', slug, city: 'Springfield', region: 'IL' }
        const operationId = randomUUID()
        const view = await propose('venues.propose_create', args, operationId)
        expect(view.status).toBe('PENDING')
        expect((await propose('venues.propose_create', args, operationId)).proposalId).toBe(
          view.proposalId,
        )
        await Promise.all([approve(view), approve(view)])
        const venues = await db.venue.findMany({ where: { tenantId, slug } })
        expect(venues).toHaveLength(1)
        expect(venues[0]).toMatchObject({
          isActive: false,
          guideNotes: 'Located in Springfield, IL.',
        })
        const applied = await db.operatorProposal.findUnique({ where: { id: view.proposalId } })
        expect(applied?.status).toBe('APPLIED')
        expect((await revert(view.proposalId)).status).toBe('APPLIED')
        expect((await venueRow(venues[0]!.id)).isActive).toBe(false)
      })

      it('auto path applies; a slug taken meanwhile goes STALE', async () => {
        const slug = `race-${randomUUID().slice(0, 8)}`
        const pending = await propose('venues.propose_create', {
          tenantId,
          name: 'Example Race',
          slug,
        })
        const auto = await withAuto('venues:propose', () =>
          propose('venues.propose_create', { tenantId, name: 'Someone Else', slug }),
        )
        expect(auto.status).toBe('APPLIED')
        expect((await approve(pending)).status).toBe('STALE')
      })

      it('a tenant outside the grant is NOT_FOUND', async () => {
        await expect(
          propose('venues.propose_create', { tenantId: 'other-tenant', name: 'Nope' }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      })

      it('never adopts or deactivates a live venue that already holds the slug', async () => {
        const slug = `live-${randomUUID().slice(0, 8)}`
        const human = { type: 'HUMAN', id: 'user_owner', role: 'OWNER' } as const
        // A pre-existing, active, content-empty venue with exactly the name and slug the operator
        // will ask for: the case the old name-and-slug "replay" match would deactivate.
        const live = await createVenueAction({
          tenantId,
          actor: human,
          name: 'Example Live',
          baseSlug: slug,
          callerSuppliedSlug: true,
          guideMode: 'non_location',
        })
        const before = await venueRow(live.record.id)
        const pending = await propose('venues.propose_create', {
          tenantId,
          name: 'Example Live',
          slug,
        })
        const applied = await approve(pending)
        // The slug conflict is the target having changed; nothing was created or altered.
        expect(applied.status).toBe('STALE')
        const after = await venueRow(live.record.id)
        expect(after.isActive).toBe(true)
        expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime())
        expect(await db.venue.count({ where: { tenantId, slug } })).toBe(1)
      })

      it('creates inactive in one commit; the operation key proves a retry and legacy callers stay active', async () => {
        const human = { type: 'HUMAN', id: 'user_owner', role: 'OWNER' } as const
        const slug = `once-${randomUUID().slice(0, 8)}`
        const operationKey = randomUUID()
        const input = {
          tenantId,
          actor: human,
          name: 'Example Once',
          baseSlug: slug,
          callerSuppliedSlug: true,
          guideMode: 'non_location',
          initiallyActive: false,
          operationKey,
        } as const
        const first = await createVenueAction(input)
        expect(first.replayed).toBe(false)
        expect(first.record.isActive).toBe(false)
        // Someone publishes it; a retry must return it as it is now, not turn it back off.
        await db.venue.update({
          where: { id: first.record.id, tenantId },
          data: { isActive: true },
        })
        const retry = await createVenueAction(input)
        expect(retry.replayed).toBe(true)
        expect(retry.record.id).toBe(first.record.id)
        expect(retry.record.isActive).toBe(true)
        // The same key with different setup is a conflict, never a second venue.
        await expect(createVenueAction({ ...input, name: 'Different Name' })).rejects.toMatchObject(
          { code: 'CONFLICT' },
        )
        // A different key cannot adopt the existing venue by slug.
        await expect(
          createVenueAction({ ...input, operationKey: randomUUID() }),
        ).rejects.toMatchObject({ code: 'CONFLICT' })
        expect(await db.venue.count({ where: { tenantId, slug } })).toBe(1)
        // Legacy behavior is unchanged: no flag means active, and the same-slug match still replays.
        const legacySlug = `legacy-${randomUUID().slice(0, 8)}`
        const legacy = {
          tenantId,
          actor: human,
          name: 'Example Legacy',
          baseSlug: legacySlug,
          callerSuppliedSlug: true,
          guideMode: 'non_location',
        } as const
        const created = await createVenueAction(legacy)
        expect(created.record.isActive).toBe(true)
        expect((await createVenueAction(legacy)).replayed).toBe(true)
      })
    })

    describe('venues.propose_publish', () => {
      it('ask path publishes once, replays, and revert restores the previous availability', async () => {
        const venue = await newVenue(`pub-${randomUUID().slice(0, 8)}`)
        await withTenantIsolationBypass(() =>
          db.venue.updateMany({ where: { id: venue.id, tenantId }, data: { isActive: false } }),
        )
        const current = await venueRow(venue.id)
        const args = {
          tenantId,
          venueId: venue.id,
          expectedUpdatedAt: current.updatedAt.toISOString(),
        }
        const operationId = randomUUID()
        const view = await propose('venues.propose_publish', args, operationId)
        expect(view.status).toBe('PENDING')
        expect((await propose('venues.propose_publish', args, operationId)).proposalId).toBe(
          view.proposalId,
        )
        await Promise.all([approve(view), approve(view)])
        expect((await venueRow(venue.id)).isActive).toBe(true)
        expect(
          await withTenantIsolationBypass(() =>
            db.auditLog.count({
              where: { tenantId, targetId: venue.id, action: 'venue.availability.enabled' },
            }),
          ),
        ).toBe(1)
        expect((await revert(view.proposalId)).status).toBe('APPLIED')
        expect((await venueRow(venue.id)).isActive).toBe(false)
      })

      it('auto path applies; a venue changed meanwhile goes STALE', async () => {
        const venue = await newVenue(`pub-${randomUUID().slice(0, 8)}`)
        await withTenantIsolationBypass(() =>
          db.venue.updateMany({ where: { id: venue.id, tenantId }, data: { isActive: false } }),
        )
        const first = await venueRow(venue.id)
        const stale = await propose('venues.propose_publish', {
          tenantId,
          venueId: venue.id,
          expectedUpdatedAt: first.updatedAt.toISOString(),
        })
        await withTenantIsolationBypass(() =>
          db.venue.updateMany({
            where: { id: venue.id, tenantId },
            data: { description: 'changed' },
          }),
        )
        expect((await approve(stale)).status).toBe('STALE')
        const second = await venueRow(venue.id)
        const auto = await withAuto('venues:propose', () =>
          propose('venues.propose_publish', {
            tenantId,
            venueId: venue.id,
            expectedUpdatedAt: second.updatedAt.toISOString(),
          }),
        )
        expect(auto.status).toBe('APPLIED')
        expect((await venueRow(venue.id)).isActive).toBe(true)
      })
    })

    describe('venues.propose_knowledge', () => {
      const entries = (title: string) => [
        { title, body: 'Open daily.', category: 'Hours' },
        { title: `${title} two`, body: 'Free entry.' },
      ]

      it('ask path adds the entries once and replays', async () => {
        const title = `Hours ${randomUUID().slice(0, 6)}`
        const args = { tenantId, venueId, entries: entries(title) }
        const operationId = randomUUID()
        const view = await propose('venues.propose_knowledge', args, operationId)
        expect(view.status).toBe('PENDING')
        expect((await propose('venues.propose_knowledge', args, operationId)).proposalId).toBe(
          view.proposalId,
        )
        await Promise.all([approve(view), approve(view)])
        const rows = await db.venueKnowledgeEntry.findMany({
          where: { tenantId, venueId, title: { startsWith: title } },
          orderBy: { title: 'asc' },
        })
        expect(rows.map((row) => [row.title, row.category, row.isEnabled])).toEqual([
          [title, 'Hours', true],
          [`${title} two`, 'General', true],
        ])
        const row = await db.operatorProposal.findUnique({ where: { id: view.proposalId } })
        expect(row?.status).toBe('APPLIED')
      })

      it('auto path applies; a duplicate title added meanwhile goes STALE', async () => {
        const title = `Parking ${randomUUID().slice(0, 6)}`
        const pending = await propose('venues.propose_knowledge', {
          tenantId,
          venueId,
          entries: entries(title),
        })
        await db.venueKnowledgeEntry.create({
          data: { tenantId, venueId, title, category: 'Other', content: 'x', isEnabled: true },
        })
        expect((await approve(pending)).status).toBe('STALE')
        const auto = await withAuto('venues:propose', () =>
          propose('venues.propose_knowledge', {
            tenantId,
            venueId,
            entries: entries(`${title} fresh`),
          }),
        )
        expect(auto.status).toBe('APPLIED')
      })

      it('has no revert', async () => {
        const view = await propose('venues.propose_knowledge', {
          tenantId,
          venueId,
          entries: entries(`Once ${randomUUID().slice(0, 6)}`),
        })
        await approve(view)
        await expect(
          createRevertProposal(
            { proposalId: view.proposalId, operationId: randomUUID() },
            (raw) => raw as { proposalId: string; operationId: string },
            { config, database: db, grant, kinds, now: now(), requestId: randomUUID() },
          ),
        ).rejects.toMatchObject({ code: 'NOT_REVERTIBLE' })
      })
    })

    describe('plans', () => {
      it('applies create -> publish -> knowledge in order after one approval', async () => {
        const slug = `plan-${randomUUID().slice(0, 8)}`
        const plan = await createPlanVia([
          { tool: 'venues.propose_create', arguments: { tenantId, name: 'Example Plan', slug } },
          {
            tool: 'venues.propose_publish',
            arguments: {
              tenantId,
              venueId: '{{steps.0.result.venueId}}',
              expectedUpdatedAt: '{{steps.0.result.updatedAt}}',
            },
          },
          {
            tool: 'venues.propose_knowledge',
            arguments: {
              tenantId,
              venueId: '{{steps.0.result.venueId}}',
              entries: [{ title: 'Welcome', body: 'Hello there.' }],
            },
          },
        ])
        const result = await approveAndApplyPlan(
          {
            planId: plan.proposalId,
            argsHash: plan.argsHash,
            actorUserId: 'user_owner',
            requestId: randomUUID(),
            now: now(),
          },
          dependencies,
        )
        expect(result.status).toBe('APPLIED')
        const venue = await db.venue.findFirst({ where: { tenantId, slug } })
        expect(venue?.isActive).toBe(true)
        expect(
          await db.venueKnowledgeEntry.count({ where: { tenantId, venueId: venue!.id } }),
        ).toBe(1)
      })

      it('stops at the failing second step and never runs the third', async () => {
        const slug = `plan-${randomUUID().slice(0, 8)}`
        const plan = await createPlanVia([
          { tool: 'venues.propose_create', arguments: { tenantId, name: 'Example Stop', slug } },
          {
            tool: 'venues.propose_publish',
            arguments: {
              tenantId,
              venueId: '{{steps.0.result.venueId}}',
              expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
            },
          },
          {
            tool: 'venues.propose_knowledge',
            arguments: {
              tenantId,
              venueId: '{{steps.0.result.venueId}}',
              entries: [{ title: 'Never', body: 'Should not exist.' }],
            },
          },
        ])
        const result = await approveAndApplyPlan(
          {
            planId: plan.proposalId,
            argsHash: plan.argsHash,
            actorUserId: 'user_owner',
            requestId: randomUUID(),
            now: now(),
          },
          dependencies,
        )
        expect(result.status).toBe('FAILED')
        expect(result.failedStepIndex).toBe(1)
        const steps = await db.operatorProposal.findMany({
          where: { planId: plan.proposalId },
          orderBy: { planStepIndex: 'asc' },
        })
        expect(steps.map((step) => step.status)).toEqual(['APPLIED', 'STALE', 'REJECTED'])
        expect(steps[2]?.applyClaimedAt).toBeNull()
        const venue = await db.venue.findFirst({ where: { tenantId, slug } })
        expect(venue?.isActive).toBe(false)
        expect(
          await db.venueKnowledgeEntry.count({ where: { tenantId, venueId: venue!.id } }),
        ).toBe(0)
      })

      it('stops a CRM plan at a stale second step', async () => {
        const id = await newOrganization()
        const version = await opportunityVersion(id)
        const plan = await createPlanVia([
          {
            tool: 'crm.propose_stage_change',
            arguments: { organizationId: id, expectedVersion: version, stage: 'RESEARCHED' },
          },
          {
            tool: 'crm.propose_stage_change',
            arguments: { organizationId: id, expectedVersion: version, stage: 'NEEDS_REVIEW' },
          },
          {
            tool: 'crm.log_outreach_sent',
            arguments: {
              organizationId,
              contactId,
              gmailMessageId: `gmail-${randomUUID()}`,
              sentAt: '2026-09-03T15:00:00.000Z',
            },
          },
        ])
        const result = await approveAndApplyPlan(
          {
            planId: plan.proposalId,
            argsHash: plan.argsHash,
            actorUserId: 'user_owner',
            requestId: randomUUID(),
            now: now(),
          },
          dependencies,
        )
        expect(result.failedStepIndex).toBe(1)
        const steps = await db.operatorProposal.findMany({
          where: { planId: plan.proposalId },
          orderBy: { planStepIndex: 'asc' },
        })
        expect(steps.map((step) => step.status)).toEqual(['APPLIED', 'STALE', 'REJECTED'])
      })
    })
  },
)

async function createPlanVia(steps: Array<{ tool: string; arguments: Record<string, unknown> }>) {
  const { createPlan } = await import('../plans')
  return createPlan(
    { operationId: randomUUID(), title: 'Example plan', steps },
    { config, database: db, grant, kinds, now: now(), requestId: randomUUID() },
  )
}
