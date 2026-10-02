import { describe, expect, it, vi } from 'vitest'

import {
  diffSnapshots,
  listOperatorAudit,
  listOperatorConnections,
  loadOperatorReview,
} from './admin-queries'
import type { OperatorDatabase } from './audit'
import type { OperatorKindRegistry } from './proposals'

const kinds = new Map([
  [
    'appearance.propose_update',
    {
      kind: 'appearance.update',
      parse: (raw: unknown) => raw,
      describe: () => ({ title: 'Update visitor chat appearance', lines: ['chatTheme → "dark"'] }),
    },
  ],
]) as unknown as OperatorKindRegistry

const now = new Date('2026-09-30T12:00:00Z')

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    grantId: 'g1',
    clientId: 'opc_1',
    kind: 'appearance.update',
    tool: 'appearance.propose_update',
    targetTenantId: 't1',
    targetVenueId: 'v1',
    args: { chatTheme: 'dark' },
    argsHash: 'a'.repeat(64),
    status: 'PENDING',
    planId: null,
    planStepIndex: null,
    revertOfId: null,
    beforeSnapshot: null,
    afterSnapshot: null,
    failureCode: null,
    createdAt: now,
    expiresAt: new Date('2026-10-03T12:00:00Z'),
    ...overrides,
  }
}

function fakeDatabase(rows: Record<string, unknown>[], plan: unknown = null) {
  const venueFind = vi.fn(async () => [{ id: 'v1', name: 'Main Hall' }])
  const database = {
    operatorPlan: {
      findUnique: vi.fn(async () => plan),
    },
    operatorProposal: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          rows.find((row) => row.id === where.id) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        where.id ? rows.filter((row) => where.id!.in.includes(row.id as string)) : rows,
      ),
    },
    operatorOAuthClient: {
      findMany: vi.fn(async () => [{ id: 'opc_1', clientName: 'Example Connector' }]),
    },
    tenant: { findMany: vi.fn(async () => [{ id: 't1', name: 'Harbor Museum' }]) },
    venue: { findMany: venueFind },
  }
  return { database: database as unknown as OperatorDatabase, venueFind }
}

describe('diffSnapshots', () => {
  it('reports changed fields only and hides identity and version fields', () => {
    expect(
      diffSnapshots(
        { venueId: 'v1', updatedAt: 'a', chatTheme: 'light', chatFont: 'serif' },
        { venueId: 'v1', updatedAt: 'b', chatTheme: 'dark', chatFont: 'serif' },
      ),
    ).toEqual([{ field: 'chatTheme', before: 'light', after: 'dark' }])
  })

  it('returns nothing for non-object snapshots and truncates long values', () => {
    expect(diffSnapshots(null, { a: 1 })).toEqual([])
    const [change] = diffSnapshots({ a: 'x' }, { a: 'y'.repeat(1000) })
    expect(change!.after.length).toBeLessThan(400)
  })
})

