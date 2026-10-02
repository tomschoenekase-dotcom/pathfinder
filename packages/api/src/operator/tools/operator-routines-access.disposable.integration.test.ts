/* eslint-disable @typescript-eslint/no-explicit-any -- parsed MCP outputs are discriminated by tool name */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  OPERATOR_MCP_OUTPUTS,
  OperatorCapability,
  type OperatorReadToolName,
} from '@pathfinder/contracts/operator-mcp'
import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { resolveOperatorConfig } from '../config'
import { OperatorNotFoundError } from '../grants'
import type { VerifiedOperatorGrant } from '../oauth'
import { createOperatorRegistry, defaultVenueRead } from '../registry'

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
const tenantId = `h10-a-${suffix}`
const otherTenantId = `h10-b-${suffix}`
const venueId = `h10-venue-${suffix}`
const otherVenueId = `h10-other-venue-${suffix}`
const userId = `h10-user-${suffix}`
const identityId = `h10-identity-${suffix}`
const routineIds = Array.from(
  { length: 26 },
  (_, i) => `h10-routine-${suffix}-${String(i).padStart(2, '0')}`,
)
const planId = `h10-plan-${suffix}`
const otherPlanId = `h10-other-plan-${suffix}`
const targetId = `h10-target-${suffix}`
const evidenceId = `h10-evidence-${suffix}`
const registry = createOperatorRegistry()
let testDatabase: typeof db
let finishTransaction: () => void = () => undefined
let readyForTests: () => void = () => undefined
let failReady: (error: unknown) => void = () => undefined
const testReady = new Promise<void>((resolve, reject) => {
  readyForTests = resolve
  failReady = reject
})
const holdTransaction = new Promise<void>((resolve) => (finishTransaction = resolve))
const rollbackSignal = new Error('rollback H10 disposable fixtures')

function grant(capabilities: string[] = [...OperatorCapability.options]): VerifiedOperatorGrant {
  return {
    grantId: `h10-grant-${suffix}`,
    clientId: 'h10-client',
    userId: 'user_owner',
    allTenants: false,
    tenantIds: [tenantId],
    capabilities: capabilities as OperatorCapability[],
  }
}

async function call(
  name: OperatorReadToolName,
  args: Record<string, unknown>,
  capabilities?: string[],
  selectedTenantId = tenantId,
) {
  const result = await registry.callTool(
    name,
    { tenantId: selectedTenantId, ...args },
    {
      config,
      database: testDatabase,
      grant: grant(capabilities),
      now: new Date(),
      requestId: randomUUID(),
      venueRead: defaultVenueRead(testDatabase),
    },
  )
  return OPERATOR_MCP_OUTPUTS[name].parse(result) as any
}

