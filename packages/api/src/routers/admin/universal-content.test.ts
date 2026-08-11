import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { adminUniversalContentRouter } from './universal-content'

const venueFindFirst = vi.fn()
const identityFindMany = vi.fn()
const db = {
  venue: { findFirst: venueFindFirst },
  contentModuleIdentity: { findMany: identityFindMany },
} as unknown as TRPCContext['db']

function context(isPlatformAdmin = true): TRPCContext {
  return {
    db,
    headers: new Headers(),
    session: { userId: 'admin', activeTenantId: null, role: null, isPlatformAdmin },
  }
}

const testRouter = router({ content: adminUniversalContentRouter })

describe('admin universal content reads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    venueFindFirst.mockResolvedValue({ id: 'venue-1' })
    identityFindMany.mockResolvedValue([])
  })

  it('blocks non-admin callers before database access', async () => {
    await expect(
      testRouter
        .createCaller(context(false))
        .content.listUniversalContent({ tenantId: 't1', venueId: 'v1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(venueFindFirst).not.toHaveBeenCalled()
  })

  it('rejects a venue outside the exact tenant scope', async () => {
    venueFindFirst.mockResolvedValue(null)
    await expect(
      testRouter
        .createCaller(context())
        .content.listUniversalContent({ tenantId: 'tenant-a', venueId: 'venue-b' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(venueFindFirst).toHaveBeenCalledWith({
      where: { id: 'venue-b', tenantId: 'tenant-a' },
      select: { id: true },
    })
    expect(identityFindMany).not.toHaveBeenCalled()
  })

  it('pins the module query to tenant, venue, and a strict kind with bounded selects', async () => {
    await testRouter
      .createCaller(context())
      .content.listUniversalContent({ tenantId: 't1', venueId: 'v1', kind: 'POLICY' })
    expect(identityFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 't1', venueId: 'v1', kind: 'POLICY' },
        take: 51,
        select: expect.objectContaining({ id: true, kind: true, revisions: expect.any(Object) }),
      }),
    )
    expect(identityFindMany.mock.calls[0]?.[0]?.select).not.toHaveProperty('tenant')
  })

  it('rejects unknown module kinds before database access', async () => {
    await expect(
      testRouter
        .createCaller(context())
        .content.listUniversalContent({ tenantId: 't1', venueId: 'v1', kind: 'ITEM' as 'SERVICE' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(venueFindFirst).not.toHaveBeenCalled()
  })
})
