/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory database double with loose row shapes */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'

import { AI_PUBLIC_VISITOR_CHAT_ROUTE_KEYS } from '@pathfinder/ai'
import {
  OPERATOR_GUEST_MODEL_KEYS,
  OPERATOR_GUEST_MODEL_INPUT_KEYS,
  type OperatorCapability,
} from '@pathfinder/contracts/operator-mcp'

/**
 * venues.get_guest_model, venues.propose_guest_model and venues.propose_guest_model_reset, run
 * through the real operator registry, proposal service and canonical save/reset actions against an
 * in-memory database. Every tenant, venue and person here is fictional.
 */

const providers = vi.hoisted(() => ({ available: new Set(['openai', 'anthropic']) }))
vi.mock('../../routers/admin/ai-provider-connections', () => ({
  providerHasExecutionKey: (provider: string) => providers.available.has(provider),
}))

import { resolveOperatorConfig } from '../config'
import { OperatorNotFoundError } from '../grants'
import { approveAndApplyProposal, OperatorProposalError } from '../proposals'
import { createOperatorRegistry } from '../registry'
import { compareGuestModelRates, venuesGuestModelKind } from './venues-guest-model'

type Row = Record<string, any>

const TENANT_A = 'tenant_harbor'
const TENANT_B = 'tenant_orchard'
const VENUE_A = 'venue_harbor_museum'
const VENUE_A2 = 'venue_harbor_garden'
const VENUE_B = 'venue_orchard_zoo'
const NOW = new Date('2026-10-26T15:00:00Z')

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      if ('in' in expected) return (expected.in as unknown[]).includes(row[key])
      if ('increment' in expected) return true
    }
    if (expected instanceof Date)
      return row[key] instanceof Date && row[key].getTime() === expected.getTime()
    return row[key] === expected
  })
}

function applyData(row: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in (value as Row)) {
      row[key] += (value as Row).increment
    } else row[key] = value
  }
}

function project(row: Row | undefined, select?: Row) {
  if (!row) return null
  if (!select) return { ...row }
  return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]))
}

type World = ReturnType<typeof newWorld>
function newWorld() {
  return {
    proposals: [] as Row[],
    overrides: [] as Row[],
    history: [] as Row[],
    auditLogs: [] as Row[],
    operatorAudits: [] as Row[],
    tenants: new Set([TENANT_A, TENANT_B]),
    venues: [
      { id: VENUE_A, tenantId: TENANT_A },
      { id: VENUE_A2, tenantId: TENANT_A },
      { id: VENUE_B, tenantId: TENANT_B },
    ],
  }
}

function fakeDatabase(world: World, grantRow: Row) {
  const database: Row = {
    $transaction: async (run: (tx: any) => Promise<unknown>) => run(database),
    operatorProposal: {
      findUnique: async ({ where }: Row) =>
        (where.grantId_operationId
          ? world.proposals.find(
              (row) =>
                row.grantId === where.grantId_operationId.grantId &&
                row.operationId === where.grantId_operationId.operationId,
            )
          : world.proposals.find((row) => row.id === where.id)) ?? null,
      findFirst: async ({ where }: Row) =>
        world.proposals.find((row) => matches(row, where)) ?? null,
      create: async ({ data }: Row) => {
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
          jobGrantId: null,
          ...data,
        }
        world.proposals.push(row)
        return row
      },
      updateMany: async ({ where, data }: Row) => {
        const hits = world.proposals.filter((row) => matches(row, where))
        hits.forEach((row) => applyData(row, data))
        return { count: hits.length }
      },
    },
    operatorPlan: { findUnique: async () => null },
    operatorPolicyState: { findUnique: async () => null },
    operatorAutonomyPolicy: { findUnique: async () => null },
    operatorAuditEvent: {
      create: async ({ data }: Row) => {
        world.operatorAudits.push(data)
      },
      count: async () => 0,
    },
    operatorGrant: { findUnique: async () => grantRow },
    tenant: {
      findUnique: async ({ where }: Row) => (world.tenants.has(where.id) ? { id: where.id } : null),
      findFirst: async ({ where }: Row) => (world.tenants.has(where.id) ? { id: where.id } : null),
    },
    venue: {
      findFirst: async ({ where }: Row) =>
        project(
          world.venues.find((venue) => venue.id === where.id && venue.tenantId === where.tenantId),
          { id: true },
        ),
    },
    aiWorkloadConfigurationOverride: { findFirst: async () => null },
    aiScopedWorkloadConfigurationOverride: {
      findFirst: async ({ where, select }: Row) =>
        project(
          world.overrides.find((row) => matches(row, where)),
          select,
        ),
      create: async ({ data, select }: Row) => {
        if (
          world.overrides.some(
            (row) =>
              row.tenantId === data.tenantId &&
              row.venueScopeKey === data.venueScopeKey &&
              row.workloadId === data.workloadId,
          )
        ) {
          throw Object.assign(new Error('unique'), { code: 'P2002' })
        }
        const row = {
          id: randomUUID(),
          createdAt: NOW,
          updatedAt: NOW,
          ...data,
        }
        world.overrides.push(row)
        return project(row, select)
      },
      updateMany: async ({ where, data }: Row) => {
        const hits = world.overrides.filter((row) => matches(row, where))
        hits.forEach((row) => applyData(row, { ...data, updatedAt: NOW }))
        return { count: hits.length }
      },
    },
    aiScopedWorkloadConfigurationHistory: {
      create: async ({ data }: Row) => {
        world.history.push(data)
        return data
      },
    },
    auditLog: {
      create: async ({ data }: Row) => {
        world.auditLogs.push(data)
        return data
      },
    },
  }
  return database
}

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

