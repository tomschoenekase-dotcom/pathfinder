import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { OperatorCapability } from '@pathfinder/contracts/operator-mcp'
import { createVenueAction, db, withTenantIsolationBypass } from '@pathfinder/db'

import { resolveOperatorConfig } from './config'
import { decideRequest, requestDecision } from './decisions'
import {
  applyPendingWithJobGrant,
  claimJobGrantUse,
  createJobGrant,
  listJobGrants,
  OperatorJobGrantError,
  revokeJobGrant,
} from './job-grants'
import { appearanceUpdateKind, OPERATOR_PROPOSAL_KINDS } from './kinds'
import type { VerifiedOperatorGrant } from './oauth'
import {
  applyApprovedProposal,
  approveAndApplyProposal,
  createKindRegistry,
  createProposal,
  OperatorProposalError,
  type AnyOperatorProposalKind,
} from './proposals'
import { createOperatorRegistry, OperatorUnknownToolError } from './registry'

/**
 * Authenticated chat approvals (A25) and bounded job grants (A26) on a real disposable
 * PostgreSQL. Invented names and example domains only. Runs only against a database named
 * pathfinder_disposable_*.
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
const tenantId = `dg-tenant-${suffix}`
const otherTenantId = `dg-other-${suffix}`
const clientId = `opc_dg_${suffix}`
const otherClientId = `opc_dg_other_${suffix}`
const APPEARANCE_CAPABILITY = 'appearance:propose'

let grant: VerifiedOperatorGrant
let otherGrant: VerifiedOperatorGrant
let narrowGrant: VerifiedOperatorGrant
let originalAppearancePolicy: Awaited<ReturnType<typeof db.operatorAutonomyPolicy.findUnique>> =
  null
let appearancePolicySnapshotTaken = false
let venueId = ''
let secondVenueId = ''
let foreignVenueId = ''

async function makeGrant(forClient: string, tenantIds: string[]): Promise<VerifiedOperatorGrant> {
  const row = await db.operatorGrant.create({
    data: {
      clientId: forClient,
      userId: 'user_owner',
      allTenants: false,
      tenantIds,
      capabilities: [...OperatorCapability.options],
      resource: config.resource,
      scope: 'operator',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  })
  return {
    grantId: row.id,
    clientId: forClient,
    userId: 'user_owner',
    allTenants: false,
    tenantIds,
    capabilities: [...OperatorCapability.options],
  }
}

const service = (forGrant = grant, registryKinds = kinds) => ({
  config,
  database: db,
  grant: forGrant,
  kinds: registryKinds,
  now: new Date(),
  requestId: randomUUID(),
})

async function newVenue(forTenant: string, slug: string) {
  return (
    await withTenantIsolationBypass(() =>
      createVenueAction({
        tenantId: forTenant,
        actor: { type: 'HUMAN', id: 'user_owner', role: 'OWNER' },
        name: 'Example Garden',
        baseSlug: slug,
        callerSuppliedSlug: true,
        guideMode: 'non_location',
      }),
    )
  ).record
}

let titleCounter = 0
/** An appearance proposal at the venue's current version. */
async function proposeAppearance(
  forVenue = venueId,
  options: {
    grant?: VerifiedOperatorGrant
    tenant?: string
    kinds?: ReturnType<typeof createKindRegistry>
  } = {},
) {
  const tenant = options.tenant ?? tenantId
  const venue = await db.venue.findFirstOrThrow({
    where: { id: forVenue, tenantId: tenant },
    select: { updatedAt: true },
  })
  titleCounter += 1
  return createProposal(
    'appearance.propose_update',
    {
      tenantId: tenant,
      venueId: forVenue,
      operationId: randomUUID(),
      expectedUpdatedAt: venue.updatedAt.toISOString(),
      title: `Example ${suffix} ${titleCounter}`,
    },
    service(options.grant ?? grant, options.kinds ?? kinds),
  )
}

const venueTitle = async (forVenue = venueId) => {
  const row = await db.venue.findFirstOrThrow({
    where: { id: forVenue, tenantId },
    select: { chatAppearance: true, updatedAt: true },
  })
  return { appearance: JSON.stringify(row.chatAppearance), updatedAt: row.updatedAt.getTime() }
}

const proposalRow = (id: string) => db.operatorProposal.findUniqueOrThrow({ where: { id } })

const applyJob = (view: { proposalId: string; argsHash: string }, forKinds = kinds) =>
  applyPendingWithJobGrant(
    {
      proposalId: view.proposalId,
      argsHash: view.argsHash,
      actorUserId: 'user_owner',
      requestId: randomUUID(),
      now: new Date(),
    },
    { ...dependencies, kinds: forKinds },
  )

