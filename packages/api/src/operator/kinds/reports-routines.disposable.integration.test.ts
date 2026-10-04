/* eslint-disable @typescript-eslint/no-explicit-any -- test helper returns loosely typed parsed output */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { OPERATOR_MCP_OUTPUTS, OperatorCapability } from '@pathfinder/contracts/operator-mcp'
import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { resolveOperatorConfig } from '../config'
import { OperatorNotFoundError } from '../grants'
import type { VerifiedOperatorGrant } from '../oauth'
import { approveAndApplyProposal, createKindRegistry, createProposal } from '../proposals'
import { createOperatorRegistry, defaultVenueRead } from '../registry'
import { OPERATOR_PROPOSAL_KINDS } from './index'

/**
 * Reports, routines, evidence and attention on a real disposable PostgreSQL. Invented names only.
 * Not run in the default test command: it needs RUN_OPERATOR_DB_INTEGRATION=1 and a database named
 * pathfinder_disposable_*, like the other operator integration tests.
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
const tenantId = `rr-tenant-${suffix}`
const otherTenantId = `rr-other-${suffix}`
const venueId = `rr-venue-${suffix}`
const clientId = `opc_rr_${suffix}`
const agentId = `rr-agent-${suffix}`
let grant: VerifiedOperatorGrant
let otherGrant: VerifiedOperatorGrant

const service = (forGrant = grant) => ({
  config,
  database: db,
  grant: forGrant,
  kinds,
  now: new Date(),
  requestId: randomUUID(),
})
const propose = (tool: string, args: Record<string, unknown>, forGrant = grant) =>
  createProposal(tool, { ...args, operationId: randomUUID() }, service(forGrant))
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
async function read(name: string, args: Record<string, unknown>, forGrant = grant) {
  const output = await registry.callTool(
    name,
    { tenantId, ...args },
    {
      config,
      database: db,
      grant: forGrant,
      now: new Date(),
      requestId: randomUUID(),
      venueRead: defaultVenueRead(db),
    },
  )
  return OPERATOR_MCP_OUTPUTS[name as keyof typeof OPERATOR_MCP_OUTPUTS].parse(output) as any
}

describe.skipIf(!enabled)(
  'operator reports, routines, evidence and attention on disposable PostgreSQL',
  { timeout: 120_000 },
  () => {
    beforeAll(async () => {
      await withTenantIsolationBypass(async () => {
        for (const id of [tenantId, otherTenantId]) {
          await db.tenant.create({ data: { id, name: `Example ${id}`, slug: id } })
        }
        await db.venue.create({
          data: { id: venueId, tenantId, name: 'Example Garden', slug: `rr-garden-${suffix}` },
        })
        await db.agentIdentity.create({
          data: {
            id: agentId,
            tenantId,
            venueId,
            identityKey: `rr-key-${suffix}`,
            name: 'Example monitor',
            agentType: 'monitor',
            accessScope: 'VENUE',
            enabled: true,
            createdBy: 'seed',
          },
        })
        await db.venueReportConfiguration.create({
          data: { tenantId, venueId, enabled: true, updatedBy: 'seed' },
        })
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
      const make = async (tenants: string[]) => {
        const row = await db.operatorGrant.create({
          data: {
            clientId,
            userId: 'user_owner',
            allTenants: false,
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
          userId: 'user_owner',
          allTenants: false,
          tenantIds: tenants,
          capabilities: [...OperatorCapability.options],
        } satisfies VerifiedOperatorGrant
      }
      grant = await make([tenantId])
      otherGrant = await make([otherTenantId])
    })

    afterAll(async () => {
      await withTenantIsolationBypass(() =>
        db.embeddingDispatch.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } }),
      )
      await db.$disconnect()
    })

    it('a routine is created disabled, enabled only by a person at the observed version, and disabled again', async () => {
      const created = await propose('routines.propose_create', {
        tenantId,
        venueId,
        routineKey: 'freshness-check',
        agentIdentityId: agentId,
        prompt: 'Check source freshness only.',
        intervalSeconds: 3600,
      })
      expect((await approve(created)).status).toBe('APPLIED')
      const routine = await withTenantIsolationBypass(() =>
        db.agentRoutine.findFirstOrThrow({ where: { tenantId, routineKey: 'freshness-check' } }),
      )
      expect(routine.enabled).toBe(false)
      expect(routine.nextRunAt).toBeNull()

      const status = await read('routines.get_run_status', { routineId: routine.id })
      expect(status).toMatchObject({ state: 'disabled', health: 'unknown', lastResult: null })

      const stale = await propose('routines.propose_enable', {
        tenantId,
        venueId,
        routineId: routine.id,
        expectedUpdatedAt: new Date(routine.updatedAt.getTime() - 5000).toISOString(),
      })
      expect((await approve(stale)).status).toBe('STALE')

      const enable = await propose('routines.propose_enable', {
        tenantId,
        venueId,
        routineId: routine.id,
        expectedUpdatedAt: routine.updatedAt.toISOString(),
      })
      // Enabling always waits for a person; an approval replay is idempotent.
      expect(enable.status).toBe('PENDING')
      expect((await approve(enable)).status).toBe('APPLIED')
      expect((await approve(enable)).status).toBe('APPLIED')
      const enabledStatus = await read('routines.get_run_status', { routineId: routine.id })
      expect(enabledStatus.state).toBe('enabled')

      const edit = await propose('routines.propose_update', {
        tenantId,
        venueId,
        routineId: routine.id,
        expectedUpdatedAt: enabledStatus.version,
        intervalSeconds: 7200,
      })
      expect(['STALE', 'FAILED']).toContain((await approve(edit)).status)

      const disable = await propose('routines.propose_disable', {
        tenantId,
        venueId,
        routineId: routine.id,
        expectedUpdatedAt: enabledStatus.version,
      })
      expect((await approve(disable)).status).toBe('APPLIED')
      expect((await read('routines.get_run_status', { routineId: routine.id })).state).toBe(
        'disabled',
      )
    })

    it('stop rules and a dollar budget go through the same propose, approve and edit path, scoped to the tenant', async () => {
      const request = await withTenantIsolationBypass(() =>
        db.supportRequest.create({
          data: {
            tenantId,
            venueId,
            category: 'GENERAL',
            subject: 'Example follow-up',
            createdByKind: 'OPERATOR',
            createdById: 'seed',
            updatedByKind: 'OPERATOR',
            updatedById: 'seed',
          },
        }),
      )
      const foreignVenue = `rr-foreign-venue-${suffix}`
      const foreignRequest = await withTenantIsolationBypass(async () => {
        await db.venue.create({
          data: {
            id: foreignVenue,
            tenantId: otherTenantId,
            name: 'Example Foreign Garden',
            slug: `rr-foreign-${suffix}`,
          },
        })
        return db.supportRequest.create({
          data: {
            tenantId: otherTenantId,
            venueId: foreignVenue,
            category: 'GENERAL',
            subject: 'Example foreign request',
            createdByKind: 'OPERATOR',
            createdById: 'seed',
            updatedByKind: 'OPERATOR',
            updatedById: 'seed',
          },
        })
      })
      const base = {
        tenantId,
        venueId,
        agentIdentityId: agentId,
        prompt: 'Remind the client about the open request.',
        intervalSeconds: 3600,
      }
      // A subject that lives in another tenant is not found: it cannot be proposed at all.
      await expect(
        propose('routines.propose_create', {
          ...base,
          routineKey: 'foreign-subject',
          stopRules: { subject: { kind: 'SUPPORT_REQUEST', id: foreignRequest.id } },
        }),
      ).rejects.toBeInstanceOf(OperatorNotFoundError)

      const created = await propose('routines.propose_create', {
        ...base,
        routineKey: 'client-follow-up',
        stopRules: {
          subject: { kind: 'SUPPORT_REQUEST', id: request.id },
          maxReminders: 3,
          endsAt: '2027-01-01T00:00:00.000Z',
        },
        budget: { amountCents: 500, currency: 'USD', period: 'WEEK', estimatedRunCostCents: 40 },
      })
      expect((await approve(created)).status).toBe('APPLIED')
      const routine = await withTenantIsolationBypass(() =>
        db.agentRoutine.findFirstOrThrow({ where: { tenantId, routineKey: 'client-follow-up' } }),
      )
      expect(routine).toMatchObject({
        enabled: false,
        budgetCents: 500,
        budgetCurrency: 'USD',
        budgetPeriod: 'WEEK',
        estimatedRunCostCents: 40,
        stopRules: {
          subject: { kind: 'SUPPORT_REQUEST', id: request.id },
          maxReminders: 3,
          endsAt: '2027-01-01T00:00:00.000Z',
        },
      })

      const status = await read('routines.get_run_status', { routineId: routine.id })
      expect(status.limits.cost).toMatchObject({
        enforced: true,
        budget: { amountCents: 500, spentCents: 0, remainingCents: 500, period: 'WEEK' },
      })
      expect(status.limits.stopRules).toMatchObject({ maxReminders: 3, stopReason: null })

      // The budget changes only through a proposal, and only while the routine is disabled.
      const edit = await propose('routines.propose_update', {
        tenantId,
        venueId,
        routineId: routine.id,
        expectedUpdatedAt: status.version,
        budget: { amountCents: 900, currency: 'USD', period: 'MONTH', estimatedRunCostCents: 60 },
      })
      expect((await approve(edit)).status).toBe('APPLIED')
      const edited = await read('routines.get_run_status', { routineId: routine.id })
      expect(edited.limits.cost.budget).toMatchObject({ amountCents: 900, period: 'MONTH' })

      const remove = await propose('routines.propose_update', {
        tenantId,
        venueId,
        routineId: routine.id,
        expectedUpdatedAt: edited.version,
        budget: null,
      })
      expect((await approve(remove)).status).toBe('APPLIED')
      const cleared = await read('routines.get_run_status', { routineId: routine.id })
      expect(cleared.limits.cost).toMatchObject({ enforced: false, budget: null })
      // The edit left a durable audit row for the budget change.
      const audit = await withTenantIsolationBypass(() =>
        db.auditLog.count({
          where: { tenantId, targetId: routine.id, action: 'agent-routine.updated' },
        }),
      )
      expect(audit).toBe(2)
      // Another tenant's grant cannot read this routine's budget or stop state.
      await expect(
        read('routines.get_run_status', { routineId: routine.id }, otherGrant),
      ).rejects.toBeDefined()
    })

    it('reads a report in full, classifies a stalled one from evidence and refuses a foreign grant', async () => {
      const body = 'Insight. '.repeat(400)
      const reportId = `rr-report-${suffix}`
      await withTenantIsolationBypass(() =>
        db.weeklyReport.create({
          data: {
            id: reportId,
            tenantId,
            venueId,
            weekStart: new Date('2026-06-29T00:00:00Z'),
            weekEnd: new Date('2026-07-05T23:59:59Z'),
            status: 'GENERATING',
            createdBy: 'seed',
            createdAt: new Date('2026-07-04T00:00:00Z'),
          },
        }),
      )
      const reconciled = await read('reports.reconcile_generating', {})
      const row = reconciled.items.find((item: any) => item.reportId === reportId)
      expect(row.classification).toBe('no_job_found')
      expect(row.ageMinutes).toBeGreaterThan(1000)

      await withTenantIsolationBypass(() =>
        db.weeklyReport.update({
          where: { id: reportId },
          data: {
            status: 'DRAFT',
            content: body,
            generatedAt: new Date(),
            answerCount: 1,
            sessionCount: 1,
          },
        }),
      )
      const full = await read('reports.get', { venueId, reportId })
      expect(full.body.text).toBe(body)
      expect(full.body.truncated).toBe(false)
      expect(full.denominators.totalMessages).toBe('unavailable')
      await expect(read('reports.get', { venueId, reportId }, otherGrant)).rejects.toBeInstanceOf(
        OperatorNotFoundError,
      )

      const publish = await propose('reports.propose_publish', {
        tenantId,
        venueId,
        reportId,
        expectedUpdatedAt: full.version,
      })
      expect(publish.status).toBe('PENDING')
      expect((await approve(publish)).status).toBe('APPLIED')
      const published = await read('reports.get', { venueId, reportId })
      expect(published.status).toBe('PUBLISHED')
      expect(published.delivery.state).toBe('not_modeled')
      const again = await propose('reports.propose_publish', {
        tenantId,
        venueId,
        reportId,
        expectedUpdatedAt: full.version,
      })
      expect(['STALE', 'FAILED']).toContain((await approve(again)).status)
    })

    it('lists sessions with counts, reads answer evidence honestly and builds an attention view', async () => {
      const session = await withTenantIsolationBypass(() =>
        db.visitorSession.create({
          data: {
            tenantId,
            venueId,
            anonymousToken: `rr-token-${suffix}`,
            startedAt: new Date(Date.now() - 3_600_000),
          },
        }),
      )
      const sessions = await read('venues.list_sessions', {
        venueId,
        windowStart: new Date(Date.now() - 86_400_000).toISOString(),
        windowEnd: new Date(Date.now() + 60_000).toISOString(),
        timeZone: 'UTC',
      })
      expect(sessions.items.map((item: any) => item.sessionId)).toContain(session.id)
      expect(sessions.counts.unavailable.testClassification).toBe(true)
      const evidence = await read('venues.get_answer_evidence', { venueId, sessionId: session.id })
      expect(evidence.turns).toEqual([])
      await expect(
        read('venues.get_answer_evidence', { venueId, sessionId: session.id }, otherGrant),
      ).rejects.toBeInstanceOf(OperatorNotFoundError)

      const attention = await read('operator.get_attention', {})
      expect(attention.categories).toHaveLength(9)
      expect(attention.categories.find((c: any) => c.key === 'billing_exceptions').state).toBe(
        'unknown',
      )
    })
  },
)