const CAPABILITIES: OperatorCapability[] = ['venues:read', 'venues:propose']

/** A grant over tenant A only, unless a test widens it. */
function harness(options: { tenantIds?: string[] } = {}) {
  const world = newWorld()
  const tenantIds = options.tenantIds ?? [TENANT_A]
  const grant = {
    grantId: 'grant_1',
    clientId: 'client_1',
    userId: 'user_owner',
    allTenants: false,
    tenantIds,
    capabilities: CAPABILITIES,
  }
  const database = fakeDatabase(world, {
    id: 'grant_1',
    clientId: 'client_1',
    userId: 'user_owner',
    allTenants: false,
    tenantIds,
    capabilities: CAPABILITIES,
    revokedAt: null,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    client: { revokedAt: null },
  })
  const registry = createOperatorRegistry()
  const call = (name: string, args: Row) =>
    registry.callTool(name, args, {
      config,
      database: database as never,
      grant,
      now: NOW,
      requestId: randomUUID(),
      venueRead: vi.fn() as never,
    }) as Promise<any>
  return { world, database, registry, call }
}

const venueOverride = (world: World, venueId = VENUE_A) =>
  world.overrides.find((row) => row.venueScopeKey === venueId && row.workloadId === 'guest-chat')

let savedEnv: Record<string, string | undefined>
beforeEach(() => {
  savedEnv = {
    OPERATOR_APPROVAL_MODE: process.env.OPERATOR_APPROVAL_MODE,
    GUEST_CHAT_DEFAULT_MODEL_KEY: process.env.GUEST_CHAT_DEFAULT_MODEL_KEY,
  }
  // The production default: writes apply in the same call.
  delete process.env.OPERATOR_APPROVAL_MODE
  delete process.env.GUEST_CHAT_DEFAULT_MODEL_KEY
  providers.available = new Set(['openai', 'anthropic'])
})
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('allowlist', () => {
  it('only offers governed public visitor chat routes, with Sol + Fast first', () => {
    for (const key of OPERATOR_GUEST_MODEL_KEYS) {
      expect(AI_PUBLIC_VISITOR_CHAT_ROUTE_KEYS as readonly string[]).toContain(key)
    }
    expect(OPERATOR_GUEST_MODEL_KEYS[0]).toBe('guest-chat-sol-fast')
    expect(OPERATOR_GUEST_MODEL_KEYS).not.toContain('guest-chat-deepseek-pro')
  })
})

