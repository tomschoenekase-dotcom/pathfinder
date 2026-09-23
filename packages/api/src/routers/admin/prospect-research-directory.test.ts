import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TRPCContext } from '../../context'

const mocks = vi.hoisted(() => ({
  rows: vi.fn(),
  count: vi.fn(),
  bypass: vi.fn(async (fn: () => unknown) => fn()),
}))
vi.mock('@pathfinder/db', () => ({
  db: { prospectOrganization: { findMany: mocks.rows, count: mocks.count } },
  withTenantIsolationBypass: mocks.bypass,
}))
import { adminProspectCrmDirectoryRouter } from './prospect-crm-directory'
import {
  encodeResearchNameCursor,
  researchNameCursorWhere,
  researchDirectoryWhere,
} from './prospect-research-filters'

function caller(admin = true, authenticated = true) {
  return adminProspectCrmDirectoryRouter.createCaller({
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: authenticated ? 'local-reviewer' : null,
      activeTenantId: null,
      role: null,
      isPlatformAdmin: admin,
    },
  } as TRPCContext)
}

describe('research directory boundaries and semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.rows.mockResolvedValue([])
    mocks.count.mockResolvedValue(16725)
  })
  it('refuses anonymous and tenant-only callers before the database boundary', async () => {
    await expect(caller(false, false).listProspects({})).rejects.toThrow()
    await expect(caller(false).listProspects({})).rejects.toThrow()
    expect(mocks.rows).not.toHaveBeenCalled()
    expect(mocks.count).not.toHaveBeenCalled()
  })
  it('rejects client supplied tenant authority', async () => {
    await expect(caller().listProspects({ tenantId: 'victim' } as never)).rejects.toThrow()
    expect(mocks.rows).not.toHaveBeenCalled()
  })
  it('combines filters instead of letting coverage overwrite contact state; includes prospects without opportunities', async () => {
    const result = await caller().listProspects({
      contactState: 'MISSING',
      completeness: 'CORE_PRESENT',
      provenance: 'WEB_EVIDENCE',
    })
    const where = mocks.rows.mock.calls[0]![0].where
    expect(where.AND).toHaveLength(3)
    expect(where).not.toHaveProperty('opportunity')
    expect(result.totalCount).toBe(16725)
  })
  it('paginates names with an id tiebreaker and excludes the cursor from total count', async () => {
    const cursor = encodeResearchNameCursor({ canonicalName: 'Art Museum', id: 'p-2' }, 'NAME_ASC')
    await caller().listProspects({ sort: 'NAME_ASC', cursor, limit: 25 })
    expect(mocks.rows.mock.calls[0]![0].orderBy).toEqual([{ canonicalName: 'asc' }, { id: 'asc' }])
    expect(mocks.rows.mock.calls[0]![0].take).toBe(26)
    expect(mocks.count.mock.calls[0]![0].where.AND).toEqual([])
    expect(mocks.rows.mock.calls[0]![0].where.AND).toContainEqual({
      OR: [
        { canonicalName: { gt: 'Art Museum' } },
        { canonicalName: 'Art Museum', id: { gt: 'p-2' } },
      ],
    })
  })
  it('rejects a cursor carried over from another sort', async () => {
    const cursor = encodeResearchNameCursor({ canonicalName: 'Art Museum', id: 'p-2' }, 'NAME_ASC')
    expect(() => researchNameCursorWhere(cursor, 'NAME_DESC')).toThrow()
    await expect(caller().listProspects({ sort: 'NAME_DESC', cursor })).rejects.toThrow(
      'Invalid pagination cursor',
    )
    expect(mocks.rows).not.toHaveBeenCalled()
  })
  it('recorded email only means presence, while review includes unknown permission', () => {
    expect(
      JSON.stringify(researchDirectoryWhere({ sort: 'UPDATED', contactState: 'RECORDED' })),
    ).not.toContain('VALID')
    expect(
      JSON.stringify(researchDirectoryWhere({ sort: 'UPDATED', contactState: 'REVIEW_NEEDED' })),
    ).toContain('permissionState')
  })
  it('contact presence includes named, title-only and phone-only records, not just email', () => {
    expect(researchDirectoryWhere({ sort: 'UPDATED', contactState: 'RECORDED' })).toEqual([
      { contacts: { some: { archivedAt: null } } },
    ])
    expect(researchDirectoryWhere({ sort: 'UPDATED', contactState: 'MISSING' })).toEqual([
      { contacts: { none: { archivedAt: null } } },
    ])
  })
  it('a recorded workbook URL is not presented as independently researched web evidence', () => {
    expect(researchDirectoryWhere({ sort: 'UPDATED', provenance: 'SOURCE_URL_RECORDED' })).toEqual([
      { sources: { some: { sourceUrl: { not: null } } } },
    ])
    expect(
      JSON.stringify(researchDirectoryWhere({ sort: 'UPDATED', provenance: 'WEB_EVIDENCE' })),
    ).toContain('notIn')
  })
})
