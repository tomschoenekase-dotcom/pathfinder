import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OPERATOR_MCP_INPUTS, OPERATOR_MCP_OUTPUTS } from '@pathfinder/contracts/operator-mcp'
import { sourceConnectionPreviewHash } from '@pathfinder/db'
import { sourceConnectionSnapshotHash } from '@pathfinder/contracts/source-connections-node'
import { sourceConnectionReadTools } from './source-connections'
import { sourceConnectionKind } from '../kinds/source-connections'
import { resolveAutonomy } from '../autonomy'
import type { OperatorCallContext } from '../registry'
import type { OperatorApplyContext } from '../proposals'

const actions = vi.hoisted(() => ({
  createSourceConnectionDraft: vi.fn(),
  updateSourceConnectionDraft: vi.fn(),
  requestSourceConnectionPreview: vi.fn(),
  approveSourceConnectionPreview: vi.fn(),
  setSourceConnectionState: vi.fn(),
  requestSourceConnectionRefresh: vi.fn(),
  getSourceConnection: vi.fn(),
}))
vi.mock('../../routers/source-connections-actions', () => actions)
const NOW = new Date('2026-10-03T18:00:00.000Z')
const operationId = '73506511-45dc-4cbd-a70c-794f9c5977a1'
const input = { tenantId: 'tenant_a', venueId: 'venue_a', connectorId: 'connector_a' }
function fixture() {
  const row = {
    id: 'connector_a',
    name: 'Daily operations',
    state: 'DISABLED',
    updatedAt: NOW,
    lastSuccessAt: null,
    lastErrorCategory: 'timeout',
    lastErrorAt: NOW,
    consecutiveFailures: 2,
    lastTestAt: NOW,
    lastTestOutcome: 'OK',
    lastTestErrorCategory: null,
    mapping: { version: 1 },
    lastTestPreview: null,
    observation: null,
  }
  const database = {
    tenant: { findUnique: vi.fn().mockResolvedValue({ id: 'tenant_a' }) },
    venue: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; tenantId: string } }) =>
        where.id === 'venue_a' && where.tenantId === 'tenant_a' ? { id: 'venue_a' } : null,
      ),
    },
    liveDataConnector: {
      findMany: vi.fn().mockResolvedValue([row]),
      findFirst: vi.fn().mockResolvedValue(row),
    },
  }
  const context = {
    database,
    grant: {
      allTenants: false,
      tenantIds: ['tenant_a'],
      capabilities: ['venues:read', 'venues:propose'],
    },
    now: NOW,
    operationId,
    actor: { type: 'HUMAN', id: 'operator_a', role: 'PLATFORM_ADMIN' },
  } as unknown as OperatorCallContext & OperatorApplyContext
  return { database, context }
}