describe('venues.get_guest_model', () => {
  it('reports the platform default and every choice with a description', async () => {
    const { call } = harness()
    const view = await call('venues.get_guest_model', { tenantId: TENANT_A, venueId: VENUE_A })
    expect(view.effective).toMatchObject({ modelKey: 'guest-chat', source: 'PLATFORM_DEFAULT' })
    expect(view.deploymentDefaultModelKey).toBeNull()
    expect(view.venueOverride).toBeNull()
    expect(view.choices.map((choice: Row) => choice.modelKey)).toEqual([
      ...OPERATOR_GUEST_MODEL_KEYS,
    ])
    const recommended = view.choices.filter((choice: Row) => choice.recommended)
    expect(recommended.map((choice: Row) => choice.modelKey)).toEqual(['guest-chat-sol-fast'])
    for (const choice of view.choices) expect(choice.description.length).toBeGreaterThan(20)
    expect(view.guidance).toMatch(/bigger/)
  })

  it('names the deployment default from GUEST_CHAT_DEFAULT_MODEL_KEY', async () => {
    process.env.GUEST_CHAT_DEFAULT_MODEL_KEY = 'guest-chat-sol-fast'
    const { call } = harness()
    const view = await call('venues.get_guest_model', { tenantId: TENANT_A, venueId: VENUE_A })
    expect(view.effective).toMatchObject({
      modelKey: 'guest-chat-sol-fast',
      source: 'DEPLOYMENT_DEFAULT',
      fastMode: true,
      provider: 'openai',
    })
    expect(view.deploymentDefaultModelKey).toBe('guest-chat-sol-fast')
    expect(view.choices.find((choice: Row) => choice.current)?.modelKey).toBe('guest-chat-sol-fast')
  })

  it('never reads another tenant or a venue outside its tenant', async () => {
    const { call } = harness()
    await expect(
      call('venues.get_guest_model', { tenantId: TENANT_B, venueId: VENUE_B }),
    ).rejects.toBeInstanceOf(OperatorNotFoundError)
    await expect(
      call('venues.get_guest_model', { tenantId: TENANT_A, venueId: VENUE_B }),
    ).rejects.toBeInstanceOf(OperatorNotFoundError)
  })
})

