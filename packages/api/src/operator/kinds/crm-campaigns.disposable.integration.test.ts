/* eslint-disable @typescript-eslint/no-explicit-any -- test helper returns loosely typed parsed output */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  OPERATOR_MCP_OUTPUTS,
  OperatorCapability,
  type OperatorReadToolName,
} from '@pathfinder/contracts/operator-mcp'
import {
  createProspectAction,
  db,
  reviewProspectContactReadinessAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { resolveAutonomy } from '../autonomy'
import { resolveOperatorConfig } from '../config'
import type { VerifiedOperatorGrant } from '../oauth'
import { approveAndApplyProposal, createKindRegistry, createProposal } from '../proposals'
import { createOperatorRegistry, defaultVenueRead } from '../registry'
import { OPERATOR_PROPOSAL_KINDS } from './index'

/**
 * Campaign preparation on a real disposable PostgreSQL: create, add members, review drafts, stage
 * and approve a batch, and the gated release. Nothing here sends mail: there is no worker, and the
 * release adapter is exercised only against a disposable database. Invented names only.
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
const clientId = `opc_camp_${suffix}`
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
const propose = (tool: string, args: Record<string, unknown>) =>
  createProposal(tool, { ...args, operationId: randomUUID() }, service())
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
const row = (id: string) => db.operatorProposal.findUniqueOrThrow({ where: { id } })
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

/** An account with one contact: verified for sending, only unverified, or suppressed. */
async function prospect(kind: 'verified' | 'unverified' | 'suppressed') {
  const tag = `${kind}-${randomUUID().slice(0, 8)}`
  const created = await withTenantIsolationBypass(() =>
    createProspectAction({
      organization: { canonicalName: `Campaign Park ${tag}`, source: 'disposable-test' },
      venue: { name: `Campaign Park ${tag}`, city: 'Springfield', region: 'IL' },
      contact: {
        fullName: 'Casey Example',
        email: `casey-${tag}@example.test`,
        source: 'disposable-test',
      },
      actor: admin,
    }),
  )
  if (kind === 'verified') {
    await reviewProspectContactReadinessAction({
      contactId: created.contact!.id,
      emailReadiness: 'VALID',
      permissionState: 'LEGITIMATE_INTEREST_RECORDED',
      evidence: {
        reviewReason: 'Disposable fixture reviewed for internal testing',
        source: 'test',
      },
      actor: admin,
    })
  }
  if (kind === 'suppressed') {
    await db.prospectContact.update({
      where: { id: created.contact!.id },
      data: { suppressedAt: new Date() },
    })
  }
  return {
    organizationId: created.organization.id,
    contactId: created.contact!.id,
    email: created.contact!.email!,
  }
}

describe.skipIf(!enabled)(
  'operator campaign preparation on disposable PostgreSQL',
  { timeout: 180_000 },
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
      delete process.env.OPERATOR_CAMPAIGN_RELEASE_ENABLED
      await db.prospectDeliveryControl.updateMany({
        where: { id: 'global' },
        data: { deliveryEnabled: false },
      })
      await withTenantIsolationBypass(() => db.$disconnect())
    })

    let campaignId = ''
    let verified: Awaited<ReturnType<typeof prospect>>
    let unverified: Awaited<ReturnType<typeof prospect>>
    let suppressed: Awaited<ReturnType<typeof prospect>>

    it('creates a campaign from accounts and reports who may be drafted to and who may be emailed', async () => {
      verified = await prospect('verified')
      unverified = await prospect('unverified')
      suppressed = await prospect('suppressed')
      const view = await propose('crm.propose_campaign_create', {
        name: `Example campaign ${suffix}`,
        organizationIds: [
          verified.organizationId,
          unverified.organizationId,
          suppressed.organizationId,
        ],
      })
      // Creating a campaign is internal-only, but an old broad AUTO switch still never covers it.
      expect(view.status).toBe('PENDING')
      expect((await approve(view)).status).toBe('APPLIED')
      campaignId = ((await row(view.proposalId)).result as any).campaignId

      const campaign = await read('crm.get_campaign', { campaignId })
      expect(campaign.members).toMatchObject({ total: 3, byStatus: { SELECTED: 2, SUPPRESSED: 1 } })
      expect(campaign.releasePolicy).toMatchObject({
        maxRecipients: 50,
        promotion: 'NOT_AUTHORIZED',
      })
      // Off unless a deployment turns it on, and delivery is a separate global control.
      expect(campaign.releaseAdapterEnabled).toBe(false)

      const members = await read('crm.list_campaign_members', { campaignId })
      const byOrg = Object.fromEntries(
        members.items.map((item: any) => [item.organizationId, item]),
      )
      expect(byOrg[verified.organizationId]).toMatchObject({
        eligibleToDraft: true,
        eligibleToEmail: true,
      })
      // Drafting is fine before verification; emailing is not.
      expect(byOrg[unverified.organizationId]).toMatchObject({
        eligibleToDraft: true,
        eligibleToEmail: false,
        eligibilityReasons: ['not_verified'],
      })
      expect(byOrg[suppressed.organizationId]).toMatchObject({
        eligibleToDraft: false,
        eligibleToEmail: false,
      })
      // Canonical campaign creation selects no contact when none may be written to.
      expect(byOrg[suppressed.organizationId].eligibilityReasons).toEqual(['no_contact_selected'])
    })

    it('adds a member to an existing campaign: a named contact stays selected, and a replay returns the same member', async () => {
      const extra = await prospect('verified')
      const second = await db.prospectContact.create({
        data: {
          organizationId: extra.organizationId,
          fullName: 'Second Person',
          email: `second-${suffix}@example.test`,
          normalizedEmail: `second-${suffix}@example.test`,
          emailReadiness: 'VALID',
          permissionState: 'LEGITIMATE_INTEREST_RECORDED',
          createdBy: 'seed',
          updatedBy: 'seed',
        },
      })
      const named = await propose('crm.propose_campaign_membership', {
        campaignId,
        organizationId: extra.organizationId,
        contactId: second.id,
      })
      expect((await approve(named)).status).toBe('APPLIED')
      const member = await db.prospectCampaignMember.findFirstOrThrow({
        where: { campaignId, organizationId: extra.organizationId },
      })
      // Not the first contact by order, but the one the user chose.
      expect(member).toMatchObject({ contactId: second.id, status: 'SELECTED' })
      // The same account and contact again adds nothing.
      const again = await propose('crm.propose_campaign_membership', {
        campaignId,
        organizationId: extra.organizationId,
        contactId: second.id,
      })
      await approve(again)
      expect(
        await db.prospectCampaignMember.count({
          where: { campaignId, organizationId: extra.organizationId },
        }),
      ).toBe(1)
      // A contact that belongs to another account is not found, not silently substituted.
      await expect(
        propose('crm.propose_campaign_membership', {
          campaignId,
          organizationId: extra.organizationId,
          contactId: verified.contactId,
        }),
      ).resolves.toBeTruthy()
      const wrong = await db.operatorProposal.findFirstOrThrow({
        where: { tool: 'crm.propose_campaign_membership' },
        orderBy: { createdAt: 'desc' },
      })
      expect((await approve({ proposalId: wrong.id, argsHash: wrong.argsHash })).status).toBe(
        'FAILED',
      )
      expect(
        await db.prospectCampaignMember.count({
          where: { campaignId, contactId: verified.contactId },
        }),
      ).toBe(1)
    })

    let draftId = ''
    let draftHash = ''

    it('reviews a draft bound to its content hash and every escalation flag, and approving sends nothing', async () => {
      const member = await db.prospectCampaignMember.findFirstOrThrow({
        where: { campaignId, organizationId: verified.organizationId },
      })
      const drafted = await propose('crm.propose_outreach_draft', {
        campaignMemberId: member.id,
        subject: 'Torchiko for your visitors',
        textBody: 'Happy to explain. Pricing for a venue like yours could be $25 per month.',
      })
      expect((await approve(drafted)).status).toBe('APPLIED')
      const drafts = await read('crm.list_drafts', { campaignId, status: 'NEEDS_REVIEW' })
      expect(drafts.items).toHaveLength(1)
      const draft = drafts.items[0]
      draftId = draft.draftId
      draftHash = draft.contentHash
      expect(draft).toMatchObject({
        status: 'NEEDS_REVIEW',
        escalationFlags: ['pricing'],
        recipient: verified.email,
        eligibleToEmail: true,
      })
      expect(draft.body.text).toContain('$25 per month')

      // The flag must be acknowledged by name: refused when the proposal is made.
      await expect(
        propose('crm.propose_draft_review', {
          draftId,
          expectedContentHash: draftHash,
          approve: true,
        }),
      ).rejects.toMatchObject({ code: 'ESCALATION_UNACKNOWLEDGED' })
      // A hash that is not this draft's is refused outright.
      await expect(
        propose('crm.propose_draft_review', {
          draftId,
          expectedContentHash: 'f'.repeat(64),
          approve: true,
          acknowledgedEscalations: ['pricing'],
        }),
      ).rejects.toMatchObject({ code: 'CONTENT_CHANGED' })
      // Review is always a person's decision, whatever an old AUTO switch says.
      expect(await resolveAutonomy({ kind: 'crm.draft-review', capability: 'crm:propose' })).toBe(
        'ask',
      )
      const review = await propose('crm.propose_draft_review', {
        draftId,
        expectedContentHash: draftHash,
        approve: true,
        acknowledgedEscalations: ['pricing'],
      })
      expect(review.status).toBe('PENDING')
      expect((await approve(review)).status).toBe('APPLIED')
      expect(
        (await db.prospectOutreachDraft.findUniqueOrThrow({ where: { id: draftId } })).status,
      ).toBe('APPROVED')
      // Approving a draft stages, queues and sends nothing.
      expect(await db.prospectSendBatch.count({ where: { campaignId } })).toBe(0)
      expect(
        await db.prospectEmailMessage.count({ where: { organizationId: verified.organizationId } }),
      ).toBe(0)
    })

    it('a newer draft version makes an old review stale instead of approving changed content', async () => {
      const member = await db.prospectCampaignMember.findFirstOrThrow({
        where: { campaignId, organizationId: unverified.organizationId },
      })
      const first = await propose('crm.propose_outreach_draft', {
        campaignMemberId: member.id,
        subject: 'First version',
        textBody: 'A short note about Torchiko.',
      })
      await approve(first)
      const oldDraft = (await read('crm.list_drafts', { memberId: member.id })).items[0]
      const review = await propose('crm.propose_draft_review', {
        draftId: oldDraft.draftId,
        expectedContentHash: oldDraft.contentHash,
        approve: true,
      })
      // Meanwhile the draft is rewritten: the old version is superseded.
      const second = await propose('crm.propose_outreach_draft', {
        campaignMemberId: member.id,
        subject: 'Second version',
        textBody: 'A different short note about Torchiko.',
      })
      await approve(second)
      expect((await approve(review)).status).toBe('STALE')
      expect(
        (await db.prospectOutreachDraft.findUniqueOrThrow({ where: { id: oldDraft.draftId } }))
          .status,
      ).toBe('SUPERSEDED')
    })

    let batchId = ''
    let snapshotHash = ''

    it('stages exactly the approved draft, refuses an unverified recipient, and previews eligibility now', async () => {
      // An approved draft for an unverified contact cannot be staged: the shared rule refuses it.
      const unverifiedDraft = (
        await read('crm.list_drafts', { organizationId: unverified.organizationId })
      ).items.find((item: any) => item.status === 'NEEDS_REVIEW')
      await db.prospectOutreachDraft.update({
        where: { id: unverifiedDraft.draftId },
        data: { status: 'APPROVED', approvedBy: 'seed', approvedAt: new Date() },
      })
      const refused = await propose('crm.propose_batch_stage', {
        campaignId,
        drafts: [
          { draftId: unverifiedDraft.draftId, expectedContentHash: unverifiedDraft.contentHash },
        ],
      })
      const refusedResult = await approve(refused)
      expect(refusedResult).toMatchObject({ status: 'FAILED', failureCode: 'SUPPRESSED' })
      expect(refusedResult.applyStartedAt).toBeNull()
      expect(await db.prospectSendBatch.count({ where: { campaignId } })).toBe(0)

      const stage = await propose('crm.propose_batch_stage', {
        campaignId,
        drafts: [{ draftId, expectedContentHash: draftHash }],
      })
      expect(stage.status).toBe('PENDING')
      expect((await approve(stage)).status).toBe('APPLIED')
      const result = (await row(stage.proposalId)).result as any
      batchId = result.batchId
      snapshotHash = result.snapshotHash

      const preview = await read('crm.get_outreach_batch', { batchId })
      expect(preview.batch).toMatchObject({ status: 'STAGED', recipientCount: 1, snapshotHash })
      expect(preview.withinReleasePolicy).toBe(true)
      expect(preview.items).toHaveLength(1)
      expect(preview.items[0]).toMatchObject({
        draftId,
        contentHash: draftHash,
        recipient: verified.email,
        eligibleNow: true,
      })

      // Eligibility is read live: a decline after staging shows on the very next read.
      await db.prospectContact.update({
        where: { id: verified.contactId },
        data: { unsubscribedAt: new Date() },
      })
      const later = await read('crm.get_outreach_batch', { batchId })
      expect(later.items[0]).toMatchObject({ eligibleNow: false, recipient: null })
      expect(later.items[0].reasons).toContain('unsubscribed')
      await db.prospectContact.update({
        where: { id: verified.contactId },
        data: { unsubscribedAt: null },
      })

      // Fifty-one drafts never reach staging, whatever the canary changes later.
      await expect(
        propose('crm.propose_batch_stage', {
          campaignId,
          drafts: Array.from({ length: 51 }, () => ({ draftId, expectedContentHash: draftHash })),
        }),
      ).rejects.toThrow()
    })

    it('approves a batch only for the exact snapshot that was shown', async () => {
      await expect(
        propose('crm.propose_batch_approve', {
          batchId,
          expectedRecipientCount: 1,
          expectedSnapshotHash: 'e'.repeat(64),
        }),
      ).rejects.toMatchObject({ code: 'CONTENT_CHANGED' })
      const view = await propose('crm.propose_batch_approve', {
        batchId,
        expectedRecipientCount: 1,
        expectedSnapshotHash: snapshotHash,
      })
      expect(view.status).toBe('PENDING')
      expect((await approve(view)).status).toBe('APPLIED')
      expect(
        (await db.prospectSendBatch.findUniqueOrThrow({ where: { id: batchId } })).status,
      ).toBe('APPROVED')
      // Approved, and still not sent: no outbox operation exists.
      expect(await db.prospectSendOutbox.count({ where: { sendItem: { batchId } } })).toBe(0)
    })

    it('keeps the release adapter dark by default, and even when on it only queues through the canonical gates', async () => {
      const args = {
        batchId,
        providerAccountId: 'whatever',
        expectedRecipientCount: 1,
        expectedSnapshotHash: snapshotHash,
      }
      delete process.env.OPERATOR_CAMPAIGN_RELEASE_ENABLED
      await expect(propose('crm.propose_batch_release', args)).rejects.toMatchObject({
        code: 'RELEASE_DISABLED',
      })

      process.env.OPERATOR_CAMPAIGN_RELEASE_ENABLED = 'true'
      // On, but the canonical release still refuses: delivery is globally disabled.
      const mailbox = {
        provider: 'GMAIL' as const,
        mailboxAddress: 'tomschoenekase@torchiko.com',
        capabilities: ['SEND' as const],
        connectionStatus: 'CONNECTED' as const,
        deliveryEnabled: true,
        dailySendCap: 10,
        perDomainDailyCap: 2,
        minimumDelaySeconds: 0,
        jitterSeconds: 0,
        updatedBy: 'seed',
      }
      // The company mailbox address is unique: reuse a fixture left by an earlier run.
      const existingAccount = await db.correspondenceProviderAccount.findFirst({
        where: { mailboxAddress: mailbox.mailboxAddress },
      })
      const account = existingAccount
        ? await db.correspondenceProviderAccount.update({
            where: { id: existingAccount.id },
            data: { ...mailbox, pausedAt: null },
          })
        : await db.correspondenceProviderAccount.create({
            data: {
              ...mailbox,
              externalAccountId: `disposable-gmail-${suffix}`,
              credentialReferenceId: `fake-credential-reference-${suffix}`,
              createdBy: 'seed',
            },
          })
      const real = { ...args, providerAccountId: account.id }
      await db.prospectDeliveryControl.upsert({
        where: { id: 'global' },
        create: { id: 'global', deliveryEnabled: false },
        update: { deliveryEnabled: false },
      })
      const blocked = await propose('crm.propose_batch_release', real)
      expect(blocked.status).toBe('PENDING')
      const blockedResult = await approve(blocked)
      expect(blockedResult).toMatchObject({ status: 'FAILED', failureCode: 'APPROVAL_REQUIRED' })
      expect(blockedResult.applyStartedAt).toBeNull()
      expect(await db.prospectSendOutbox.count({ where: { sendItem: { batchId } } })).toBe(0)

      // The flag is checked again at dispatch: turned off after approval, nothing is queued.
      const late = await propose('crm.propose_batch_release', real)
      delete process.env.OPERATOR_CAMPAIGN_RELEASE_ENABLED
      const lateResult = await approve(late)
      expect(lateResult).toMatchObject({ status: 'FAILED', failureCode: 'RELEASE_DISABLED' })
      expect(await db.prospectSendOutbox.count({ where: { sendItem: { batchId } } })).toBe(0)

      // Every gate satisfied (flag, delivery control, mailbox, allowlist): operations are queued,
      // and there is still no worker, so nothing leaves the database.
      process.env.OPERATOR_CAMPAIGN_RELEASE_ENABLED = 'true'
      await db.prospectDeliveryControl.update({
        where: { id: 'global' },
        data: { deliveryEnabled: true, internalOnly: true, internalAllowlist: [verified.email] },
      })
      const open = await propose('crm.propose_batch_release', real)
      expect((await approve(open)).status).toBe('APPLIED')
      expect(
        (await db.prospectSendBatch.findUniqueOrThrow({ where: { id: batchId } })).status,
      ).toBe('QUEUED')
      expect(await db.prospectSendOutbox.count({ where: { sendItem: { batchId } } })).toBe(1)
      expect(
        await db.prospectEmailMessage.count({ where: { organizationId: verified.organizationId } }),
      ).toBe(0)
      // Releasing the same batch again is refused: it is no longer approved.
      const repeat = await propose('crm.propose_batch_release', real)
      expect((await approve(repeat)).status).toBe('STALE')
      expect(await db.prospectSendOutbox.count({ where: { sendItem: { batchId } } })).toBe(1)
    })
  },
)