describe('loadOperatorReview', () => {
  it('reads only displayed columns so a database missing newer lease/fence columns still renders', async () => {
    const { database } = fakeDatabase([proposal()])
    await loadOperatorReview('p1', database, kinds)
    const newer = [
      'applyStartedAt',
      'leaseExpiresAt',
      'fenceToken',
      'attempt',
      'previewDigest',
      'policyRevision',
    ]
    const proposalCall = (database.operatorProposal.findUnique as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { select?: Record<string, boolean> }
    const planCall = (database.operatorPlan.findUnique as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { select?: Record<string, boolean> }
    expect(proposalCall.select).toBeDefined()
    expect(planCall.select).toBeDefined()
    for (const column of newer) {
      expect(proposalCall.select).not.toHaveProperty(column)
      expect(planCall.select).not.toHaveProperty(column)
    }
  })

  it('names the client and venue and looks venues up under their tenant', async () => {
    const { database, venueFind } = fakeDatabase([proposal()])
    const review = await loadOperatorReview('p1', database, kinds)
    expect(review).toMatchObject({
      type: 'proposal',
      title: 'Update visitor chat appearance',
      clientName: 'Example Connector',
      steps: [{ tenantName: 'Harbor Museum', venueName: 'Main Hall', changeMode: null }],
    })
    expect(venueFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 't1' }) }),
    )
  })

  it('shows before and after for an applied proposal', async () => {
    const { database } = fakeDatabase([
      proposal({
        status: 'APPLIED',
        beforeSnapshot: { chatTheme: 'light', updatedAt: 'a' },
        afterSnapshot: { chatTheme: 'dark', updatedAt: 'b' },
      }),
    ])
    const review = await loadOperatorReview('p1', database, kinds)
    expect(review!.steps[0]).toMatchObject({
      changeMode: 'applied',
      changes: [{ field: 'chatTheme', before: 'light', after: 'dark' }],
    })
  })

  it('shows the server-computed difference for a pending proposal whose kind can compute one', async () => {
    const pendingChanges = vi.fn(async () => [
      { field: '1. update k1 · body', before: 'old', after: 'new' },
    ])
    const withDiff = new Map([
      [
        'venues.propose_content_changeset',
        {
          kind: 'venues.content-changeset',
          parse: (raw: unknown) => raw,
          describe: () => ({ title: 'Change venue content', lines: ['1. UPDATE k1'] }),
          pendingChanges,
        },
      ],
    ]) as unknown as OperatorKindRegistry
    const { database } = fakeDatabase([
      proposal({ tool: 'venues.propose_content_changeset', kind: 'venues.content-changeset' }),
    ])
    const review = await loadOperatorReview('p1', database, withDiff)
    expect(pendingChanges).toHaveBeenCalledTimes(1)
    expect(review!.steps[0]).toMatchObject({
      changeMode: 'pending',
      changes: [{ field: '1. update k1 · body', before: 'old', after: 'new' }],
    })
  })

  it('still shows the exact arguments when the diff cannot be computed', async () => {
    const failing = new Map([
      [
        'venues.propose_content_changeset',
        {
          kind: 'venues.content-changeset',
          parse: (raw: unknown) => raw,
          describe: () => ({ title: 'Change venue content', lines: [] }),
          pendingChanges: async () => {
            throw new Error('database unavailable')
          },
        },
      ],
    ]) as unknown as OperatorKindRegistry
    const { database } = fakeDatabase([
      proposal({ tool: 'venues.propose_content_changeset', args: { ops: [] } }),
    ])
    const review = await loadOperatorReview('p1', database, failing)
    expect(review!.steps[0]).toMatchObject({ changeMode: null, changes: [] })
    expect(review!.steps[0]!.args).toContain('"ops"')
  })

  it('shows what a revert will restore from the original before snapshot', async () => {
    const { database } = fakeDatabase([
      proposal({
        id: 'orig',
        status: 'APPLIED',
        beforeSnapshot: { chatTheme: 'light' },
        afterSnapshot: { chatTheme: 'dark' },
      }),
      proposal({
        id: 'rev',
        kind: 'operator.revert',
        tool: 'operator.propose_revert',
        revertOfId: 'orig',
      }),
    ])
    const review = await loadOperatorReview('rev', database, kinds)
    expect(review!.steps[0]).toMatchObject({
      title: 'Undo: Update visitor chat appearance',
      changeMode: 'restore',
      changes: [{ field: 'chatTheme', before: 'dark', after: 'light' }],
    })
  })

  it('refuses to review a plan step on its own and returns null for unknown ids', async () => {
    const { database } = fakeDatabase([proposal({ planId: 'plan1' })])
    expect(await loadOperatorReview('p1', database, kinds)).toBeNull()
    expect(await loadOperatorReview('nope', database, kinds)).toBeNull()
  })
})

describe('listOperatorConnections', () => {
  it('shows hosts, last used and status without any token material', async () => {
    const database = {
      operatorGrant: {
        findMany: vi.fn(async () => [
          {
            id: 'g1',
            allTenants: true,
            tenantIds: [],
            capabilities: ['crm:read'],
            lastUsedAt: new Date('2026-09-30T11:00:00Z'),
            createdAt: new Date('2026-09-01T00:00:00Z'),
            expiresAt: new Date('2026-12-01T00:00:00Z'),
            revokedAt: null,
            revokeReason: null,
            client: {
              clientName: 'Example Connector',
              redirectUris: ['https://connector.example.com/cb', 'https://connector.example.com/x'],
              lastUsedAt: null,
            },
          },
        ]),
      },
    } as unknown as OperatorDatabase
    const [row] = await listOperatorConnections(now, database)
    expect(row).toMatchObject({
      grantId: 'g1',
      redirectHosts: ['connector.example.com'],
      status: 'active',
    })
    expect(JSON.stringify(row)).not.toMatch(/token|hash|secret/iu)
  })
})

describe('listOperatorAudit', () => {
  it('selects only display columns and re-redacts arguments', async () => {
    const findMany = vi.fn(async () => [
      {
        id: 'a1',
        occurredAt: now,
        eventType: 'mcp.call',
        outcome: 'OK',
        tool: 'crm.search_organizations',
        clientId: 'opc_1',
        targetTenantId: null,
        targetVenueId: null,
        proposalId: null,
        planId: null,
        latencyMs: 12,
        redactedArgs: { accessToken: 'pf_oat_stg_abc', query: 'museum' },
      },
    ])
    const database = {
      operatorAuditEvent: { findMany },
      operatorOAuthClient: {
        findMany: vi.fn(async () => [{ id: 'opc_1', clientName: 'Example Connector' }]),
      },
      tenant: { findMany: vi.fn() },
    } as unknown as OperatorDatabase
    const rows = await listOperatorAudit({ eventType: 'mcp.call', days: 7 }, now, database)
    const call = findMany.mock.calls[0] as unknown as [
      { select: Record<string, boolean>; where: object },
    ]
    expect(call[0].select).not.toHaveProperty('argsHash')
    expect(call[0].where).toMatchObject({ eventType: 'mcp.call' })
    expect(rows[0]!.redactedArgs).toContain('[redacted]')
    expect(rows[0]!.redactedArgs).not.toContain('pf_oat')
    expect(rows[0]!.clientName).toBe('Example Connector')
  })
})