describe('venues.propose_guest_model', () => {
  it.each([
    ['sol', 'guest-chat-sol-fast'],
    ['Sol', 'guest-chat-sol-fast'],
    ['terra', 'guest-chat-terra-fast'],
    ['Terra', 'guest-chat-terra-fast'],
    ['luna', 'guest-chat-luna'],
    ['Luna', 'guest-chat-luna'],
  ])('stores the %s alias as the canonical %s key and resets cleanly', async (alias, canonical) => {
    const { world, call } = harness()
    const result = await call('venues.propose_guest_model', {
      tenantId: TENANT_A,
      venueId: VENUE_A,
      modelKey: alias,
      operationId: randomUUID(),
    })
    expect(result.status).toBe('APPLIED')
    expect(result.result.effective.modelKey).toBe(canonical)
    expect(venueOverride(world)!.primaryModelKey).toBe(canonical)
    const view = await call('venues.get_guest_model', { tenantId: TENANT_A, venueId: VENUE_A })
    expect(view.effective.modelKey).toBe(canonical)
    const reset = await call('venues.propose_guest_model_reset', {
      tenantId: TENANT_A,
      venueId: VENUE_A,
      operationId: randomUUID(),
    })
    expect(reset.result.effective.modelKey).toBe('guest-chat')
  })

  it('warns that setting a model re-enables a disabled override and preserves its settings', async () => {
    const { world, call } = harness()
    await call('venues.propose_guest_model', {
      tenantId: TENANT_A,
      venueId: VENUE_A,
      modelKey: 'sol',
      operationId: randomUUID(),
    })
    Object.assign(venueOverride(world)!, {
      enabled: false,
      timeoutMs: 9000,
      timeoutMsSet: true,
      fallbackEnabled: true,
      fallbackEnabledSet: true,
      fallbackModelKeys: ['guest-chat-luna'],
      fallbackModelKeysSet: true,
      maxAttempts: 1,
      maxAttemptsSet: true,
      maxOutputTokens: 768,
      maxOutputTokensSet: true,
      requestBudgetCeilingE8Usd: '1000000',
      requestBudgetCeilingE8UsdSet: true,
    })
    const before = await call('venues.get_guest_model', { tenantId: TENANT_A, venueId: VENUE_A })
    expect(before.venueOverride.active).toBe(false)
    expect(before.effective.modelKey).toBe('guest-chat')
    expect(before.guidance).toContain('re-enables this disabled override')
    const set = await call('venues.propose_guest_model', {
      tenantId: TENANT_A,
      venueId: VENUE_A,
      modelKey: 'terra',
      operationId: randomUUID(),
    })
    expect(set.result.warnings).toEqual([expect.stringContaining('stored timeout, fallback')])
    expect(venueOverride(world)).toMatchObject({
      enabled: true,
      primaryModelKey: 'guest-chat-terra-fast',
      timeoutMs: 9000,
      fallbackEnabled: true,
      fallbackModelKeys: ['guest-chat-luna'],
      maxAttempts: 1,
      maxOutputTokens: 768,
      requestBudgetCeilingE8Usd: '1000000',
    })
    const after = await call('venues.get_guest_model', { tenantId: TENANT_A, venueId: VENUE_A })
    expect(after.venueOverride.active).toBe(true)
    expect(after.effective.modelKey).toBe('guest-chat-terra-fast')
    expect(after.guidance).not.toContain('re-enables this disabled override')
  })

  it('sets the venue model through the canonical save action and reads back as the venue override', async () => {
    process.env.GUEST_CHAT_DEFAULT_MODEL_KEY = 'guest-chat-luna'
    const { world, call } = harness()
    const view = await call('venues.propose_guest_model', {
      tenantId: TENANT_A,
      venueId: VENUE_A,
      modelKey: 'guest-chat-sol-fast',
      reason: 'Owner asked for the best model',
      operationId: randomUUID(),
    })
    expect(view.status).toBe('APPLIED')
    expect(view.result).toMatchObject({
      venueId: VENUE_A,
      modelKey: 'guest-chat-sol-fast',
      changed: true,
      revision: 1,
      effectiveModelKey: 'guest-chat-sol-fast',
    })
    const row = venueOverride(world)!
    expect(row).toMatchObject({
      tenantId: TENANT_A,
      venueId: VENUE_A,
      scopeLevel: 'VENUE',
      enabled: true,
      primaryModelKey: 'guest-chat-sol-fast',
      primaryModelKeySet: true,
      unsafeChangesEnabled: true,
      isTombstone: false,
      createdBy: 'user_owner',
    })
    expect(row.reason).toMatch(/^Applied from operator proposal .+: Owner asked/)
    expect(world.history).toHaveLength(1)
    expect(world.auditLogs[0]).toMatchObject({ tenantId: TENANT_A })

    const after = await call('venues.get_guest_model', { tenantId: TENANT_A, venueId: VENUE_A })
    expect(after.effective).toMatchObject({
      modelKey: 'guest-chat-sol-fast',
      source: 'VENUE_OVERRIDE',
    })
    expect(after.venueOverride).toMatchObject({
      active: true,
      modelKey: 'guest-chat-sol-fast',
      revision: 1,
    })
    // A sibling venue in the same tenant keeps the deployment default.
    const sibling = await call('venues.get_guest_model', { tenantId: TENANT_A, venueId: VENUE_A2 })
    expect(sibling.effective).toMatchObject({
      modelKey: 'guest-chat-luna',
      source: 'DEPLOYMENT_DEFAULT',
    })
  })

  it('returns the same receipt for a replayed operationId and refuses it for different arguments', async () => {
    const { world, call } = harness()
    const operationId = randomUUID()
    const args = { tenantId: TENANT_A, venueId: VENUE_A, modelKey: 'guest-chat-terra-fast' }
    const first = await call('venues.propose_guest_model', { ...args, operationId })
    const again = await call('venues.propose_guest_model', { ...args, operationId })
    expect(again.proposalId).toBe(first.proposalId)
    expect(again.status).toBe('APPLIED')
    expect(again.result).toEqual(first.result)
    expect(world.proposals).toHaveLength(1)
    expect(world.history).toHaveLength(1)
    expect(venueOverride(world)!.revision).toBe(1)

    const reused = await call('venues.propose_guest_model', {
      ...args,
      modelKey: 'guest-chat-sol-fast',
      operationId,
    }).catch((error: unknown) => error)
    expect(reused).toBeInstanceOf(OperatorProposalError)
    expect((reused as OperatorProposalError).code).toBe('OPERATION_ID_REUSED')
    expect(venueOverride(world)!.primaryModelKey).toBe('guest-chat-terra-fast')
  })

  it('refuses another tenant, a venue moved across tenants, and records nothing', async () => {
    const { world, call } = harness()
    for (const target of [
      { tenantId: TENANT_B, venueId: VENUE_B },
      { tenantId: TENANT_A, venueId: VENUE_B },
      { tenantId: TENANT_B, venueId: VENUE_A },
    ]) {
      await expect(
        call('venues.propose_guest_model', {
          ...target,
          modelKey: 'guest-chat-sol-fast',
          operationId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(OperatorNotFoundError)
      await expect(
        call('venues.propose_guest_model_reset', { ...target, operationId: randomUUID() }),
      ).rejects.toBeInstanceOf(OperatorNotFoundError)
    }
    expect(world.proposals).toHaveLength(0)
    expect(world.overrides).toHaveLength(0)
  })

  it('refuses a model key outside the allowlist before recording anything', async () => {
    const { world, call } = harness()
    for (const modelKey of [
      'guest-chat-deepseek-pro',
      'guest-chat-openai',
      'agent-run',
      'gpt-6.1-sol',
      '',
    ]) {
      await expect(
        call('venues.propose_guest_model', {
          tenantId: TENANT_A,
          venueId: VENUE_A,
          modelKey,
          operationId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(ZodError)
    }
    expect(world.proposals).toHaveLength(0)
    expect(world.overrides).toHaveLength(0)
  })

  it('refuses a model whose provider has no key on this deployment', async () => {
    providers.available = new Set(['anthropic'])
    const { world, call } = harness()
    const refused = await call('venues.propose_guest_model', {
      tenantId: TENANT_A,
      venueId: VENUE_A,
      modelKey: 'guest-chat-sol-fast',
      operationId: randomUUID(),
    }).catch((error: unknown) => error)
    expect((refused as { code?: string }).code).toBe('MODEL_UNAVAILABLE')
    expect(world.proposals).toHaveLength(0)
    const view = await call('venues.get_guest_model', { tenantId: TENANT_A, venueId: VENUE_A })
    expect(view.choices.find((choice: Row) => choice.modelKey === 'guest-chat')?.available).toBe(
      true,
    )
    expect(
      view.choices.find((choice: Row) => choice.modelKey === 'guest-chat-sol-fast')?.available,
    ).toBe(false)
  })

  it('goes stale when the override moved past the expected revision', async () => {
    const { world, call } = harness()
    await call('venues.propose_guest_model', {
      tenantId: TENANT_A,
      venueId: VENUE_A,
      modelKey: 'guest-chat-terra-fast',
      operationId: randomUUID(),
    })
    const stale = await call('venues.propose_guest_model', {
      tenantId: TENANT_A,
      venueId: VENUE_A,
      modelKey: 'guest-chat-sol-fast',
      expectedRevision: null,
      operationId: randomUUID(),
    })
    expect(stale.status).toBe('STALE')
    expect(venueOverride(world)!.primaryModelKey).toBe('guest-chat-terra-fast')
    const fresh = await call('venues.propose_guest_model', {
      tenantId: TENANT_A,
      venueId: VENUE_A,
      modelKey: 'guest-chat-sol-fast',
      expectedRevision: 1,
      operationId: randomUUID(),
    })
    expect(fresh.status).toBe('APPLIED')
    expect(venueOverride(world)).toMatchObject({
      primaryModelKey: 'guest-chat-sol-fast',
      revision: 2,
    })
  })

  it('keeps other stored settings and makes no write when the model is already set', async () => {
    const { world, call } = harness()
    world.overrides.push({
      id: 'override_existing',
      tenantId: TENANT_A,
      venueId: VENUE_A,
      venueScopeKey: VENUE_A,
      scopeLevel: 'VENUE',
      workloadId: 'guest-chat',
      enabled: true,
      primaryModelKey: null,
      primaryModelKeySet: false,
      fallbackEnabled: null,
      fallbackEnabledSet: false,
      fallbackModelKeys: [],
      fallbackModelKeysSet: false,
      timeoutMs: 9_000,
      timeoutMsSet: true,
      maxAttempts: null,
      maxAttemptsSet: false,
      maxOutputTokens: null,
      maxOutputTokensSet: false,
      requestBudgetCeilingE8Usd: null,
      requestBudgetCeilingE8UsdSet: false,
      unsafeChangesEnabled: false,
      isTombstone: false,
      reason: 'Dashboard timeout',
      revision: 3,
      createdBy: 'user_admin',
      updatedBy: 'user_admin',
      createdAt: NOW,
      updatedAt: NOW,
    })
    const set = await call('venues.propose_guest_model', {
      tenantId: TENANT_A,
      venueId: VENUE_A,
      modelKey: 'guest-chat-sol-fast',
      operationId: randomUUID(),
    })
    expect(set.status).toBe('APPLIED')
    expect(venueOverride(world)).toMatchObject({
      primaryModelKey: 'guest-chat-sol-fast',
      timeoutMs: 9_000,
      timeoutMsSet: true,
      revision: 4,
    })
    const same = await call('venues.propose_guest_model', {
      tenantId: TENANT_A,
      venueId: VENUE_A,
      modelKey: 'guest-chat-sol-fast',
      operationId: randomUUID(),
    })
    expect(same.status).toBe('APPLIED')
    expect(same.result).toMatchObject({ changed: false, revision: 4 })
    expect(venueOverride(world)!.revision).toBe(4)

    // Reset clears only the model and keeps the dashboard timeout.
    const reset = await call('venues.propose_guest_model_reset', {
      tenantId: TENANT_A,
      venueId: VENUE_A,
      operationId: randomUUID(),
    })
    expect(reset.status).toBe('APPLIED')
    expect(venueOverride(world)).toMatchObject({
      primaryModelKeySet: false,
      timeoutMs: 9_000,
      isTombstone: false,
      revision: 5,
    })
    const view = await call('venues.get_guest_model', { tenantId: TENANT_A, venueId: VENUE_A })
    expect(view.effective).toMatchObject({ modelKey: 'guest-chat', source: 'PLATFORM_DEFAULT' })
    expect(view.venueOverride).toMatchObject({ modelKey: null, otherSettings: ['timeoutMs'] })
  })

  it('waits for a person in review mode, then applies once approved', async () => {
    process.env.OPERATOR_APPROVAL_MODE = 'review'
    const { world, database, registry, call } = harness()
    const pending = await call('venues.propose_guest_model', {
      tenantId: TENANT_A,
      venueId: VENUE_A,
      modelKey: 'guest-chat-sol-fast',
      operationId: randomUUID(),
    })
    expect(pending.status).toBe('PENDING')
    expect(world.overrides).toHaveLength(0)
    const applied = await approveAndApplyProposal(
      {
        proposalId: pending.proposalId,
        argsHash: world.proposals[0]!.argsHash,
        actorUserId: 'user_owner',
        requestId: randomUUID(),
        now: NOW,
      },
      { database: database as never, kinds: registry.kinds, allowedUserIds: config.allowedUserIds },
    )
    expect(applied.status).toBe('APPLIED')
    expect(venueOverride(world)!.primaryModelKey).toBe('guest-chat-sol-fast')
  })
})

describe('venues.propose_guest_model_reset', () => {
  it.each([
    ['venues.propose_guest_model', 'guest-chat-sol-fast'],
    ['venues.propose_guest_model', 'guest-chat-sol'],
    ['venues.propose_guest_model_reset', undefined],
  ])('refuses a late concurrent update during %s (%s)', async (tool, modelKey) => {
    const { world, database, call } = harness()
    await call('venues.propose_guest_model', {
      tenantId: TENANT_A,
      venueId: VENUE_A,
      modelKey: 'guest-chat-terra-fast',
      operationId: randomUUID(),
    })
    const updateProposal = database.operatorProposal.updateMany
    database.operatorProposal.updateMany = async (input: Row) => {
      // A dashboard edit lands after the proposal's version check but before its domain write.
      if (input.data.applyStartedAt) {
        Object.assign(venueOverride(world)!, { primaryModelKey: 'guest-chat-sol', revision: 2 })
      }
      return updateProposal(input)
    }
    const result = await call(tool!, {
      tenantId: TENANT_A,
      venueId: VENUE_A,
      expectedRevision: 1,
      ...(modelKey ? { modelKey } : {}),
      operationId: randomUUID(),
    })
    expect(result.status).toBe('STALE')
    expect(venueOverride(world)).toMatchObject({ primaryModelKey: 'guest-chat-sol', revision: 2 })
    expect(world.history).toHaveLength(1)
  })

  it('returns the venue to the inherited default and is a no-op when nothing is set', async () => {
    process.env.GUEST_CHAT_DEFAULT_MODEL_KEY = 'guest-chat-sol-fast'
    const { world, call } = harness()
    await call('venues.propose_guest_model', {
      tenantId: TENANT_A,
      venueId: VENUE_A,
      modelKey: 'guest-chat-terra-fast',
      operationId: randomUUID(),
    })
    const operationId = randomUUID()
    const reset = await call('venues.propose_guest_model_reset', {
      tenantId: TENANT_A,
      venueId: VENUE_A,
      reason: 'Back to the default',
      expectedRevision: 1,
      operationId,
    })
    expect(reset.status).toBe('APPLIED')
    expect(reset.result).toMatchObject({
      changed: true,
      revision: 2,
      effectiveModelKey: 'guest-chat-sol-fast',
    })
    expect(venueOverride(world)).toMatchObject({ isTombstone: true, primaryModelKeySet: false })
    expect(world.history.at(-1)).toMatchObject({ action: 'RESET' })

    const replay = await call('venues.propose_guest_model_reset', {
      tenantId: TENANT_A,
      venueId: VENUE_A,
      reason: 'Back to the default',
      expectedRevision: 1,
      operationId,
    })
    expect(replay.proposalId).toBe(reset.proposalId)
    expect(venueOverride(world)!.revision).toBe(2)

    const view = await call('venues.get_guest_model', { tenantId: TENANT_A, venueId: VENUE_A })
    expect(view.effective).toMatchObject({
      modelKey: 'guest-chat-sol-fast',
      source: 'DEPLOYMENT_DEFAULT',
    })
    expect(view.venueOverride).toMatchObject({ active: false, modelKey: null, revision: 2 })

    const nothing = await call('venues.propose_guest_model_reset', {
      tenantId: TENANT_A,
      venueId: VENUE_A2,
      operationId: randomUUID(),
    })
    expect(nothing.status).toBe('APPLIED')
    expect(nothing.result).toMatchObject({ changed: false, revision: null })
    expect(venueOverride(world, VENUE_A2)).toBeUndefined()

    // Setting again after a reset reuses the reset row at its next revision.
    const again = await call('venues.propose_guest_model', {
      tenantId: TENANT_A,
      venueId: VENUE_A,
      modelKey: 'guest-chat-sol',
      expectedRevision: 2,
      operationId: randomUUID(),
    })
    expect(again.status).toBe('APPLIED')
    expect(venueOverride(world)).toMatchObject({
      isTombstone: false,
      primaryModelKey: 'guest-chat-sol',
      revision: 3,
    })
  })
})

describe('owner says "for this venue, switch from Sol to 6.1 Terra"', () => {
  /** What an agent does with the read: match the spoken name against alsoKnownAs and model. */
  function choiceFor(view: Row, spoken: string): Row[] {
    const wanted = spoken.trim().toLowerCase()
    return view.choices.filter(
      (choice: Row) =>
        choice.model.toLowerCase() === wanted ||
        choice.alsoKnownAs.some((name: string) => name.toLowerCase() === wanted),
    )
  }

  it('lists registry facts for every choice and maps each common name to exactly one key', async () => {
    const { AI_CENTRAL_MODEL_REGISTRY } = await import('@pathfinder/ai')
    const { call } = harness()
    const view = await call('venues.get_guest_model', { tenantId: TENANT_A, venueId: VENUE_A })
    for (const choice of view.choices) {
      const central =
        AI_CENTRAL_MODEL_REGISTRY[choice.modelKey as keyof typeof AI_CENTRAL_MODEL_REGISTRY]
      expect(choice.provider).toBe(central.provider)
      expect(choice.model).toBe(central.model)
      expect(choice.pricingUsdPerMillionTokens.input).toBe(central.pricingUsdPerMillionTokens.input)
      expect(choice.pricingUsdPerMillionTokens.output).toBe(
        central.pricingUsdPerMillionTokens.output,
      )
    }
    const names = view.choices.flatMap((choice: Row) =>
      choice.alsoKnownAs.map((n: string) => n.toLowerCase()),
    )
    expect(new Set(names).size).toBe(names.length)
    expect(choiceFor(view, '6.1 Terra').map((choice) => choice.modelKey)).toEqual([
      'guest-chat-terra-fast',
    ])
    expect(choiceFor(view, 'gpt-6.1-terra')).toHaveLength(1)
    expect(view.choices.find((c: Row) => c.modelKey === 'guest-chat-terra-fast')).toMatchObject({
      model: 'gpt-6.1-terra',
      fastMode: true,
      provider: 'openai',
    })
    // A model with no visitor chat route is not offered under any name.
    expect(choiceFor(view, 'gpt-6.1-astra')).toHaveLength(0)
    expect(view.guidance).toMatch(/only with Fast mode/)
  })

  it('changes one venue, returns a before/after receipt, and restores the inherited default', async () => {
    process.env.GUEST_CHAT_DEFAULT_MODEL_KEY = 'guest-chat-sol-fast'
    const { call } = harness()
    const view = await call('venues.get_guest_model', { tenantId: TENANT_A, venueId: VENUE_A })
    const [terra] = choiceFor(view, '6.1 Terra')
    const set = await call('venues.propose_guest_model', {
      tenantId: TENANT_A,
      venueId: VENUE_A,
      modelKey: terra!.modelKey,
      expectedRevision: view.venueOverride?.revision ?? null,
      reason: 'Owner asked for Terra on this venue',
      operationId: randomUUID(),
    })
    expect(set.status).toBe('APPLIED')
    expect(set.result).toMatchObject({
      scope: 'this venue only',
      changed: true,
      previous: {
        modelKey: 'guest-chat-sol-fast',
        source: 'DEPLOYMENT_DEFAULT',
        model: 'gpt-6.1-sol',
        fastMode: true,
      },
      effective: {
        modelKey: 'guest-chat-terra-fast',
        source: 'VENUE_OVERRIDE',
        model: 'gpt-6.1-terra',
        fastMode: true,
      },
    })
    const sibling = await call('venues.get_guest_model', { tenantId: TENANT_A, venueId: VENUE_A2 })
    expect(sibling.effective).toMatchObject({
      modelKey: 'guest-chat-sol-fast',
      source: 'DEPLOYMENT_DEFAULT',
    })

    const reset = await call('venues.propose_guest_model_reset', {
      tenantId: TENANT_A,
      venueId: VENUE_A,
      operationId: randomUUID(),
    })
    expect(reset.status).toBe('APPLIED')
    expect(reset.result).toMatchObject({
      changed: true,
      previous: { modelKey: 'guest-chat-terra-fast', source: 'VENUE_OVERRIDE' },
      effective: { modelKey: 'guest-chat-sol-fast', model: 'gpt-6.1-sol' },
    })
    const after = await call('venues.get_guest_model', { tenantId: TENANT_A, venueId: VENUE_A })
    expect(after.effective).toMatchObject({
      modelKey: 'guest-chat-sol-fast',
      source: 'DEPLOYMENT_DEFAULT',
    })
  })

  it('refuses a spoken or API model name instead of substituting a model', async () => {
    const { world, call } = harness()
    for (const modelKey of ['6.1 Terra', 'gpt-6.1-terra', 'guest-chat-terra']) {
      const error = await call('venues.propose_guest_model', {
        tenantId: TENANT_A,
        venueId: VENUE_A,
        modelKey,
        operationId: randomUUID(),
      }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(ZodError)
      expect((error as ZodError).issues[0]).toMatchObject({ code: 'invalid_value' })
      expect((error as ZodError).issues[0] as Row).toHaveProperty('values', [
        ...OPERATOR_GUEST_MODEL_INPUT_KEYS,
      ])
    }
    expect(world.proposals).toHaveLength(0)
    expect(world.overrides).toHaveLength(0)
  })
})

describe('visitor model cost preview', () => {
  it.each([
    ['guest-chat-luna', 'guest-chat-sol-fast', 'higher'],
    ['guest-chat-sol-fast', 'guest-chat-luna', 'lower'],
    ['guest-chat-luna', 'guest-chat-luna-reasoning', 'equal'],
    ['guest-chat-deepseek-pro', 'guest-chat', 'mixed'],
    ['unregistered-old-key', 'guest-chat-sol-fast', 'unavailable'],
  ])('compares %s to %s as %s without claiming an actual bill', (previous, proposed, direction) => {
    const comparison = compareGuestModelRates(previous, proposed)
    expect(comparison.direction).toBe(direction)
    expect(comparison.limitation).toContain('no total cost is guaranteed')
    expect(comparison.unit).toBe('USD per 1M tokens')
  })

  it('shows live current/new models and cost direction without writing', async () => {
    process.env.GUEST_CHAT_DEFAULT_MODEL_KEY = 'guest-chat-sol-fast'
    const { world, database } = harness()
    const args = venuesGuestModelKind.parse({
      tenantId: TENANT_A,
      venueId: VENUE_A,
      modelKey: 'luna',
      operationId: randomUUID(),
    })
    const preview = await venuesGuestModelKind.pendingChanges!(args, database as never)
    expect(preview).toContainEqual({
      field: 'Visitor chat model',
      before: 'guest-chat-sol-fast (gpt-6.1-sol)',
      after: 'guest-chat-luna (gpt-6-luna)',
    })
    expect(preview).toContainEqual({
      field: 'Input/output list rates',
      before: '$4 input / $20 output per 1M tokens',
      after: '$0.1 input / $0.5 output per 1M tokens',
    })
    expect(preview.find((change) => change.field === 'Cost direction')?.after).toContain(
      'Lower input/output list rates',
    )
    expect(world.overrides).toHaveLength(0)
    expect(world.proposals).toHaveLength(0)
  })

  it('includes the applied comparison while preserving approval behavior', async () => {
    process.env.GUEST_CHAT_DEFAULT_MODEL_KEY = 'guest-chat-sol-fast'
    const { call } = harness()
    const result = await call('venues.propose_guest_model', {
      tenantId: TENANT_A,
      venueId: VENUE_A,
      modelKey: 'luna',
      operationId: randomUUID(),
    })
    expect(result.status).toBe('APPLIED')
    expect(result.result.costComparison).toMatchObject({
      direction: 'lower',
      previous: { input: 4, output: 20 },
      proposed: { input: 0.1, output: 0.5 },
    })
  })
})
