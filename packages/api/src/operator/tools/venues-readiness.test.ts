import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OPERATOR_MCP_OUTPUTS } from '@pathfinder/contracts/operator-mcp'
import type { OperatorCallContext } from '../registry'
import { venueReadTools } from './venues'

const mocks = vi.hoisted(() => ({ read: vi.fn(), shared: vi.fn() }))
vi.mock('../../mcp/read-actions', () => ({ readMcpResource: mocks.read }))
vi.mock('@pathfinder/db', () => ({ venueSlugHeldByOtherTenant: mocks.shared }))

const input = { tenantId: 'tenant-one', venueId: 'venue-one' }
const tool = venueReadTools.find((entry) => entry.name === 'venues.get_readiness')!
function fixture() {
  const database = {
    tenant: { findUnique: vi.fn().mockResolvedValue({ id: input.tenantId }) },
    venue: {
      findMany: vi.fn().mockResolvedValue([{ id: input.venueId }]),
      findFirst: vi
        .fn()
        .mockImplementation(({ where }) =>
          Promise.resolve(
            where.tenantId === input.tenantId && where.id === input.venueId
              ? { id: input.venueId, slug: 'sample-garden', isActive: true }
              : null,
          ),
        ),
    },
    venueKnowledgeEntry: { count: vi.fn().mockResolvedValue(5) },
    place: { count: vi.fn().mockResolvedValue(0) },
  }
  const context = {
    database,
    grant: { allTenants: false, tenantIds: [input.tenantId], grantId: 'grant' },
  } as unknown as OperatorCallContext
  return { database, context }
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_WEB_URL', 'https://guide.example.com')
  mocks.shared.mockResolvedValue(false)
  mocks.read.mockResolvedValue({
    data: {
      venueActive: true,
      activePlaceCount: 0,
      enabledKnowledgeCount: 5,
      readyForPreview: false,
      contentConvergence: { available: true, phase: 'LEGACY_ONLY' },
      nativeGuestRead: { readyForConfiguredMode: false, path: 'LEGACY' },
      reportingEnabled: false,
    },
  })
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('public guide readiness', () => {
  it('reports a usable package-imported guide independently of native convergence and reporting', async () => {
    const { context, database } = fixture()
    const result = OPERATOR_MCP_OUTPUTS['venues.get_readiness'].parse(
      await tool.handler(input, context),
    )
    expect(result.ready).toBe(true)
    expect(result.readinessScope).toBe('public_guide')
    expect(result.publicGuide).toMatchObject({ usable: true, blockers: [] })
    expect(result.nativeRelease.ready).toBe(false)
    expect(result.nativeRelease.checks).toEqual(result.checks)
    expect(database.venueKnowledgeEntry.count).toHaveBeenCalledWith({
      where: {
        ...input,
        isEnabled: true,
        visibility: 'PUBLIC',
      },
    })
  })

  it.each(['GUEST_ORIGIN_UNCONFIGURED', 'SLUG_SHARED', 'NO_GUEST_CONTENT', 'VENUE_NOT_PUBLISHED'])(
    'retains the real public blocker %s',
    async (code) => {
      const { context, database } = fixture()
      if (code === 'GUEST_ORIGIN_UNCONFIGURED') vi.stubEnv('NEXT_PUBLIC_WEB_URL', '')
      if (code === 'SLUG_SHARED') mocks.shared.mockResolvedValue(true)
      if (code === 'NO_GUEST_CONTENT') database.venueKnowledgeEntry.count.mockResolvedValue(0)
      if (code === 'VENUE_NOT_PUBLISHED')
        database.venue.findFirst.mockResolvedValue({
          id: input.venueId,
          slug: 'sample-garden',
          isActive: false,
        })
      const result = OPERATOR_MCP_OUTPUTS['venues.get_readiness'].parse(
        await tool.handler(input, context),
      )
      expect(result.ready).toBe(false)
      expect(result.publicGuide.blockers).toEqual(
        expect.arrayContaining([expect.objectContaining({ code })]),
      )
    },
  )

  it('refuses a tenant outside the grant before any database or readiness read', async () => {
    const { context, database } = fixture()
    await expect(tool.handler({ ...input, tenantId: 'tenant-other' }, context)).rejects.toThrow(
      'Not found',
    )
    expect(database.tenant.findUnique).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('refuses a venue outside the requested tenant before reading content', async () => {
    const { context, database } = fixture()
    await expect(tool.handler({ ...input, venueId: 'venue-other' }, context)).rejects.toThrow(
      'Not found',
    )
    expect(database.venueKnowledgeEntry.count).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
  })
})
