/* eslint-disable @typescript-eslint/no-explicit-any -- bounded operator database fakes */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OPERATOR_MCP_INPUTS, OPERATOR_MCP_OUTPUTS } from '@pathfinder/contracts/operator-mcp'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  find: vi.fn(),
  get: vi.fn(),
  plan: vi.fn(),
  enqueue: vi.fn(),
  authorize: vi.fn(),
}))
vi.mock('@pathfinder/db', () => ({
  VenueEmbeddingRefreshError: class extends Error {
    constructor(public code: string) {
      super(code)
    }
  },
  requestVenueEmbeddingRefresh: mocks.request,
  findVenueEmbeddingRefreshByOperation: mocks.find,
  getVenueEmbeddingRefresh: mocks.get,
  planVenueEmbeddingRefresh: mocks.plan,
}))
vi.mock('@pathfinder/jobs', () => ({ enqueueVenueEmbeddingRefresh: mocks.enqueue }))
vi.mock('../grants', () => ({
  assertVenueInGrant: mocks.authorize,
  OperatorNotFoundError: class extends Error {},
}))

import { VenueEmbeddingRefreshError } from '@pathfinder/db'

import { venuesEmbeddingRefreshKind as kind } from './venues-embedding-refresh'
import { venueEmbeddingRefreshReadTools } from '../tools/venue-embedding-refresh'

const args = {
  tenantId: 'tenant-quillbrook',
  venueId: 'venue-quillbrook',
  operationId: '36e304cb-567b-4c61-945b-4fafbb54ca6c',
  max: 2,
  planDigest: 'a'.repeat(64),
}
const context = {
  database: {},
  grant: {},
  actor: { id: 'owner-quillbrook' },
  proposalId: 'proposal-quillbrook',
  operationId: args.operationId,
} as any
const receipt = () => ({
  id: 'refresh-quillbrook',
  tenantId: args.tenantId,
  venueId: args.venueId,
  status: 'QUEUED',
  freshnessProven: false,
  maxRecords: 2,
  stopCode: null,
  records: [],
  afterAudit: null,
})
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('EMBEDDING_DISPATCH_ENABLED', 'false')
  mocks.request.mockResolvedValue(receipt())
  mocks.find.mockResolvedValue(receipt())
  mocks.get.mockResolvedValue(receipt())
  mocks.plan.mockResolvedValue({
    planDigest: args.planDigest,
    candidateCount: 2,
    beforeAudit: { scanned: 5 },
    blockedCount: 0,
    truncated: false,
    eligible: true,
  })
})
afterEach(() => vi.unstubAllEnvs())

