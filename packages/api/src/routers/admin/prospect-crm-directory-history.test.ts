import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TRPCContext } from '../../context'
const mocks = vi.hoisted(() => ({ rows: vi.fn(), history: vi.fn() }))
vi.mock('@pathfinder/db', () => ({
  db: {
    prospectOrganization: { findMany: mocks.rows },
    prospectActivity: { count: vi.fn(async () => 1), findMany: vi.fn(async () => []) },
  },
  withTenantIsolationBypass: async (operation: () => Promise<unknown>) => operation(),
  loadProspectOutreachHistory: mocks.history,
}))
import { adminProspectCrmDirectoryRouter } from './prospect-crm-directory'
import { decodeProspectCursor } from './prospect-crm-pagination'
const context: TRPCContext = {
  db: {} as TRPCContext['db'],
  headers: new Headers(),
  session: { userId: 'fictional-admin', activeTenantId: null, role: null, isPlatformAdmin: true },
}
function row(index: number) {
  return {
    id: `org-${index}`,
    updatedAt: new Date(2000000000000 - index * 1000),
    venues: [],
    opportunity: null,
    priority: 'NORMAL',
    ownerId: null,
  }
}
describe('directory projected filters preserve keyset coverage', () => {
  beforeEach(() => vi.clearAllMocks())
  it('scans past a nonmatching page and resumes after the last returned match', async () => {
    const initial = Array.from({ length: 101 }, (_, i) => row(i))
    mocks.rows.mockResolvedValueOnce(initial).mockResolvedValueOnce([row(100), row(101), row(102)])
    mocks.history.mockImplementation(async (_reader: unknown, id: string) => ({
      coldEmailCount: id === 'org-100' || id === 'org-101' ? 1 : 0,
      historyComplete: true,
      relationship: 'awaitingReply',
      firstHumanReply: 'noReply',
      eligibility: 'eligible',
    }))
    const caller = adminProspectCrmDirectoryRouter.createCaller(context)
    const scan = await caller.listProspects({ outreachView: 'firstFollowupDue', limit: 1 })
    expect(scan.items).toEqual([])
    const result = await caller.listProspects({
      outreachView: 'firstFollowupDue',
      limit: 1,
      cursor: scan.nextCursor!,
    })
    expect(result.items.map((item) => item.id)).toEqual(['org-100'])
    expect(mocks.rows).toHaveBeenCalledTimes(2)
    expect(decodeProspectCursor(result.nextCursor!).id).toBe('org-100')
    expect(mocks.rows.mock.calls[1]?.[0].where.AND).toEqual(
      expect.arrayContaining([
        {
          OR: [
            { updatedAt: { lt: row(99).updatedAt } },
            { updatedAt: row(99).updatedAt, id: { lt: 'org-99' } },
          ],
        },
      ]),
    )
  })
  it('returns a continuation when the bounded scan has no matches', async () => {
    mocks.rows.mockImplementation(async () => Array.from({ length: 101 }, (_, i) => row(i)))
    mocks.history.mockResolvedValue({
      historyComplete: false,
      coldEmailCount: null,
      relationship: 'prospect',
      eligibility: 'hold',
    })
    const result = await adminProspectCrmDirectoryRouter
      .createCaller(context)
      .listProspects({ outreachView: 'neverContacted', limit: 10 })
    expect(result.items).toEqual([])
    expect(result.nextCursor).not.toBeNull()
    expect(mocks.rows).toHaveBeenCalledTimes(1)
  })
  it('keeps organizations without an opportunity visible in the default directory', async () => {
    mocks.rows.mockResolvedValueOnce([row(1)])
    mocks.history.mockResolvedValue({
      historyComplete: false,
      coldEmailCount: null,
      relationship: 'prospect',
      eligibility: 'hold',
    })
    const result = await adminProspectCrmDirectoryRouter
      .createCaller(context)
      .listProspects({ limit: 10 })
    expect(result.items[0]?.opportunity).toBeNull()
    expect(mocks.rows.mock.calls[0]?.[0].where).not.toHaveProperty('opportunity')
  })
})
