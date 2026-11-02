/* eslint-disable @typescript-eslint/no-explicit-any -- scoped action fakes */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ apply: vi.fn(), read: vi.fn() }))
vi.mock('@pathfinder/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/db')>()),
  applyVenueDistributionChangeAction: mocks.apply,
  readVenueDistributionState: mocks.read,
}))
import { VenueDistributionActionError } from '@pathfinder/db'
import { OPERATOR_MCP_OUTPUTS } from '@pathfinder/contracts/operator-mcp'
import { isAlwaysAskKind } from '../autonomy'
import { OperatorNotFoundError } from '../grants'
import { OperatorStaleError } from '../proposals'
import { venueDistributionReadTool as read } from '../tools/venue-distribution'
import { venueDistributionChangeKind as kind } from './venue-distribution'

const scope = { tenantId: 'tenant-a', venueId: 'venue-a' }
const operationId = '8a1f1c0e-2f87-4b5e-9d57-6a2b6d7a9d10'
const raw = { ...scope, operationId, expectedRevision: 2, change: { kind: 'ADD_ORIGIN', origin: 'https://www.example.org' }, reason: 'Venue website embed' }
const state = { websiteState: 'ENABLED', appState: 'DISABLED', revision: 2, origins: [{ origin: 'https://old.example.org', state: 'REVOKED', addedAt: '2026-10-01T00:00:00.000Z', revokedAt: '2026-10-02T00:00:00.000Z' }] }
const context = (allowed = true) =>
  ({
    database: {
      tenant: { findUnique: vi.fn().mockResolvedValue({ id: scope.tenantId }) },
      venue: { findFirst: vi.fn().mockResolvedValue({ id: scope.venueId }) },
    },
    grant: { userId: 'human', allTenants: false, tenantIds: [scope.tenantId] },
    allowedUserIds: new Set(allowed ? ['human'] : []),
    actor: { type: 'HUMAN', id: 'human', role: 'PLATFORM_ADMIN' },
    proposalId: 'proposal-1',
  }) as any

beforeEach(() => {
  vi.clearAllMocks()
  mocks.read.mockResolvedValue(state)
  mocks.apply.mockResolvedValue({ revision: 3, websiteState: 'ENABLED', appState: 'DISABLED' })
})
afterEach(() => vi.unstubAllEnvs())

describe('visitor distribution through the operator', () => {
  it('reads state in the strict output shape for a granted venue only', async () => {
    const output = await read.handler(scope, context())
    expect(OPERATOR_MCP_OUTPUTS['venues.get_distribution'].parse(output)).toMatchObject({ revision: 2, originsComplete: true })
    const other = context()
    other.grant = { userId: 'human', allTenants: false, tenantIds: ['tenant-b'] }
    await expect(read.handler(scope, other)).rejects.toThrow()
    expect(mocks.read).toHaveBeenCalledTimes(1)
  })

  it('rejects origins that are not exact normalized HTTPS origins before proposing', () => {
    for (const origin of ['http://www.example.org', 'https://www.example.org/', 'https://www.example.org/page', 'https://*.example.org'])
      expect(() => kind.parse({ ...raw, change: { kind: 'ADD_ORIGIN', origin } })).toThrow()
    expect(kind.parse(raw).change).toEqual({ kind: 'ADD_ORIGIN', origin: 'https://www.example.org' })
  })

  it('requires an allowlisted platform administrator, like the dashboard', async () => {
    await expect(kind.authorize!(kind.parse(raw), context(false))).rejects.toBeInstanceOf(OperatorNotFoundError)
    await expect(kind.authorize!(kind.parse(raw), context())).resolves.toBeUndefined()
  })

  it('applies through the canonical revision-bound action and maps conflicts to stale', async () => {
    const args = kind.parse(raw)
    expect(await kind.currentVersion(args, context())).toBe('2')
    expect(await kind.targetVersion(args, context())).toBe('2')
    const applied = await kind.apply(args, context())
    expect(mocks.apply).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a', venueId: 'venue-a', expectedRevision: 2, change: raw.change,
      actor: { type: 'HUMAN', id: 'human', role: 'PLATFORM_ADMIN' } }), expect.anything())
    expect(applied.result).toMatchObject({ revision: 3 })
    mocks.apply.mockRejectedValueOnce(new VenueDistributionActionError('CONFLICT', 'changed'))
    await expect(kind.apply(args, context())).rejects.toBeInstanceOf(OperatorStaleError)
  })

  it('always waits for a person in review mode', () => {
    vi.stubEnv('OPERATOR_APPROVAL_MODE', 'review')
    expect(isAlwaysAskKind('venues.distribution-change')).toBe(true)
  })
})
