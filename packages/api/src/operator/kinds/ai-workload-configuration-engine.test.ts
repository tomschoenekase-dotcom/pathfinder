/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory Prisma delegates, no external database */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_CENTRAL_MODEL_REGISTRY, modelIsSelectableForWorkload } from '@pathfinder/ai'
import { resolveOperatorConfig } from '../config'
import { approveAndApplyProposal, createKindRegistry, createProposal } from '../proposals'
import { VENUE_AI_CONFIGURATION_KINDS, venueAiConfigurationKind } from './ai-workload-configuration'

// Keep the schemas, operator engine and canonical DB actions real. Only persistence is local.
const now = new Date('2030-01-01T12:00:00Z')
const scope = { tenantId: 'tenant-a', venueId: 'venue-a', workloadId: 'guest-chat' }
const grant = {
  grantId: 'grant-a',
  clientId: 'client-a',
  userId: 'owner-a',
  allTenants: false,
  tenantIds: ['tenant-a'],
  capabilities: ['venues:propose'] as const,
}
const resolution = resolveOperatorConfig({
  OPERATOR_OAUTH_ENABLED: true,
  OPERATOR_OAUTH_ISSUER: 'https://app.operator.test',
  OPERATOR_OAUTH_PEPPERS: 'k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  OPERATOR_OAUTH_REDIRECT_ORIGINS: 'https://connector.example.com',
  OPERATOR_OAUTH_ALLOWED_USER_IDS: 'owner-a',
  RAILWAY_ENVIRONMENT: 'staging',
} as never)
if (resolution.status !== 'ready') throw new Error('operator config not ready')
const config = resolution.config
const kinds = createKindRegistry(VENUE_AI_CONFIGURATION_KINDS)

function harness() {
  const rows: any[] = []
  let override: any = null
  const database: any = {
    tenant: {
      findUnique: async () => ({ id: scope.tenantId }),
      findFirst: async () => ({ id: scope.tenantId }),
    },
    venue: { findFirst: async () => ({ id: scope.venueId }) },
    operatorProposal: {
      findUnique: async ({ where }: any) =>
        rows.find((row) =>
          where.id
            ? row.id === where.id
            : row.operationId === where.grantId_operationId.operationId,
        ) ?? null,
      create: async ({ data }: any) => {
        const row = {
          id: randomUUID(),
          status: 'PENDING',
          attempt: 0,
          fenceToken: 0,
          applyClaimedAt: null,
          applyStartedAt: null,
          planId: null,
          jobGrantId: null,
          autoApproved: false,
          failureCode: null,
          result: null,
          ...data,
        }
        rows.push(row)
        return row
      },
      updateMany: async ({ where, data }: any) => {
        const hits = rows.filter((row) =>
          Object.entries(where).every(([key, value]) => row[key] === value),
        )
        for (const row of hits)
          for (const [key, value] of Object.entries(data))
            row[key] =
              value && typeof value === 'object' && 'increment' in value
                ? row[key] + (value as any).increment
                : value
        return { count: hits.length }
      },
    },
    operatorGrant: {
      findUnique: async () => ({
        ...grant,
        id: grant.grantId,
        revokedAt: null,
        expiresAt: new Date('2099-01-01'),
        client: { revokedAt: null },
      }),
    },
    operatorPolicyState: { findUnique: async () => null },
    // Even an explicit AUTO policy may not auto-apply these spend-affecting kinds in review mode.
    operatorAutonomyPolicy: { findUnique: async () => ({ mode: 'AUTO', allowedKinds: [] }) },
    operatorAuditEvent: { create: vi.fn() },
    aiWorkloadConfigurationOverride: { findFirst: async () => null },
    aiScopedWorkloadConfigurationOverride: {
      findFirst: async ({ where }: any) =>
        where.venueScopeKey === scope.venueId ? override : null,
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    aiScopedWorkloadConfigurationHistory: { create: vi.fn() },
    auditLog: { create: vi.fn() },
  }
  database.$transaction = vi.fn(async (run: any) => run(database))
  return {
    database,
    rows,
    insertOverride: () => {
      override = {
        id: 'raced-override',
        workloadId: 'guest-chat',
        revision: 1,
        enabled: false,
        isTombstone: true,
        unsafeChangesEnabled: false,
        fallbackModelKeys: [],
        reason: 'Another operator',
        createdAt: now,
        updatedAt: now,
      }
    },
  }
}

describe('AI workload MCP engine and canonical action boundaries', () => {
  beforeEach(() => vi.stubEnv('OPERATOR_APPROVAL_MODE', 'review'))
  afterEach(() => vi.unstubAllEnvs())

  it.each(VENUE_AI_CONFIGURATION_KINDS)(
    '$kind stays pending under an AUTO policy in review mode',
    async (kind) => {
      const h = harness()
      const args = {
        ...scope,
        operationId: randomUUID(),
        reason: 'Owner review',
        ...(kind === venueAiConfigurationKind
          ? { expectedRevision: null, enabled: false, values: {} }
          : { expectedRevision: 1 }),
      }
      const view = await createProposal(kind.tool, args, {
        database: h.database,
        kinds,
        config,
        grant,
        now,
        requestId: randomUUID(),
      } as any)
      expect(view.status).toBe('PENDING')
      expect(h.rows[0].autoApproved).toBe(false)
      expect(h.database.$transaction).not.toHaveBeenCalled()
      expect(h.database.aiScopedWorkloadConfigurationOverride.create).not.toHaveBeenCalled()
      expect(h.database.aiScopedWorkloadConfigurationOverride.updateMany).not.toHaveBeenCalled()
    },
  )

  it('rejects a null-create revision when another override appears before human approval', async () => {
    const h = harness()
    await createProposal(
      venueAiConfigurationKind.tool,
      {
        ...scope,
        operationId: randomUUID(),
        expectedRevision: null,
        enabled: false,
        values: {},
        reason: 'Create staged override',
      },
      {
        database: h.database,
        kinds,
        config,
        grant,
        now,
        requestId: randomUUID(),
      } as any,
    )
    expect(h.rows[0].status).toBe('PENDING')
    h.insertOverride()
    const result = await approveAndApplyProposal(
      {
        proposalId: h.rows[0].id,
        argsHash: h.rows[0].argsHash,
        actorUserId: grant.userId,
        now,
        requestId: randomUUID(),
      },
      {
        database: h.database,
        kinds,
        allowedUserIds: config.allowedUserIds,
      },
    )
    expect(result.status).toBe('STALE')
    expect(result.failureCode).toBe('TARGET_CHANGED')
    expect(h.database.$transaction).toHaveBeenCalledTimes(1)
    expect(h.database.aiScopedWorkloadConfigurationOverride.create).not.toHaveBeenCalled()
    expect(h.database.aiScopedWorkloadConfigurationOverride.updateMany).not.toHaveBeenCalled()
    expect(h.database.aiScopedWorkloadConfigurationHistory.create).not.toHaveBeenCalled()
  })

  it('rejects registered models outside the visitor workload route family', () => {
    const key = Object.keys(AI_CENTRAL_MODEL_REGISTRY).find(
      (key) => !modelIsSelectableForWorkload(key as any, 'guest-chat'),
    )
    expect(key).toBeDefined()
    expect(() =>
      venueAiConfigurationKind.parse({
        ...scope,
        operationId: randomUUID(),
        expectedRevision: null,
        enabled: true,
        values: { primaryModelKey: key },
        reason: 'Invalid route family',
      }),
    ).toThrow('AI model selection is not registered for this workload')
  })
})
