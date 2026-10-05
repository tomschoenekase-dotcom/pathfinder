/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory database double with loose row shapes */
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OperatorCapability } from '@pathfinder/contracts/operator-mcp'

/**
 * Durable operation contract for customers.propose_create (packet W02 / A07, A27), proved against
 * an in-memory database and an identity-provider double. Nothing here contacts a real provider or
 * database. The same flows are exercised against a real PostgreSQL in the disposable integration
 * suites; these tests are the always-on regression net.
 */

// ---------------------------------------------------------------------------
// World: one in-memory database, one provider double, shared with the mocked domain actions.
// ---------------------------------------------------------------------------

type Row = Record<string, any>

const world = vi.hoisted(() => ({
  proposals: [] as Record<string, any>[],
  intents: new Map<string, Record<string, any>>(),
  tenants: new Map<string, Record<string, any>>(),
  venues: [] as Record<string, any>[],
  audits: [] as Record<string, any>[],
  orgs: [] as Record<string, any>[],
  faults: {
    policyRead: false,
    proposalCreate: false,
    ownerMissing: false,
    /** 'lost_response': the provider makes the org, then the caller never hears. */
    provider: 'ok' as 'ok' | 'fail_no_effect' | 'lost_response',
    createAccount: false,
    completeIntent: false,
    lookup: 'ok' as 'ok' | 'incomplete' | 'down',
  },
  calls: { createOrganization: 0 },
}))

vi.mock('@pathfinder/auth', () => ({
  createOrganization: vi.fn(),
  ensureOrganizationInvitation: vi.fn(),
  findOrganizationsForCreateOperation: vi.fn(),
  listPendingOrganizationInvitations: vi.fn(),
  validateExistingOrganizationOwner: vi.fn(),
}))

vi.mock('@pathfinder/db', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const identityOf = (input: any) => input
  const requireIntent = (requestId: string) => {
    const intent = world.intents.get(requestId)
    if (!intent) throw new (original.ClientCreateIntentError as any)('NOT_FOUND', 'no intent')
    return intent
  }
  return {
    ...original,
    db: {},
    beginClientCreateIntentAction: vi.fn(async (input: any) => {
      let intent = world.intents.get(input.requestId)
      if (!intent) {
        intent = {
          requestId: input.requestId,
          requestHash: input.requestHash,
          actorId: input.actor.id,
          status: 'RESERVED',
          localSlug: null,
          providerOrganizationId: null,
          completedTenantId: null,
          completedVenueId: null,
          createdAt: new Date('2026-09-30T10:00:00Z'),
        }
        world.intents.set(input.requestId, intent)
      }
      if (intent.requestHash !== input.requestHash) {
        throw new (original.ClientCreateIntentError as any)('CONFLICT', 'different input')
      }
      if (intent.status === 'COMPLETED') {
        return {
          state: 'COMPLETED',
          tenantId: intent.completedTenantId,
          venueId: intent.completedVenueId,
        }
      }
      if (intent.status === 'PROVIDER_CONFIRMED') {
        return {
          state: 'PROVIDER_CONFIRMED',
          providerOrganizationId: intent.providerOrganizationId,
          localSlug: intent.localSlug,
        }
      }
      if (intent.status === 'PROVIDER_STARTED') return { state: 'RECONCILIATION_REQUIRED' }
      return { state: 'READY' }
    }),
    startClientCreateProviderAction: vi.fn(async (input: any) => {
      const intent = requireIntent(input.requestId)
      if (intent.status !== 'RESERVED') return { state: 'RECONCILIATION_REQUIRED' }
      intent.status = 'PROVIDER_STARTED'
      intent.localSlug = input.localSlug
      return { state: 'CALL_PROVIDER' }
    }),
    confirmClientCreateProviderAction: vi.fn(async (input: any) => {
      const intent = requireIntent(input.requestId)
      const claimed = [...world.intents.values()].find(
        (other) =>
          other.requestId !== input.requestId &&
          other.providerOrganizationId === input.providerOrganizationId,
      )
      if (claimed) throw new (original.ClientCreateIntentError as any)('CONFLICT', 'claimed')
      if (intent.status === 'PROVIDER_STARTED') {
        intent.status = 'PROVIDER_CONFIRMED'
        intent.providerOrganizationId = input.providerOrganizationId
      }
      return intent
    }),
    completeClientCreateIntentAction: vi.fn(async (input: any) => {
      if (world.faults.completeIntent) throw new Error('database unavailable')
      const intent = requireIntent(input.requestId)
      intent.status = 'COMPLETED'
      intent.completedTenantId = input.tenantId
      intent.completedVenueId = input.venueId
      return identityOf(intent)
    }),
    createClientAccountAction: vi.fn(async (input: any) => {
      if (world.faults.createAccount) throw new Error('database unavailable')
      world.tenants.set(input.tenantId, { id: input.tenantId, slug: input.slug, name: input.name })
      const venue = {
        id: `venue_${world.venues.length + 1}`,
        tenantId: input.tenantId,
        slug: input.initialVenue.slug,
        isActive: input.initialVenue.isActive,
        createdAt: new Date(),
      }
      world.venues.push(venue)
      return { tenant: { id: input.tenantId, slug: input.slug }, venue, replayed: false }
    }),
    linkProspectConversionAction: vi.fn(async () => ({})),
  }
})