describe('source connection operator tools', () => {
  beforeEach(() => vi.clearAllMocks())
  it('reads stored configuration only with exact tenant and venue grant predicates', async () => {
    const { context, database } = fixture()
    for (const tool of sourceConnectionReadTools)
      await tool.handler(
        tool.name === 'venues.list_source_connections'
          ? { tenantId: input.tenantId, venueId: input.venueId }
          : input,
        context,
      )
    for (const mock of [
      database.liveDataConnector.findMany,
      database.liveDataConnector.findFirst,
    ]) {
      expect(mock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: 'tenant_a',
            venueId: 'venue_a',
            provider: 'source_connection_v1',
          }),
        }),
      )
    }
  })
  it('returns results that satisfy the strict published output schemas', async () => {
    const { context } = fixture()
    const [list, get] = sourceConnectionReadTools
    const listed = OPERATOR_MCP_OUTPUTS['venues.list_source_connections'].parse(
      await list!.handler({ tenantId: input.tenantId, venueId: input.venueId }, context),
    )
    expect(listed.complete).toBe(true)
    expect(listed.connections[0]).toMatchObject({
      health: 'draft',
      lastErrorMeaning: expect.stringContaining('took too long to respond'),
    })
    const got = OPERATOR_MCP_OUTPUTS['venues.get_source_connection'].parse(
      await get!.handler(input, context),
    )
    expect(got).toMatchObject({
      preview: null,
      approval: null,
      snapshot: null,
      detailOmitted: false,
    })
  })
  it('lifts preview details and omits oversized raw JSON without failing validation', async () => {
    const { context, database } = fixture()
    const hash = sourceConnectionSnapshotHash([])
    const body = {
      configHash: hash,
      contentHash: hash,
      records: [],
      issues: ['record_count_drift'],
      status: 'REVIEW_REQUIRED' as const,
      observedAt: NOW.toISOString(),
      cost: { fetches: 1, bytes: 10 },
    }
    const previewHash = sourceConnectionPreviewHash(body)
    const base = (await database.liveDataConnector.findFirst()) as Record<string, unknown>
    database.liveDataConnector.findFirst.mockResolvedValue({
      ...base,
      lastTestPreview: {
        ...body,
        previewId: 'preview_a',
        previewHash,
        padding: 'x'.repeat(600_000),
      },
    })
    const got = OPERATOR_MCP_OUTPUTS['venues.get_source_connection'].parse(
      await sourceConnectionReadTools[1]!.handler(input, context),
    )
    expect(got.preview).toMatchObject({
      previewId: 'preview_a',
      previewHash,
      issues: [{ code: 'record_count_drift' }],
    })
    expect(got.previewJson).toBeNull()
    expect(got.detailOmitted).toBe(true)
  })
  it.each(['tenant', 'venue'])(
    'refuses cross-%s read before touching connection rows',
    async (boundary) => {
      const { context, database } = fixture()
      const args = {
        ...input,
        ...(boundary === 'tenant' ? { tenantId: 'tenant_other' } : { venueId: 'venue_other' }),
      }
      for (const tool of sourceConnectionReadTools)
        await expect(
          tool.handler(
            tool.name === 'venues.list_source_connections'
              ? { tenantId: args.tenantId, venueId: args.venueId }
              : args,
            context,
          ),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(database.liveDataConnector.findFirst).not.toHaveBeenCalled()
      expect(database.liveDataConnector.findMany).not.toHaveBeenCalled()
    },
  )
  it('rejects missing version and approval hashes in write arguments', () => {
    const schema = OPERATOR_MCP_INPUTS['venues.propose_source_connection']
    expect(schema.safeParse({ ...input, operationId, action: 'approve' }).success).toBe(false)
    expect(
      schema.safeParse({
        ...input,
        operationId,
        action: 'approve',
        expectedUpdatedAt: NOW.toISOString(),
        previewId: 'preview_a',
        previewHash: 'a'.repeat(64),
      }).success,
    ).toBe(true)
  })
  it('always requires human approval even under a stored broad or named AUTO policy', async () => {
    const database = {
      operatorAutonomyPolicy: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ mode: 'AUTO', allowedKinds: ['venues.source-connection'] }),
      },
    }
    expect(
      await resolveAutonomy(
        { kind: sourceConnectionKind.kind, capability: 'venues:propose' },
        database as never,
      ),
    ).toBe('ask')
  })
  it('applies the same preview service with the authenticated actor and injected database', async () => {
    const { context, database } = fixture()
    actions.requestSourceConnectionPreview.mockResolvedValue({ id: 'connector_a', queued: true })
    const args = sourceConnectionKind.parse({
      ...input,
      action: 'preview',
      operationId,
      expectedUpdatedAt: NOW.toISOString(),
    })
    await sourceConnectionKind.authorize!(args, context)
    const result = await sourceConnectionKind.apply(args, context)
    expect(actions.requestSourceConnectionPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        ...input,
        database,
        actorId: 'operator_a',
        expectedUpdatedAt: NOW.toISOString(),
      }),
    )
    expect(result.result.action).toBe('preview')
    expect(result.result.next).toContain('previewHash')
  })
  it('shows the stored preview and real policy on the approval page', async () => {
    const { database } = fixture()
    const changes = await sourceConnectionKind.pendingChanges!(
      sourceConnectionKind.parse({
        ...input,
        action: 'approve',
        operationId,
        expectedUpdatedAt: NOW.toISOString(),
        previewId: 'preview_a',
        previewHash: 'a'.repeat(64),
      }),
      database as never,
    )
    expect(changes.map((change) => change.field)).toEqual([
      'Connection',
      'Stored preview',
      'Publication policy',
    ])
    expect(changes[2]!.after).toContain('Unknown policy')
  })
  it('holds ambiguous refresh outcomes instead of blindly repeating external work', async () => {
    const { context } = fixture()
    const args = sourceConnectionKind.parse({
      ...input,
      action: 'refresh',
      operationId,
      expectedUpdatedAt: NOW.toISOString(),
    })
    expect(await sourceConnectionKind.reconcile!(args, context)).toEqual({ state: 'unknown' })
    expect(actions.requestSourceConnectionRefresh).not.toHaveBeenCalled()
  })
})