describe('venue refresh operator boundary', () => {
  it('accepts a bounded request but never claims freshness from enqueue success', async () => {
    const result = await kind.apply(args, context)
    expect(result.result).toMatchObject({
      accepted: true,
      freshnessProven: false,
      refreshId: 'refresh-quillbrook',
    })
    expect(mocks.request).toHaveBeenCalledWith(
      {
        tenantId: args.tenantId,
        venueId: args.venueId,
        operationKey: context.proposalId,
        max: 2,
        planDigest: args.planDigest,
        requestedBy: context.actor.id,
      },
      context.database,
    )
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith({
      tenantId: args.tenantId,
      venueId: args.venueId,
      refreshId: 'refresh-quillbrook',
    })
  })
  it('checks scope before any request or queue effect', async () => {
    mocks.authorize.mockRejectedValue(new Error('not found'))
    await expect(kind.apply(args, context)).rejects.toThrow('not found')
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })
  it.each(['true', ''])('refuses a dispatcher setting of %s without changing it', async (flag) => {
    vi.stubEnv('EMBEDDING_DISPATCH_ENABLED', flag)
    await expect(kind.apply(args, context)).rejects.toMatchObject({
      code: 'REFRESH_DISABLED',
      provedNoEffect: true,
    })
    expect(mocks.request).not.toHaveBeenCalled()
    expect(process.env.EMBEDDING_DISPATCH_ENABLED).toBe(flag)
  })
  it('preserves a delivery failure as unknown without queue retry', async () => {
    mocks.enqueue.mockRejectedValue(new Error('sensitive connection detail'))
    await expect(kind.apply(args, context)).rejects.toMatchObject({
      code: 'REFRESH_DELIVERY_UNKNOWN',
    })
    expect(mocks.enqueue).toHaveBeenCalledTimes(1)
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })
  it.each(['PLAN_CHANGED', 'MAX_EXCEEDED', 'AUDIT_BLOCKED', 'ACTIVE_REFRESH'])(
    'records %s as a proven refusal, not unknown paid work',
    async (code) => {
      mocks.request.mockRejectedValue(new VenueEmbeddingRefreshError(code as any))
      await expect(kind.apply(args, context)).rejects.toMatchObject({ code, provedNoEffect: true })
      expect(mocks.enqueue).not.toHaveBeenCalled()
    },
  )
  it('keeps arbitrary database errors and immutable operation mismatches unknown', async () => {
    for (const error of [
      new Error('database failed'),
      new VenueEmbeddingRefreshError('OPERATION_MISMATCH'),
    ]) {
      mocks.request.mockRejectedValue(error)
      await expect(kind.apply(args, context)).rejects.toBe(error)
      expect(error).not.toHaveProperty('provedNoEffect')
    }
  })
  it('does not requeue a running or terminal request on apply replay', async () => {
    for (const status of ['RUNNING', 'COMPLETE', 'STOPPED', 'OUTCOME_UNKNOWN']) {
      mocks.request.mockResolvedValue({ ...receipt(), status })
      await kind.apply(args, context)
    }
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })
  it('reconciles queued delivery under the same persisted run identity only', async () => {
    const result = await kind.reconcile!(args, context)
    expect(result.state).toBe('applied')
    expect(mocks.find).toHaveBeenCalledWith(
      { tenantId: args.tenantId, venueId: args.venueId, operationKey: context.proposalId },
      context.database,
    )
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith({
      tenantId: args.tenantId,
      venueId: args.venueId,
      refreshId: 'refresh-quillbrook',
    })
  })
  it('keeps unknown resolution read-only and holds uncertain queue delivery', async () => {
    expect((await kind.resolveUnknown!(args, context)).state).toBe('unknown')
    mocks.find.mockResolvedValue({ ...receipt(), status: 'RUNNING' })
    expect((await kind.resolveUnknown!(args, context)).state).toBe('applied')
    expect(mocks.enqueue).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('rejects excessive, fractional or missing max and unsealed plans', () => {
    for (const max of [-1, 1001, 0.5, undefined])
      expect(() => kind.parse({ ...args, max })).toThrow()
    expect(() => kind.parse({ ...args, planDigest: 'not-a-digest' })).toThrow()
    expect(kind.parse({ ...args, max: 0 }).max).toBe(0)
  })
})

describe('venue refresh read tools', () => {
  const plan = venueEmbeddingRefreshReadTools[0]!
  const get = venueEmbeddingRefreshReadTools[1]!
  it('plans without mutation, provider or queue work, exposing no manifest content', async () => {
    const result = await plan.handler({ tenantId: args.tenantId, venueId: args.venueId }, context)
    expect(OPERATOR_MCP_OUTPUTS['venues.plan_embedding_refresh'].safeParse(result).success).toBe(
      true,
    )
    expect(result).toMatchObject({ candidateCount: 2, eligible: true, dispatcherDisabled: true })
    expect(result).not.toHaveProperty('manifest')
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })
  it('rejects an unrelated tenant before reading its audit or receipt', async () => {
    mocks.authorize.mockRejectedValue(new Error('not found'))
    await expect(
      plan.handler({ tenantId: 'tenant-other', venueId: args.venueId }, context),
    ).rejects.toThrow()
    await expect(
      get.handler(
        { tenantId: 'tenant-other', venueId: args.venueId, refreshId: 'refresh-quillbrook' },
        context,
      ),
    ).rejects.toThrow()
    expect(mocks.plan).not.toHaveBeenCalled()
    expect(mocks.get).not.toHaveBeenCalled()
  })
  it('returns compact per-record receipts and final audit through the declared output schema', async () => {
    mocks.get.mockResolvedValue({
      ...receipt(),
      status: 'COMPLETE',
      freshnessProven: true,
      records: [
        {
          id: 'record-1',
          ordinal: 0,
          entityType: 'PLACE',
          entityId: 'place-1',
          contentUpdatedAt: new Date('2026-10-28T12:00:00.000Z'),
          status: 'COMPLETE',
          outcome: null,
          sourceHash: 'private-hash',
        },
      ],
      afterAudit: { scanned: 5, candidateCount: 0, blockedCount: 0, truncated: false },
    })
    const result = await get.handler(
      { tenantId: args.tenantId, venueId: args.venueId, refreshId: 'refresh-quillbrook' },
      context,
    )
    expect(OPERATOR_MCP_OUTPUTS['venues.get_embedding_refresh'].safeParse(result).success).toBe(
      true,
    )
    expect(JSON.stringify(result)).not.toContain('private-hash')
    expect(mocks.get).toHaveBeenCalledWith(
      { tenantId: args.tenantId, venueId: args.venueId, refreshId: 'refresh-quillbrook' },
      context.database,
    )
  })
  it('treats a missing scoped refresh as absent', async () => {
    mocks.get.mockResolvedValue(null)
    await expect(
      get.handler(
        { tenantId: args.tenantId, venueId: args.venueId, refreshId: 'foreign-refresh' },
        context,
      ),
    ).rejects.toThrow()
  })
  it('does not permit unknown input fields or an omitted scope', () => {
    expect(() =>
      OPERATOR_MCP_INPUTS['venues.plan_embedding_refresh'].parse({ venueId: args.venueId }),
    ).toThrow()
    expect(() =>
      OPERATOR_MCP_INPUTS['venues.get_embedding_refresh'].parse({
        tenantId: args.tenantId,
        venueId: args.venueId,
        refreshId: 'r',
        apply: true,
      }),
    ).toThrow()
  })
})