const owner = (
  extra: Partial<Parameters<typeof createJobGrant>[0]> = {},
): Parameters<typeof createJobGrant>[0] => ({
  name: 'Example weekly appearance job',
  clientId,
  tenantId,
  kinds: ['appearance.update'],
  maxExecutions: 2,
  actorUserId: 'user_owner',
  requestId: randomUUID(),
  now: new Date(),
  ...extra,
})

const decide = (
  decisionRequestId: string,
  argsHash: string,
  decision: 'approve' | 'reject',
  actorUserId = 'user_owner',
  now = new Date(),
) =>
  decideRequest(
    { decisionRequestId, argsHash, decision, actorUserId, requestId: randomUUID(), now },
    dependencies,
  )

const ask = (proposalId: string, forGrant = grant, now = new Date()) =>
  requestDecision(proposalId, {
    config,
    database: db,
    grant: forGrant,
    now,
    requestId: randomUUID(),
  })

describe.skipIf(!enabled)(
  'operator chat approvals and job grants on disposable PostgreSQL',
  { timeout: 120_000 },
  () => {
    beforeAll(async () => {
      await withTenantIsolationBypass(async () => {
        for (const id of [tenantId, otherTenantId]) {
          await db.tenant.create({ data: { id, name: `Example ${id}`, slug: id } })
        }
      })
      venueId = (await newVenue(tenantId, `example-a-${suffix}`)).id
      secondVenueId = (await newVenue(tenantId, `example-b-${suffix}`)).id
      foreignVenueId = (await newVenue(otherTenantId, `example-c-${suffix}`)).id
      for (const id of [clientId, otherClientId]) {
        await db.operatorOAuthClient.create({
          data: {
            id,
            clientName: 'Example connector',
            redirectUris: ['https://connector.example.com/cb'],
            registrationIpHash: 'a'.repeat(64),
            consentedAt: new Date(),
          },
        })
      }
      grant = await makeGrant(clientId, [tenantId, otherTenantId])
      otherGrant = await makeGrant(otherClientId, [tenantId, otherTenantId])
      narrowGrant = await makeGrant(clientId, [otherTenantId])
      // This suite needs pending proposals regardless of whether an earlier
      // suite left a policy row or the current missing-row default is AUTO.
      originalAppearancePolicy = await db.operatorAutonomyPolicy.findUnique({
        where: { capability: APPEARANCE_CAPABILITY },
      })
      appearancePolicySnapshotTaken = true
      await db.operatorAutonomyPolicy.upsert({
        where: { capability: APPEARANCE_CAPABILITY },
        create: {
          capability: APPEARANCE_CAPABILITY,
          mode: 'ASK',
          updatedByUserId: 'user_owner',
        },
        update: { mode: 'ASK' },
      })
    }, 90_000)

    afterAll(async () => {
      if (appearancePolicySnapshotTaken) {
        if (originalAppearancePolicy) {
          await db.operatorAutonomyPolicy.upsert({
            where: { capability: APPEARANCE_CAPABILITY },
            create: {
              capability: APPEARANCE_CAPABILITY,
              mode: originalAppearancePolicy.mode,
              allowedKinds: originalAppearancePolicy.allowedKinds,
              updatedByUserId: originalAppearancePolicy.updatedByUserId,
            },
            update: {
              mode: originalAppearancePolicy.mode,
              allowedKinds: originalAppearancePolicy.allowedKinds,
              updatedByUserId: originalAppearancePolicy.updatedByUserId,
            },
          })
        } else {
          await db.operatorAutonomyPolicy.deleteMany({
            where: { capability: APPEARANCE_CAPABILITY },
          })
        }
      }
      await withTenantIsolationBypass(() =>
        db.embeddingDispatch.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } }),
      )
      await db.$disconnect()
    }, 60_000)

    // -----------------------------------------------------------------------------------------
    // A25: authenticated chat approvals
    // -----------------------------------------------------------------------------------------
    describe('A25 decision requests', () => {
      it('the connection can only request: it records one open ticket, applies nothing, and repeating returns the same ticket', async () => {
        const before = await venueTitle()
        const view = await proposeAppearance()
        expect(view.status).toBe('PENDING')

        const first = await ask(view.proposalId)
        expect(first).toMatchObject({
          proposalId: view.proposalId,
          proposalStatus: 'PENDING',
          state: 'requested',
          decision: null,
        })
        expect(first.decisionUrl).toBe(
          `https://app.operator.test/approve/${view.proposalId}?request=${first.requestId}`,
        )
        const again = await ask(view.proposalId)
        expect(again.requestId).toBe(first.requestId)
        expect(
          await db.operatorDecisionRequest.count({ where: { proposalId: view.proposalId } }),
        ).toBe(1)
        // Nothing was approved or applied by asking.
        expect((await proposalRow(view.proposalId)).status).toBe('PENDING')
        expect(await venueTitle()).toEqual(before)
        const audit = await db.operatorAuditEvent.findMany({
          where: { proposalId: view.proposalId, eventType: 'decision.request' },
        })
        expect(audit.map((row) => row.outcome)).toEqual(['REQUESTED'])
        expect(audit[0]).toMatchObject({ actorUserId: null, grantId: grant.grantId })
        await db.operatorProposal.update({
          where: { id: view.proposalId },
          data: { status: 'REJECTED' },
        })
      })

      it('goes through the registry as a control tool; no tool exists that decides, mints or grants', async () => {
        const view = await proposeAppearance()
        const call = (name: string, args: unknown, forGrant = grant) =>
          registry.callTool(name, args, {
            config,
            database: db,
            grant: forGrant,
            now: new Date(),
            requestId: randomUUID(),
            venueRead: async () => {
              throw new Error('unused')
            },
          })
        const requested = (await call('operator.request_decision', {
          proposalId: view.proposalId,
        })) as { state: string; requestId: string }
        expect(requested.state).toBe('requested')
        // The model cannot smuggle a decision into the request.
        await expect(
          call('operator.request_decision', { proposalId: view.proposalId, decision: 'approve' }),
        ).rejects.toThrow()
        for (const forged of [
          'operator.decide',
          'operator.approve_decision',
          'operator.create_job_grant',
          'operator.revoke_job_grant',
          'operator.grant_job',
        ]) {
          await expect(call(forged, { id: requested.requestId })).rejects.toBeInstanceOf(
            OperatorUnknownToolError,
          )
        }
        expect(
          registry.listTools().filter((tool) => /decide|job_grant|grant_job/u.test(tool.name)),
        ).toEqual([])
        expect((await proposalRow(view.proposalId)).status).toBe('PENDING')
        await db.operatorProposal.update({
          where: { id: view.proposalId },
          data: { status: 'REJECTED' },
        })
      })

      it('another connection, or a tenant outside the grant, sees nothing', async () => {
        const view = await proposeAppearance()
        await expect(ask(view.proposalId, otherGrant)).rejects.toMatchObject({ code: 'NOT_FOUND' })
        // A different credential of the same connection (an unrelated grant row) is also a stranger.
        await expect(ask(view.proposalId, narrowGrant)).rejects.toMatchObject({ code: 'NOT_FOUND' })
        await expect(ask('does-not-exist')).rejects.toMatchObject({ code: 'NOT_FOUND' })
        expect(
          await db.operatorDecisionRequest.count({ where: { proposalId: view.proposalId } }),
        ).toBe(0)
        await db.operatorProposal.update({
          where: { id: view.proposalId },
          data: { status: 'REJECTED' },
        })
      })

      it('a person approves once: bound to the version, applied through the existing service, single use, audited', async () => {
        const before = await venueTitle()
        const view = await proposeAppearance()
        const ticket = await ask(view.proposalId)

        // Wrong role (not on the allowlist) and a stale page hash are refused and spend nothing.
        await expect(
          decide(ticket.requestId!, view.argsHash, 'approve', 'user_stranger'),
        ).rejects.toMatchObject({ code: 'FORBIDDEN_ACTOR' })
        await expect(decide(ticket.requestId!, 'f'.repeat(64), 'approve')).rejects.toMatchObject({
          code: 'ARGS_HASH_MISMATCH',
        })
        expect((await proposalRow(view.proposalId)).status).toBe('PENDING')
        expect(await venueTitle()).toEqual(before)

        const applied = await decide(ticket.requestId!, view.argsHash, 'approve')
        expect(applied).toMatchObject({
          status: 'APPLIED',
          decidedByUserId: 'user_owner',
          autoApproved: false,
        })
        expect(await venueTitle()).not.toEqual(before)
        const afterApply = await venueTitle()

        // Replay: refused, and nothing is applied again.
        await expect(decide(ticket.requestId!, view.argsHash, 'approve')).rejects.toMatchObject({
          code: 'REQUEST_USED',
        })
        await expect(decide(ticket.requestId!, view.argsHash, 'reject')).rejects.toMatchObject({
          code: 'REQUEST_USED',
        })
        expect(await venueTitle()).toEqual(afterApply)

        const row = await db.operatorDecisionRequest.findUniqueOrThrow({
          where: { id: ticket.requestId! },
        })
        expect(row).toMatchObject({
          status: 'DECIDED',
          decision: 'approve',
          decidedByUserId: 'user_owner',
          resultStatus: 'APPLIED',
        })
        // The chat renders the result by asking again.
        expect(await ask(view.proposalId)).toMatchObject({
          state: 'decided',
          decision: 'approve',
          proposalStatus: 'APPLIED',
          resultStatus: 'APPLIED',
        })
        const audit = await db.operatorAuditEvent.findMany({
          where: { proposalId: view.proposalId },
          orderBy: { occurredAt: 'asc' },
        })
        const outcomes = audit.map((entry) => `${entry.eventType}:${entry.outcome}`)
        expect(outcomes).toEqual(
          expect.arrayContaining([
            'decision.request:REQUESTED',
            'decision.request:DECIDED:approve',
            'proposal.transition:APPROVED',
            'proposal.transition:APPLIED',
          ]),
        )
        expect(audit.find((entry) => entry.outcome === 'DECIDED:approve')?.actorUserId).toBe(
          'user_owner',
        )
      })

      it('a person can reject, and a rejected proposal stays unapplied', async () => {
        const before = await venueTitle()
        const view = await proposeAppearance()
        const ticket = await ask(view.proposalId)
        const rejected = await decide(ticket.requestId!, view.argsHash, 'reject')
        expect(rejected).toMatchObject({ status: 'REJECTED', decidedByUserId: 'user_owner' })
        expect(await venueTitle()).toEqual(before)
        expect(await ask(view.proposalId)).toMatchObject({ state: 'decided', decision: 'reject' })
      })

      it('a changed proposal voids the ticket; a fresh request is bound to the new version', async () => {
        const before = await venueTitle()
        const view = await proposeAppearance()
        const ticket = await ask(view.proposalId)
        // The proposal's exact version moves (its target version changed).
        await db.operatorProposal.update({
          where: { id: view.proposalId },
          data: { targetVersion: new Date(0).toISOString() },
        })
        await expect(decide(ticket.requestId!, view.argsHash, 'approve')).rejects.toMatchObject({
          code: 'REQUEST_INVALIDATED',
        })
        expect(
          (await db.operatorDecisionRequest.findUniqueOrThrow({ where: { id: ticket.requestId! } }))
            .status,
        ).toBe('INVALIDATED')
        expect((await proposalRow(view.proposalId)).status).toBe('PENDING')
        expect(await venueTitle()).toEqual(before)
        // Asking again issues a new ticket for the current version.
        const fresh = await ask(view.proposalId)
        expect(fresh.requestId).not.toBe(ticket.requestId)
        expect(fresh.state).toBe('requested')
        // An argsHash change is refused the same way, via an outdated open ticket.
        await db.operatorProposal.update({
          where: { id: view.proposalId },
          data: { argsHash: 'e'.repeat(64) },
        })
        await expect(decide(fresh.requestId!, 'e'.repeat(64), 'approve')).rejects.toMatchObject({
          code: 'ARGS_HASH_MISMATCH',
        })
        await expect(decide(fresh.requestId!, view.argsHash, 'approve')).rejects.toMatchObject({
          code: 'REQUEST_INVALIDATED',
        })
        await db.operatorProposal.update({
          where: { id: view.proposalId },
          data: { status: 'REJECTED' },
        })
      })

      it('a proposal decided elsewhere voids its open ticket', async () => {
        const view = await proposeAppearance()
        const ticket = await ask(view.proposalId)
        await approveAndApplyProposal(
          {
            proposalId: view.proposalId,
            argsHash: view.argsHash,
            actorUserId: 'user_owner',
            requestId: randomUUID(),
            now: new Date(),
          },
          dependencies,
        )
        await expect(decide(ticket.requestId!, view.argsHash, 'approve')).rejects.toMatchObject({
          code: 'REQUEST_INVALIDATED',
        })
      })

      it('an expired ticket cannot be used; asking again issues a new one', async () => {
        const view = await proposeAppearance()
        const ticket = await ask(view.proposalId)
        const later = new Date(Date.now() + 11 * 60_000)
        await expect(
          decide(ticket.requestId!, view.argsHash, 'approve', 'user_owner', later),
        ).rejects.toMatchObject({
          code: 'REQUEST_EXPIRED',
        })
        expect(
          (await db.operatorDecisionRequest.findUniqueOrThrow({ where: { id: ticket.requestId! } }))
            .status,
        ).toBe('EXPIRED')
        expect((await proposalRow(view.proposalId)).status).toBe('PENDING')
        // Rendering an expired ticket reports it as expired; a new request replaces it.
        const fresh = await ask(view.proposalId)
        expect(fresh.requestId).not.toBe(ticket.requestId)
        await expect(decide(ticket.requestId!, view.argsHash, 'approve')).rejects.toMatchObject({
          code: 'REQUEST_EXPIRED',
        })
        await db.operatorProposal.update({
          where: { id: view.proposalId },
          data: { status: 'REJECTED' },
        })
      })

      it('two simultaneous decisions on one ticket: exactly one wins and the change applies once', async () => {
        const view = await proposeAppearance()
        const ticket = await ask(view.proposalId)
        const results = await Promise.allSettled([
          decide(ticket.requestId!, view.argsHash, 'approve'),
          decide(ticket.requestId!, view.argsHash, 'approve'),
          decide(ticket.requestId!, view.argsHash, 'reject'),
        ])
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        for (const result of results.filter((entry) => entry.status === 'rejected')) {
          expect((result as PromiseRejectedResult).reason).toBeInstanceOf(OperatorProposalError)
        }
        expect(
          await db.operatorAuditEvent.count({
            where: {
              proposalId: view.proposalId,
              eventType: 'decision.request',
              outcome: { startsWith: 'DECIDED' },
            },
          }),
        ).toBe(1)
      })

      it('plan steps and unknown tickets are refused', async () => {
        await expect(decide('missing', 'a'.repeat(64), 'approve')).rejects.toMatchObject({
          code: 'NOT_FOUND',
        })
      })
    })

    // -----------------------------------------------------------------------------------------
    // A26: bounded job grants
    // -----------------------------------------------------------------------------------------
    describe('A26 job grants', () => {
      it('creation is for an allowlisted person and for opted-in kinds only, within bounds', async () => {
        await expect(
          createJobGrant(owner({ actorUserId: 'user_stranger' }), dependencies),
        ).rejects.toMatchObject({ code: 'FORBIDDEN_ACTOR' })
        for (const kind of [
          'crm.stage-change',
          'customers.invite',
          'customers.create',
          'crm.batch-release',
          'reports.generate',
          'support.client-reply',
          'operator.revert',
          'appearance.future',
        ]) {
          await expect(
            createJobGrant(owner({ kinds: [kind] }), dependencies),
          ).rejects.toMatchObject({
            code: 'KIND_NOT_GRANTABLE',
          })
        }
        await expect(
          createJobGrant(owner({ maxAmountCents: 100 }), dependencies),
        ).rejects.toMatchObject({
          code: 'INVALID',
        })
        for (const bad of [
          { maxExecutions: 0 },
          { maxExecutions: 101 },
          { maxExecutions: 1.5 },
          { expiresInMinutes: 1 },
          { expiresInMinutes: 8 * 24 * 60 },
          { name: '   ' },
          { kinds: [] },
        ]) {
          await expect(createJobGrant(owner(bad), dependencies)).rejects.toBeInstanceOf(
            OperatorJobGrantError,
          )
        }
        await expect(
          createJobGrant(owner({ clientId: 'opc_missing' }), dependencies),
        ).rejects.toMatchObject({ code: 'CLIENT_NOT_FOUND' })
        await expect(
          createJobGrant(owner({ tenantId: 'missing-tenant' }), dependencies),
        ).rejects.toMatchObject({ code: 'SCOPE_NOT_FOUND' })
        // A venue of another tenant is not in this tenant.
        await expect(
          createJobGrant(owner({ venueId: foreignVenueId }), dependencies),
        ).rejects.toMatchObject({ code: 'SCOPE_NOT_FOUND' })
        expect(await db.operatorJobGrant.count({ where: { clientId } })).toBe(0)
      })

      it('MCP proposal creation never spends or applies a matching grant; a human may spend it within bounds', async () => {
        const job = await createJobGrant(owner({ venueId }), dependencies)
        // The short default expiry is applied when none is given.
        expect(job.expiresAt.getTime() - job.createdAt.getTime()).toBe(24 * 3_600_000)
        const before = await venueTitle()

        const version = await db.venue.findFirstOrThrow({
          where: { id: venueId, tenantId },
          select: { updatedAt: true },
        })
        const first = (await registry.callTool(
          'appearance.propose_update',
          {
            tenantId,
            venueId,
            operationId: randomUUID(),
            expectedUpdatedAt: version.updatedAt.toISOString(),
            title: `Example ${suffix} registry grant boundary`,
          },
          {
            config,
            database: db,
            grant,
            now: new Date(),
            requestId: randomUUID(),
            venueRead: async () => {
              throw new Error('unused')
            },
          },
        )) as Awaited<ReturnType<typeof proposeAppearance>>
        expect(first.status).toBe('PENDING')
        expect(await venueTitle()).toEqual(before)
        expect(
          (await db.operatorJobGrant.findUniqueOrThrow({ where: { id: job.id } }))
            .remainingExecutions,
        ).toBe(2)
        expect((await applyJob(first)).status).toBe('APPLIED')
        const row = await proposalRow(first.proposalId)
        expect(row).toMatchObject({
          jobGrantId: job.id,
          autoApproved: false,
          decidedByUserId: 'user_owner',
        })
        expect(await venueTitle()).not.toEqual(before)
        const used = await db.operatorAuditEvent.findMany({
          where: { proposalId: first.proposalId, outcome: 'JOB_GRANT_APPROVED' },
        })
        expect(used).toHaveLength(1)
        expect(used[0]!.redactedArgs).toMatchObject({ jobGrantId: job.id })

        const second = await proposeAppearance()
        expect(second.status).toBe('PENDING')
        expect((await applyJob(second)).status).toBe('APPLIED')
        expect(
          (await db.operatorJobGrant.findUniqueOrThrow({ where: { id: job.id } }))
            .remainingExecutions,
        ).toBe(0)

        // Exhausted: the proposal waits for a person, applies nothing, and a person can still approve it.
        const afterTwo = await venueTitle()
        const third = await proposeAppearance()
        expect(third.status).toBe('PENDING')
        await expect(applyJob(third)).rejects.toMatchObject({ code: 'NO_MATCHING_GRANT' })
        expect(await venueTitle()).toEqual(afterTwo)
        expect((await proposalRow(third.proposalId)).jobGrantId).toBeNull()
        const approved = await approveAndApplyProposal(
          {
            proposalId: third.proposalId,
            argsHash: third.argsHash,
            actorUserId: 'user_owner',
            requestId: randomUUID(),
            now: new Date(),
          },
          dependencies,
        )
        expect(approved).toMatchObject({ status: 'APPLIED', autoApproved: false, jobGrantId: null })
        expect(
          (await listJobGrants(new Date(), db)).find((entry) => entry.id === job.id)?.status,
        ).toBe('exhausted')
        await revokeJobGrant(
          { id: job.id, actorUserId: 'user_owner', requestId: randomUUID(), now: new Date() },
          dependencies,
        )
      })

      it('scope mismatch falls back: another venue, another tenant, another connection', async () => {
        const job = await createJobGrant(owner({ venueId, maxExecutions: 5 }), dependencies)
        // Another venue of the same tenant.
        await expect(applyJob(await proposeAppearance(secondVenueId))).rejects.toMatchObject({
          code: 'NO_MATCHING_GRANT',
        })
        // Another tenant.
        await expect(
          applyJob(await proposeAppearance(foreignVenueId, { tenant: otherTenantId })),
        ).rejects.toMatchObject({ code: 'NO_MATCHING_GRANT' })
        // Another connection (same tenant and venue).
        await expect(
          applyJob(await proposeAppearance(venueId, { grant: otherGrant })),
        ).rejects.toMatchObject({ code: 'NO_MATCHING_GRANT' })
        expect(
          (await db.operatorJobGrant.findUniqueOrThrow({ where: { id: job.id } }))
            .remainingExecutions,
        ).toBe(5)
        // The matching one still works.
        const matching = await proposeAppearance(venueId)
        expect(matching.status).toBe('PENDING')
        expect((await applyJob(matching)).status).toBe('APPLIED')
        await revokeJobGrant(
          { id: job.id, actorUserId: 'user_owner', requestId: randomUUID(), now: new Date() },
          dependencies,
        )
      })

      it('a tenant-wide grant covers every venue of that tenant only', async () => {
        const job = await createJobGrant(owner({ maxExecutions: 5 }), dependencies)
        const second = await proposeAppearance(secondVenueId)
        expect((await applyJob(second)).status).toBe('APPLIED')
        const first = await proposeAppearance(venueId)
        expect((await applyJob(first)).status).toBe('APPLIED')
        await expect(
          applyJob(await proposeAppearance(foreignVenueId, { tenant: otherTenantId })),
        ).rejects.toMatchObject({ code: 'NO_MATCHING_GRANT' })
        await revokeJobGrant(
          { id: job.id, actorUserId: 'user_owner', requestId: randomUUID(), now: new Date() },
          dependencies,
        )
      })

      it('revocation and expiry stop use at once, and revoking is idempotent and audited', async () => {
        const job = await createJobGrant(owner({ maxExecutions: 5 }), dependencies)
        await expect(
          revokeJobGrant(
            { id: job.id, actorUserId: 'user_stranger', requestId: randomUUID(), now: new Date() },
            dependencies,
          ),
        ).rejects.toMatchObject({ code: 'FORBIDDEN_ACTOR' })
        expect(
          (await db.operatorJobGrant.findUniqueOrThrow({ where: { id: job.id } })).revokedAt,
        ).toBeNull()
        const revoked = await revokeJobGrant(
          { id: job.id, actorUserId: 'user_owner', requestId: randomUUID(), now: new Date() },
          dependencies,
        )
        expect(revoked.revokedAt).not.toBeNull()
        await revokeJobGrant(
          { id: job.id, actorUserId: 'user_owner', requestId: randomUUID(), now: new Date() },
          dependencies,
        )
        expect(
          await db.operatorAuditEvent.count({
            where: {
              eventType: 'job_grant.change',
              outcome: 'REVOKED',
              redactedArgs: { path: ['jobGrantId'], equals: job.id },
            },
          }),
        ).toBe(1)
        await expect(
          revokeJobGrant(
            { id: 'missing', actorUserId: 'user_owner', requestId: randomUUID(), now: new Date() },
            dependencies,
          ),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' })
        const afterRevoke = await proposeAppearance()
        expect(afterRevoke.status).toBe('PENDING')

        // Expired: a grant that lapsed an hour ago.
        const past = new Date(Date.now() - 2 * 3_600_000)
        const lapsed = await createJobGrant(
          owner({ now: past, expiresInMinutes: 60, maxExecutions: 5 }),
          dependencies,
        )
        expect((await proposeAppearance()).status).toBe('PENDING')
        expect(
          (await db.operatorJobGrant.findUniqueOrThrow({ where: { id: lapsed.id } }))
            .remainingExecutions,
        ).toBe(5)
        expect(
          (await listJobGrants(new Date(), db)).find((entry) => entry.id === lapsed.id)?.status,
        ).toBe('expired')
      })

      it('the owner leaving the allowlist, or the connection being revoked, stops use', async () => {
        const job = await createJobGrant(owner({ maxExecutions: 5 }), dependencies)
        // The creator is no longer an approver: the grant is dead weight, not authority.
        const strangerOnly = {
          ...service(),
          config: { ...config, allowedUserIds: new Set(['user_someone_else']) },
        }
        const view = await createProposal(
          'appearance.propose_update',
          {
            tenantId,
            venueId,
            operationId: randomUUID(),
            expectedUpdatedAt: (
              await db.venue.findFirstOrThrow({
                where: { id: venueId, tenantId },
                select: { updatedAt: true },
              })
            ).updatedAt.toISOString(),
            title: `Example ${suffix} allowlist`,
          },
          strangerOnly,
        )
        expect(view.status).toBe('PENDING')
        expect(
          (await db.operatorJobGrant.findUniqueOrThrow({ where: { id: job.id } }))
            .remainingExecutions,
        ).toBe(5)
        await revokeJobGrant(
          { id: job.id, actorUserId: 'user_owner', requestId: randomUUID(), now: new Date() },
          dependencies,
        )
      })

      it('a grant revoked after it approved a proposal but before the write stops that write', async () => {
        const job = await createJobGrant(owner({ maxExecutions: 5 }), dependencies)
        const before = await venueTitle()
        // Make the proposal while no grant matches by revoking after creation: simulate the window
        // by approving it as the job-grant path would, then revoking before apply.
        await revokeJobGrant(
          { id: job.id, actorUserId: 'user_owner', requestId: randomUUID(), now: new Date() },
          dependencies,
        )
        const view = await proposeAppearance()
        expect(view.status).toBe('PENDING')
        await db.operatorProposal.update({
          where: { id: view.proposalId },
          data: {
            status: 'APPROVED',
            jobGrantId: job.id,
            autoApproved: true,
            decidedByUserId: 'user_owner',
            decidedAt: new Date(),
          },
        })
        const result = await applyApprovedProposal(
          view.proposalId,
          { actorUserId: 'user_owner', requestId: randomUUID(), now: new Date() },
          dependencies,
        )
        expect(result).toMatchObject({ status: 'FAILED', failureCode: 'JOB_GRANT_REVOKED' })
        expect(await venueTitle()).toEqual(before)
      })

      it('concurrent proposals can never spend more than the limit', async () => {
        const job = await createJobGrant(owner({ maxExecutions: 3 }), dependencies)
        const views = await Promise.all(Array.from({ length: 8 }, () => proposeAppearance(venueId)))
        expect(views).toHaveLength(8)
        expect(await db.operatorProposal.count({ where: { jobGrantId: job.id } })).toBe(0)
        await Promise.allSettled(views.map((view) => applyJob(view)))
        const used = await db.operatorProposal.count({ where: { jobGrantId: job.id } })
        expect(used).toBe(3)
        const stored = await db.operatorJobGrant.findUniqueOrThrow({ where: { id: job.id } })
        expect(stored.remainingExecutions).toBe(0)
        for (const view of views) {
          const row = await proposalRow(view.proposalId)
          // Everything not covered by the grant is waiting for a person.
          if (row.jobGrantId === null) expect(row.status).toBe('PENDING')
        }
        await revokeJobGrant(
          { id: job.id, actorUserId: 'user_owner', requestId: randomUUID(), now: new Date() },
          dependencies,
        )
      })

      it('an amount cap is enforced in the same update, and an over-budget use falls back without spending a use', async () => {
        const amountKind: AnyOperatorProposalKind = {
          ...appearanceUpdateKind,
          jobGrant: { amountCents: () => 40 },
        }
        const amountKinds = createKindRegistry([amountKind])
        const amountDeps = { ...dependencies, kinds: amountKinds }
        const job = await createJobGrant(
          owner({ maxExecutions: 5, maxAmountCents: 100 }),
          amountDeps,
        )
        const run = () => proposeAppearance(venueId, { kinds: amountKinds })
        expect((await applyJob(await run(), amountKinds)).status).toBe('APPLIED')
        expect((await applyJob(await run(), amountKinds)).status).toBe('APPLIED')
        // 80 of 100 spent: a third use of 40 does not fit.
        const third = await run()
        expect(third.status).toBe('PENDING')
        await expect(applyJob(third, amountKinds)).rejects.toMatchObject({
          code: 'NO_MATCHING_GRANT',
        })
        const stored = await db.operatorJobGrant.findUniqueOrThrow({ where: { id: job.id } })
        expect(stored).toMatchObject({ remainingExecutions: 3, remainingAmountCents: 20 })
        // A kind that returns nonsense never matches.
        const broken = createKindRegistry([
          { ...appearanceUpdateKind, jobGrant: { amountCents: () => -5 } },
        ])
        expect((await proposeAppearance(venueId, { kinds: broken })).status).toBe('PENDING')
        await revokeJobGrant(
          { id: job.id, actorUserId: 'user_owner', requestId: randomUUID(), now: new Date() },
          dependencies,
        )
      })

      it('a grant row naming a kind that never opted in cannot be spent (defence in depth)', async () => {
        const job = await db.operatorJobGrant.create({
          data: {
            name: 'Bad data',
            clientId,
            createdByUserId: 'user_owner',
            targetTenantId: tenantId,
            allowedKinds: ['crm.stage-change', 'customers.invite', 'venues.create'],
            maxExecutions: 3,
            remainingExecutions: 3,
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        })
        const stage = kinds.get('crm.propose_stage_change')!
        for (const kind of [
          stage,
          kinds.get('customers.propose_invite')!,
          kinds.get('venues.propose_create')!,
        ]) {
          expect(
            await claimJobGrantUse(db, {
              kind,
              args: {},
              clientId,
              tenantId,
              venueId: null,
              now: new Date(),
              allowedUserIds: config.allowedUserIds,
            }),
          ).toBeNull()
        }
        expect(
          (await db.operatorJobGrant.findUniqueOrThrow({ where: { id: job.id } }))
            .remainingExecutions,
        ).toBe(3)
        await db.operatorJobGrant.update({ where: { id: job.id }, data: { revokedAt: new Date() } })
      })

      it('the database refuses out-of-range bounds', async () => {
        await expect(
          db.operatorJobGrant.create({
            data: {
              name: 'Too big',
              clientId,
              createdByUserId: 'user_owner',
              targetTenantId: tenantId,
              allowedKinds: ['appearance.update'],
              maxExecutions: 5000,
              remainingExecutions: 5000,
              expiresAt: new Date(Date.now() + 3_600_000),
            },
          }),
        ).rejects.toThrow()
      })
    })
  },
)