import { setCustomerProviderForTests } from './kinds/customers'
import { resolveOperatorConfig } from './config'
import { errorBody, errorCode } from './http'
import { OPERATOR_PROPOSAL_KINDS } from './kinds'
import { recoverOperation } from './execution'
import { OperatorNotFoundError } from './grants'
import {
  approveAndApplyProposal,
  createKindRegistry,
  createProposal,
  OperatorProposalError,
} from './proposals'
import { operationReadTools } from './tools/operations'

// ---------------------------------------------------------------------------
// In-memory database exposing exactly the surface the operator code touches.
// ---------------------------------------------------------------------------

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key]
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      if ('in' in expected) return (expected.in as unknown[]).includes(actual)
      if ('not' in expected) return actual !== expected.not
      if ('increment' in expected) return true
    }
    if (expected instanceof Date)
      return actual instanceof Date && actual.getTime() === expected.getTime()
    return actual === expected
  })
}

function fakeDatabase() {
  const byUnique = (where: Row) => {
    if (where.grantId_operationId) {
      return world.proposals.find(
        (row) =>
          row.grantId === where.grantId_operationId.grantId &&
          row.operationId === where.grantId_operationId.operationId,
      )
    }
    return world.proposals.find((row) => row.id === where.id)
  }
  return {
    operatorProposal: {
      findUnique: async ({ where }: Row) => byUnique(where) ?? null,
      findFirst: async ({ where }: Row) =>
        world.proposals.find((row) => matches(row, where)) ?? null,
      create: async ({ data }: Row) => {
        if (world.faults.proposalCreate) throw new Error('connection reset')
        const row = {
          id: randomUUID(),
          status: 'PENDING',
          attempt: 0,
          fenceToken: 0,
          applyClaimedAt: null,
          applyStartedAt: null,
          leaseExpiresAt: null,
          failureCode: null,
          result: null,
          beforeSnapshot: null,
          afterSnapshot: null,
          planId: null,
          planStepIndex: null,
          decidedByUserId: null,
          decidedAt: null,
          appliedAt: null,
          autoApproved: false,
          ...data,
        }
        world.proposals.push(row)
        return row
      },
      updateMany: async ({ where, data }: Row) => {
        const hits = world.proposals.filter((row) => matches(row, where))
        for (const row of hits) {
          for (const [key, value] of Object.entries(data)) {
            if (value && typeof value === 'object' && 'increment' in (value as Row)) {
              row[key] += (value as Row).increment
            } else row[key] = value
          }
        }
        return { count: hits.length }
      },
    },
    operatorPlan: { findUnique: async () => null },
    operatorPolicyState: {
      findUnique: async () => {
        if (world.faults.policyRead) throw new Error('connection reset')
        return null
      },
    },
    operatorAutonomyPolicy: { findUnique: async () => null },
    operatorAuditEvent: {
      create: async ({ data }: Row) => {
        world.audits.push(data)
      },
    },
    operatorGrant: {
      findUnique: async () => ({
        id: 'grant_1',
        clientId: 'client_1',
        userId: 'user_owner',
        allTenants: true,
        tenantIds: [],
        capabilities: ['customers:propose', 'operator:read', 'operator:plan'],
        revokedAt: null,
        expiresAt: new Date('2099-01-01T00:00:00Z'),
        client: { revokedAt: null },
      }),
    },
    user: {
      findUnique: async () =>
        world.faults.ownerMissing ? null : { id: 'user_owner', email: 'owner@example.com' },
    },
    tenant: {
      findFirst: async ({ where }: Row) =>
        [...world.tenants.values()].find((tenant) => tenant.slug === where.slug) ?? null,
      findUnique: async ({ where }: Row) => world.tenants.get(where.id) ?? null,
    },
    venue: {
      findFirst: async ({ where }: Row) =>
        world.venues.find((venue) => venue.tenantId === where.tenantId) ?? null,
    },
    clientCreateIntent: {
      findUnique: async ({ where }: Row) => world.intents.get(where.requestId) ?? null,
    },
    prospectOrganization: { findFirst: async () => null },
  } as any
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const resolution = resolveOperatorConfig({
  OPERATOR_OAUTH_ENABLED: true,
  OPERATOR_OAUTH_ISSUER: 'https://app.operator.test',
  OPERATOR_OAUTH_PEPPERS: 'k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  OPERATOR_OAUTH_REDIRECT_ORIGINS: 'https://connector.example.com',
  OPERATOR_OAUTH_ALLOWED_USER_IDS: 'user_owner',
  RAILWAY_ENVIRONMENT: 'staging',
} as never)
if (resolution.status !== 'ready') throw new Error('operator config not ready')
const config = resolution.config

const kinds = createKindRegistry(OPERATOR_PROPOSAL_KINDS)
const grant = {
  grantId: 'grant_1',
  clientId: 'client_1',
  userId: 'user_owner',
  allTenants: true,
  tenantIds: [] as string[],
  capabilities: ['customers:propose', 'operator:read', 'operator:plan'] as OperatorCapability[],
}
const dependencies = (database: any) => ({
  database,
  kinds,
  allowedUserIds: config.allowedUserIds,
})
const NOW = new Date('2026-10-01T12:00:00Z')

const createArgs = (operationId: string, overrides: Row = {}) => ({
  operationId,
  organizationName: 'Sample Venue Group',
  venueName: 'Main Hall',
  ...overrides,
})

function installProvider() {
  const find = vi.fn(async (input: any) => {
    if (world.faults.lookup === 'down') throw new Error('provider unavailable')
    const candidates = world.orgs
      .filter((org) => org.operationId === input.operationId)
      .map((org) => ({ id: org.id, name: org.name, matchedBy: 'operation_metadata' as const }))
    return { candidates, complete: world.faults.lookup !== 'incomplete' }
  })
  const create = vi.fn(async (input: any) => {
    world.calls.createOrganization += 1
    if (world.faults.provider === 'fail_no_effect') throw new Error('provider refused')
    const org = {
      id: `org_${world.orgs.length + 1}`,
      name: input.name,
      operationId: input.operationId,
    }
    world.orgs.push(org)
    if (world.faults.provider === 'lost_response') throw new Error('socket hang up')
    return { id: org.id, name: input.name, slug: input.slug }
  })
  setCustomerProviderForTests({
    createOrganization: create,
    findOrganizations: find,
    validateOwner: vi.fn(async (input: any) => ({
      organizationId: input.organizationId,
      organizationName: 'x',
      organizationSlug: 'x',
      userId: input.userId,
      emailAddress: input.emailAddress,
    })),
    ensureInvitation: vi.fn(),
    listPendingInvitations: vi.fn(async () => []),
  } as never)
  return { create, find }
}

async function propose(database: any, args: Row) {
  return createProposal('customers.propose_create', args, {
    config,
    database,
    grant,
    kinds,
    now: NOW,
    requestId: randomUUID(),
  })
}

async function approve(database: any, view: { proposalId: string; argsHash: string }) {
  return approveAndApplyProposal(
    {
      proposalId: view.proposalId,
      argsHash: view.argsHash,
      actorUserId: 'user_owner',
      requestId: randomUUID(),
      now: NOW,
    },
    dependencies(database),
  )
}

async function getOperation(database: any, operationId: string) {
  const tool = operationReadTools.find((item) => item.name === 'operator.get_operation')!
  return (await tool.handler({ originalOperationId: operationId }, {
    config,
    database,
    grant,
    kinds,
    now: NOW,
    requestId: randomUUID(),
    venueRead: vi.fn() as never,
  } as never)) as any
}

async function recover(database: any, operationId: string) {
  const row = world.proposals.find((item) => item.operationId === operationId)!
  await recoverOperation(row.id, dependencies(database), { requestId: randomUUID(), now: NOW })
  return getOperation(database, operationId)
}

beforeEach(() => {
  world.proposals.length = 0
  world.intents.clear()
  world.tenants.clear()
  world.venues.length = 0
  world.audits.length = 0
  world.orgs.length = 0
  world.calls.createOrganization = 0
  Object.assign(world.faults, {
    policyRead: false,
    proposalCreate: false,
    ownerMissing: false,
    provider: 'ok',
    createAccount: false,
    completeIntent: false,
    lookup: 'ok',
  })
  process.env.OPERATOR_CUSTOMER_CREATE_ENABLED = 'true'
  installProvider()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('customers.propose_create durable operation contract', () => {
  it('failure before persistence returns proved-no-effect NOT_RECORDED and no operation to look up', async () => {
    const database = fakeDatabase()
    const operationId = randomUUID()
    world.faults.proposalCreate = true

    const error = await propose(database, createArgs(operationId)).catch((caught) => caught)
    expect(error).toBeInstanceOf(OperatorProposalError)
    expect(errorCode(error)).toBe('NOT_RECORDED')

    const body = errorBody(errorCode(error), 'customers.propose_create', 'req-1') as any
    expect(body).toMatchObject({
      error: 'NOT_RECORDED',
      retryable: true,
      outcome: 'none',
      operationRecorded: false,
    })
    expect(body.nextAction).toMatch(/nothing was recorded and nothing was changed/iu)
    expect(world.proposals).toHaveLength(0)
    expect(world.orgs).toHaveLength(0)

    // get_operation says plainly that nothing is recorded, not that the outcome is unknown.
    await expect(getOperation(database, operationId)).rejects.toBeInstanceOf(OperatorNotFoundError)

    // Same request, same operationId, after the outage: recorded exactly once.
    world.faults.proposalCreate = false
    const view = await propose(database, createArgs(operationId))
    expect(view.status).toBe('PENDING')
    expect(world.proposals).toHaveLength(1)
  })

  it('an unrelated infrastructure error before the insert is also NOT_RECORDED, never TOOL_FAILED', async () => {
    const database = fakeDatabase()
    world.faults.policyRead = true
    const error = await propose(database, createArgs(randomUUID())).catch((caught) => caught)
    expect(errorCode(error)).toBe('NOT_RECORDED')
    expect(world.proposals).toHaveLength(0)
  })

  it('a disabled switch is a named no-effect refusal, not an unknown outcome', async () => {
    const database = fakeDatabase()
    process.env.OPERATOR_CUSTOMER_CREATE_ENABLED = 'false'
    const error = await propose(database, createArgs(randomUUID())).catch((caught) => caught)
    expect(errorCode(error)).toBe('DISABLED')
    expect(errorBody('DISABLED', 'customers.propose_create', 'r')).toMatchObject({
      outcome: 'none',
      retryable: false,
    })
  })

  it('rechecks the create gate after proposal and before the provider can be called', async () => {
    const database = fakeDatabase()
    const operationId = randomUUID()
    const view = await propose(database, createArgs(operationId))
    process.env.OPERATOR_CUSTOMER_CREATE_ENABLED = 'false'
    await approve(database, view)
    expect(await getOperation(database, operationId)).toMatchObject({
      status: 'FAILED',
      failureCode: 'DISABLED',
      effect: 'none',
    })
    expect(world.calls.createOrganization).toBe(0)
    expect(world.tenants.size).toBe(0)
    expect(world.venues).toHaveLength(0)
  })

  it('persists principal, kind, normalized args hash and state before any effect', async () => {
    const database = fakeDatabase()
    const operationId = randomUUID()
    const view = await propose(database, createArgs(operationId))
    expect(world.orgs).toHaveLength(0)
    expect(world.calls.createOrganization).toBe(0)
    expect(world.proposals[0]).toMatchObject({
      grantId: 'grant_1',
      clientId: 'client_1',
      kind: 'customers.create',
      operationId,
      status: 'PENDING',
      argsHash: view.argsHash,
    })
    const found = await getOperation(database, operationId)
    expect(found).toMatchObject({ status: 'PENDING', effect: 'none', operationId })
  })

  it('failure after persistence and before the provider call is recorded as no effect and found', async () => {
    const database = fakeDatabase()
    const operationId = randomUUID()
    world.faults.ownerMissing = true
    const view = await propose(database, createArgs(operationId))
    await approve(database, view)

    const found = await getOperation(database, operationId)
    expect(found).toMatchObject({
      status: 'FAILED',
      effect: 'none',
      failureCode: 'OWNER_UNRESOLVED',
    })
    expect(found.summary).toMatch(/not created/iu)
    expect(found.summary).toMatch(/no invitation sent/iu)
    expect(world.calls.createOrganization).toBe(0)
    expect(world.orgs).toHaveLength(0)
  })

  it('provider refusal that cannot be proven harmless is held as unknown, then settled as no effect', async () => {
    const database = fakeDatabase()
    const operationId = randomUUID()
    world.faults.provider = 'fail_no_effect'
    await approve(database, await propose(database, createArgs(operationId)))

    const held = await getOperation(database, operationId)
    expect(held).toMatchObject({
      status: 'FAILED',
      effect: 'unknown',
      failureCode: 'OUTCOME_UNKNOWN',
    })
    expect(held.nextAction).toMatch(/recover_operation/u)
    expect(held.summary).toMatch(/unconfirmed/iu)

    // The provider is searched read-only and holds nothing for this operation.
    const settled = await recover(database, operationId)
    expect(settled).toMatchObject({
      status: 'FAILED',
      effect: 'none',
      failureCode: 'FAILED_NO_EFFECT',
    })
    expect(settled.summary).toMatch(/holds no organization/iu)
    expect(world.calls.createOrganization).toBe(1)

    // Now, and only now, a fresh operation for the same customer is allowed.
    const retry = await propose(database, createArgs(randomUUID()))
    expect(retry.status).toBe('PENDING')
  })

  it('provider effect with a lost response: unknown, replay changes nothing, reconcile finds the org, no duplicate', async () => {
    const database = fakeDatabase()
    const operationId = randomUUID()
    world.faults.provider = 'lost_response'
    const view = await propose(database, createArgs(operationId))
    await approve(database, view)

    const held = await getOperation(database, operationId)
    expect(held).toMatchObject({
      status: 'FAILED',
      effect: 'unknown',
      failureCode: 'OUTCOME_UNKNOWN',
    })
    expect(world.orgs).toHaveLength(1)
    expect(world.orgs[0]!.operationId).toBe(operationId)

    // Replaying the same operation returns the recorded state and calls nothing.
    const replay = await propose(database, createArgs(operationId))
    expect(replay).toMatchObject({ proposalId: view.proposalId, status: 'FAILED' })
    expect(world.calls.createOrganization).toBe(1)

    // A new operationId for the same customer is refused until the first is reconciled.
    const refused = await propose(database, createArgs(randomUUID())).catch((caught) => caught)
    expect(errorCode(refused)).toBe('UNRECONCILED_PRIOR_OPERATION')
    expect(
      errorBody('UNRECONCILED_PRIOR_OPERATION', 'customers.propose_create', 'r'),
    ).toMatchObject({
      outcome: 'none',
      retryable: false,
    })
    expect(world.calls.createOrganization).toBe(1)

    // Reconcile: the org exists by operation identity, the local record does not.
    world.faults.provider = 'ok'
    const settled = await recover(database, operationId)
    expect(settled).toMatchObject({
      status: 'FAILED',
      effect: 'partial',
      failureCode: 'PARTIALLY_APPLIED',
    })
    expect(settled.summary).toBe(
      'Identity-provider organization created; local client record and draft venue not set up; no invitation sent.',
    )
    expect(settled.result).toMatchObject({ organizationId: 'org_1', clientCreated: false })
    expect(world.intents.get(operationId)).toMatchObject({
      status: 'PROVIDER_CONFIRMED',
      providerOrganizationId: 'org_1',
    })
    expect(world.calls.createOrganization).toBe(1)
    expect(world.orgs).toHaveLength(1)

    // A partial effect still blocks a duplicate identity.
    const stillRefused = await propose(database, createArgs(randomUUID())).catch((c) => c)
    expect(errorCode(stillRefused)).toBe('UNRECONCILED_PRIOR_OPERATION')
  })

  it('after one of several steps: org confirmed, local write fails, reconcile reports a partial', async () => {
    const database = fakeDatabase()
    const operationId = randomUUID()
    world.faults.createAccount = true
    await approve(database, await propose(database, createArgs(operationId)))

    const held = await getOperation(database, operationId)
    expect(held).toMatchObject({ effect: 'unknown', failureCode: 'OUTCOME_UNKNOWN' })
    expect(held.summary).toMatch(/organization created/iu)
    expect(world.calls.createOrganization).toBe(1)

    world.faults.createAccount = false
    const settled = await recover(database, operationId)
    expect(settled).toMatchObject({ effect: 'partial', failureCode: 'PARTIALLY_APPLIED' })
    expect(settled.summary).toMatch(/local client record and draft venue not set up/iu)
    expect(world.calls.createOrganization).toBe(1)
  })

  it('client exists but venue setup failed is reported in those words', async () => {
    const database = fakeDatabase()
    const operationId = randomUUID()
    world.faults.provider = 'lost_response'
    await approve(database, await propose(database, createArgs(operationId)))
    // Local client record landed through another path, the venue did not.
    world.tenants.set('org_1', {
      id: 'org_1',
      slug: 'sample-venue-group',
      name: 'Sample Venue Group',
    })

    const settled = await recover(database, operationId)
    expect(settled).toMatchObject({ effect: 'partial', failureCode: 'PARTIALLY_APPLIED' })
    expect(settled.summary).toBe('Client created; venue setup failed; no invitation sent.')
    expect(settled.result).toMatchObject({
      clientCreated: true,
      venueCreated: false,
      invited: false,
    })
  })

  it('everything landed but completion was not recorded: reconcile moves it to APPLIED with no second identity', async () => {
    const database = fakeDatabase()
    const operationId = randomUUID()
    world.faults.completeIntent = true
    await approve(database, await propose(database, createArgs(operationId)))

    const held = await getOperation(database, operationId)
    expect(held).toMatchObject({ effect: 'unknown', failureCode: 'OUTCOME_UNKNOWN' })
    expect(held.summary).toMatch(/client and draft venue created/iu)
    expect(world.tenants.size).toBe(1)

    world.faults.completeIntent = false
    const settled = await recover(database, operationId)
    expect(settled).toMatchObject({ status: 'APPLIED', effect: 'applied', failureCode: null })
    expect(settled.result).toMatchObject({
      tenantId: 'org_1',
      draft: true,
      invited: false,
      reconciled: true,
    })
    expect(settled.summary).toBe('Client created; draft venue created; no invitation sent.')
    expect(world.calls.createOrganization).toBe(1)
    expect(world.orgs).toHaveLength(1)
    expect(world.intents.get(operationId)).toMatchObject({ status: 'COMPLETED' })
  })

  it('reconcile stays unknown when the provider cannot be asked or the search is incomplete', async () => {
    const database = fakeDatabase()
    const operationId = randomUUID()
    world.faults.provider = 'lost_response'
    await approve(database, await propose(database, createArgs(operationId)))

    world.faults.lookup = 'down'
    expect(await recover(database, operationId)).toMatchObject({
      effect: 'unknown',
      failureCode: 'OUTCOME_UNKNOWN',
    })
    world.faults.lookup = 'incomplete'
    world.orgs.length = 0
    expect(await recover(database, operationId)).toMatchObject({
      effect: 'unknown',
      failureCode: 'OUTCOME_UNKNOWN',
    })
    // Never "no effect" on a search that could not prove absence.
    expect(world.calls.createOrganization).toBe(1)
  })

  it('replay of a completed operation returns the existing effect and calls nothing', async () => {
    const database = fakeDatabase()
    const operationId = randomUUID()
    const view = await propose(database, createArgs(operationId))
    const applied = await approve(database, view)
    expect(applied.status).toBe('APPLIED')
    expect(world.calls.createOrganization).toBe(1)

    const replay = (await propose(database, createArgs(operationId))) as any
    expect(replay.proposalId).toBe(view.proposalId)
    expect(replay.status).toBe('APPLIED')
    expect(replay.result).toMatchObject({
      tenantId: 'org_1',
      draft: true,
      invited: false,
      summary: 'Client created; draft venue created; no invitation sent.',
    })
    expect(world.calls.createOrganization).toBe(1)
    expect(world.tenants.size).toBe(1)

    // The same id with different arguments is refused, never silently re-run.
    const reused = await propose(
      database,
      createArgs(operationId, { organizationName: 'Another Group' }),
    ).catch((caught) => caught)
    expect(reused).toBeInstanceOf(OperatorProposalError)
    expect(errorCode(reused)).toBe('OPERATION_ID_REUSED')
  })

  it('stores the operation as the provider identity', async () => {
    const database = fakeDatabase()
    const operationId = randomUUID()
    await approve(database, await propose(database, createArgs(operationId)))
    expect(world.orgs[0]).toMatchObject({ operationId })
  })

  it('get_operation finds the operation in every state', async () => {
    const database = fakeDatabase()
    const seen = new Map<string, string>()
    const record = async (label: string, setup: () => Promise<string>) => {
      const id = await setup()
      const found = await getOperation(database, id)
      seen.set(label, `${found.status}/${found.effect}/${found.failureCode ?? '-'}`)
    }
    await record('pending', async () => {
      const id = randomUUID()
      await propose(database, createArgs(id, { organizationName: 'A' }))
      return id
    })
    await record('failed_no_effect', async () => {
      const id = randomUUID()
      world.faults.ownerMissing = true
      await approve(database, await propose(database, createArgs(id, { organizationName: 'B' })))
      world.faults.ownerMissing = false
      return id
    })
    await record('unknown', async () => {
      const id = randomUUID()
      world.faults.provider = 'lost_response'
      await approve(database, await propose(database, createArgs(id, { organizationName: 'C' })))
      world.faults.provider = 'ok'
      return id
    })
    await record('applied', async () => {
      const id = randomUUID()
      await approve(database, await propose(database, createArgs(id, { organizationName: 'D' })))
      return id
    })
    expect(Object.fromEntries(seen)).toEqual({
      pending: 'PENDING/none/-',
      failed_no_effect: 'FAILED/none/OWNER_UNRESOLVED',
      unknown: 'FAILED/unknown/OUTCOME_UNKNOWN',
      applied: 'APPLIED/applied/-',
    })
  })

  it('an audit or auto-apply failure after the record exists never hides the operation id', async () => {
    const database = fakeDatabase()
    const operationId = randomUUID()
    database.operatorAuditEvent.create = async () => {
      throw new Error('audit outage')
    }
    const view = await propose(database, createArgs(operationId))
    expect(view.status).toBe('PENDING')
    expect((await getOperation(database, operationId)).operationId).toBe(operationId)
  })

  it('the unknown-operation lookup explains that nothing is recorded', () => {
    const body = errorBody('NOT_FOUND', 'operator.get_operation', 'r', {
      operationRecorded: false,
    }) as any
    expect(body.operationRecorded).toBe(false)
  })
})