describe.skipIf(!enabled)('H10 routines and access reads on disposable PostgreSQL', () => {
  let transactionResult: Promise<unknown>

  beforeAll(async () => {
    transactionResult = db
      .$transaction(
        async (tx) => {
          testDatabase = tx as unknown as typeof db
          await withTenantIsolationBypass(async () => {
            await testDatabase.tenant.createMany({
              data: [
                { id: tenantId, name: `Example H10 ${suffix}`, slug: tenantId },
                { id: otherTenantId, name: `Other H10 ${suffix}`, slug: otherTenantId },
              ],
            })
            await testDatabase.venue.createMany({
              data: [
                { id: venueId, tenantId, name: 'Example H10 venue', slug: venueId },
                {
                  id: otherVenueId,
                  tenantId: otherTenantId,
                  name: 'Other H10 venue',
                  slug: otherVenueId,
                },
              ],
            })
            await testDatabase.user.create({
              data: { id: userId, email: `${userId}@example.test`, fullName: 'Fixture User' },
            })
            await testDatabase.tenantMembership.create({
              data: {
                id: `h10-membership-${suffix}`,
                tenantId,
                userId,
                role: 'MANAGER',
                status: 'ACTIVE',
              },
            })
            await testDatabase.agentIdentity.create({
              data: {
                id: identityId,
                tenantId,
                venueId,
                identityKey: `h10-key-${suffix}`,
                name: 'Example routine identity',
                description: 'Fixture',
                agentType: 'OPERATOR',
                accessScope: 'VENUE',
                accessCapabilities: [],
                autonomyLevel: 'READ_ONLY',
                autonomousActions: [],
                enabled: true,
                createdBy: 'fixture',
              },
            })
            const now = new Date('2026-09-29T12:00:00.000Z')
            await testDatabase.agentRoutine.createMany({
              data: routineIds.map((id, index) => ({
                id,
                tenantId,
                venueId,
                routineKey: `routine-${index}`,
                agentIdentityId: identityId,
                requestedOperation: 'status-check',
                prompt: 'Fixture prompt must not be returned',
                intervalSeconds: 300,
                maxAttempts: 1,
                maxRunsPerDay: 4,
                requiredWorkerRoles: ['reader'],
                requiredWorkerCapabilities: ['status'],
                enabled: index % 2 === 0,
                createdBy: 'fixture',
                createdAt: now,
                updatedAt: now,
              })),
            })
            await testDatabase.offboardingPlan.createMany({
              data: [
                {
                  id: planId,
                  tenantId,
                  requestId: randomUUID(),
                  requestHash: 'a'.repeat(64),
                  status: 'REQUESTED',
                  revocationTargets: ['CLIENT_ACCESS'],
                  exportKinds: ['CONFIGURATION'],
                  requestedBy: 'fixture',
                  requestedAt: now,
                },
                {
                  id: otherPlanId,
                  tenantId: otherTenantId,
                  requestId: randomUUID(),
                  requestHash: 'b'.repeat(64),
                  status: 'REQUESTED',
                  revocationTargets: ['CLIENT_ACCESS'],
                  exportKinds: [],
                  requestedBy: 'fixture',
                  requestedAt: now,
                },
              ],
            })
            await testDatabase.offboardingVenueTarget.create({
              data: { id: targetId, tenantId, venueId, planId },
            })
            await testDatabase.offboardingRevocationEvidence.create({
              data: {
                id: evidenceId,
                tenantId,
                venueId,
                planId,
                target: 'CLIENT_ACCESS',
                outcome: 'FAILED',
                evidenceReference: 'private://fixture/evidence',
                errorCode: 'fixture-code',
                recordedBy: 'fixture',
              },
            })
          })
          readyForTests()
          await holdTransaction
          throw rollbackSignal
        },
        { timeout: 120_000 },
      )
      .catch((error) => {
        failReady(error)
        throw error
      })
    await testReady
  })

  afterAll(async () => {
    finishTransaction()
    await expect(transactionResult!).rejects.toBe(rollbackSignal)
    await withTenantIsolationBypass(async () => {
      expect(
        await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }),
      ).toBeNull()
      expect(await db.agentRoutine.findMany({ where: { tenantId }, select: { id: true } })).toEqual(
        [],
      )
      expect(
        await db.offboardingRevocationEvidence.findMany({
          where: { tenantId },
          select: { id: true },
        }),
      ).toEqual([])
    })
  })

  it('pages tenant routines, includes tied timestamps, and rejects foreign-scope cursors', async () => {
    const first = await call('routines.list', { limit: 25 })
    expect(first.items).toHaveLength(25)
    expect(first.complete).toBe(false)
    expect(first.items[0].routineKey.untrusted).toBe(true)
    expect(JSON.stringify(first)).not.toContain('Fixture prompt')
    const second = await call('routines.list', { limit: 25, cursor: first.nextCursor })
    expect(second.items).toHaveLength(1)
    expect(second.complete).toBe(true)
    await expect(
      call('routines.list', { limit: 1, venueId: otherVenueId, cursor: first.nextCursor }),
    ).rejects.toThrow()
    await expect(call('routines.list', {}, ['access:read'])).rejects.toThrow()
  })

  it('reads membership and offboarding status while withholding private references', async () => {
    expect((await call('access.list_memberships', { limit: 10 })).items).toMatchObject([
      { userId, role: 'MANAGER', status: 'ACTIVE' },
    ])
    const plans = await call('offboarding.list_plans', { limit: 10 })
    expect(plans.items.map((row: any) => row.planId)).toEqual([planId])
    const targets = await call('offboarding.list_targets', { planId, limit: 10 })
    expect(targets.items).toHaveLength(1)
    const evidence = await call('offboarding.list_evidence', { planId, limit: 10 })
    expect(evidence.items[0].errorCode.untrusted).toBe(true)
    expect(JSON.stringify(evidence)).not.toContain('private://')
    const artifacts = await call('offboarding.list_artifacts', { planId, limit: 10 })
    expect(artifacts.items).toEqual([])
    expect(JSON.stringify(artifacts)).not.toContain('private://')
    await expect(call('offboarding.list_plans', {}, ['routines:read'])).rejects.toThrow()
    await expect(
      call('offboarding.list_plans', {}, undefined, otherTenantId),
    ).rejects.toBeInstanceOf(OperatorNotFoundError)
  })
})
