import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ executeRaw: vi.fn(), queryRaw: vi.fn() }))

vi.mock('../client', () => ({
  db: { $executeRaw: mocks.executeRaw, $queryRaw: mocks.queryRaw },
}))

import {
  failGenerationRequestDispatch,
  leaseGenerationRequestDispatches,
  settleProgressedGenerationRequestDispatch,
} from './generation-request-dispatches'

const leaseToken = '11111111-1111-4111-8111-111111111111'
const exact = {
  id: 'dispatch_1',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  kind: 'ANSWER_ANALYSIS' as const,
  recordId: 'snapshot_1',
  leaseToken,
}

describe('generation request dispatches', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each([0, 51, 1.5])('rejects an invalid lease batch limit (%s)', async (limit) => {
    await expect(leaseGenerationRequestDispatches({ limit })).rejects.toThrow(
      /integer from 1 to 50/,
    )
    expect(mocks.queryRaw).not.toHaveBeenCalled()
  })

  it('persists only the stable generation-dispatch failure code', async () => {
    mocks.executeRaw.mockResolvedValue(1)
    await expect(failGenerationRequestDispatch(exact)).resolves.toBe(true)
    const durableValues = JSON.stringify(mocks.executeRaw.mock.calls[0]?.slice(1))
    expect(durableValues).toContain('GENERATION_DISPATCH_FAILED')
    expect(durableValues).not.toContain('postgres://operator:secret@example.test/torchiko')
  })

  it.each([
    ['active execution lease', 1, true],
    ['terminal or failed target', 1, true],
    ['null-lease generating target', 0, false],
    ['wrong scope, range, or receipt lease', 0, false],
  ])('settles only a progressed exact target: %s', async (_case, affected, expected) => {
    mocks.executeRaw.mockResolvedValue(affected)
    await expect(settleProgressedGenerationRequestDispatch(exact)).resolves.toBe(expected)
    const sql = String(mocks.executeRaw.mock.calls[0]?.[0])
    expect(sql).toContain('execution_lease_token IS NOT NULL OR s.status <>')
    expect(mocks.executeRaw.mock.calls[0]?.slice(1)).toEqual(
      expect.arrayContaining([
        exact.id,
        exact.tenantId,
        exact.venueId,
        exact.recordId,
        exact.leaseToken,
      ]),
    )
  })

  it('uses a separate fixed weekly-report target query', async () => {
    mocks.executeRaw.mockResolvedValue(1)
    await settleProgressedGenerationRequestDispatch({
      ...exact,
      kind: 'WEEKLY_REPORT',
      recordId: 'report_1',
    })
    expect(String(mocks.executeRaw.mock.calls[0]?.[0])).toContain('FROM weekly_reports r')
  })

  it('rejects malformed fencing tokens before querying', async () => {
    await expect(
      settleProgressedGenerationRequestDispatch({ ...exact, leaseToken: 'bad' }),
    ).rejects.toThrow(/valid UUID/)
    expect(mocks.executeRaw).not.toHaveBeenCalled()
  })
})
