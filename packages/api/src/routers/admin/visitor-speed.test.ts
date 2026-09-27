import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { adminVisitorSpeedRouter } from './visitor-speed'

const { queryRawMock, bypassMock } = vi.hoisted(() => ({
  queryRawMock: vi.fn(),
  bypassMock: vi.fn(async (operation: () => unknown) => operation()),
}))

vi.mock('@pathfinder/db', () => ({
  db: { $queryRaw: queryRawMock },
  withTenantIsolationBypass: bypassMock,
}))

const testRouter = router({ admin: adminVisitorSpeedRouter })
const fixture = {
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  venueName: 'City Museum',
  sampleCount: 4,
  p50RequestFirstTextMs: 420,
  p90RequestFirstTextMs: 710,
}

function context(session: TRPCContext['session']): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session,
  }
}

describe('admin visitor speed', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-27T18:00:00.000Z'))
    queryRawMock.mockReset().mockResolvedValue([fixture])
    bypassMock.mockClear()
  })

  it('requires platform-admin authority before querying analytics', async () => {
    const anonymous = testRouter.createCaller(
      context({ userId: null, activeTenantId: null, role: null, isPlatformAdmin: false }),
    )
    const tenantOwner = testRouter.createCaller(
      context({
        userId: 'user_1',
        activeTenantId: 'tenant_1',
        role: 'OWNER',
        isPlatformAdmin: false,
      }),
    )

    await expect(anonymous.admin.getVisitorSpeed()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(tenantOwner.admin.getVisitorSpeed()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(queryRawMock).not.toHaveBeenCalled()
    expect(bypassMock).not.toHaveBeenCalled()
  })

  it('uses a rolling seven-day indexed query and returns per-venue percentiles', async () => {
    const caller = testRouter.createCaller(
      context({ userId: 'admin_1', activeTenantId: null, role: null, isPlatformAdmin: true }),
    )

    const result = await caller.admin.getVisitorSpeed()

    expect(result).toEqual({
      windowStart: new Date('2026-09-20T18:00:00.000Z'),
      windowEnd: new Date('2026-09-27T18:00:00.000Z'),
      venues: [fixture],
    })
    expect(bypassMock).toHaveBeenCalledTimes(1)
    expect(queryRawMock).toHaveBeenCalledTimes(1)

    const [sqlTemplate, windowStart, windowEnd] = queryRawMock.mock.calls[0] as [
      TemplateStringsArray,
      Date,
      Date,
    ]
    const sql = sqlTemplate.join(' ')
    expect([windowStart, windowEnd]).toEqual([result.windowStart, result.windowEnd])
    expect(sql).toContain("event.event_type = 'message.received'")
    expect(sql).toContain("jsonb_typeof(event.metadata->'requestFirstTextMs') = 'number'")
    expect(sql).toContain('timing.request_first_text_ms >= 0')
    expect(sql).toContain('percentile_cont(0.5)')
    expect(sql).toContain('percentile_cont(0.9)')
    expect(sql).toContain('venue.tenant_id = event.tenant_id')
    expect(sql).toContain('event.occurred_at >=')
    expect(sql).toContain('event.occurred_at <')
  })
})
