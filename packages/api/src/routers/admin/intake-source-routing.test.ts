import { describe, expect, it, vi } from 'vitest'
import type { TRPCContext } from '../../context'
import { adminAgentTaskRequestsRouter } from './agent-task-requests'
function setup(admin = true) {
  const findMany = vi.fn().mockResolvedValue([])
  const findFirst = vi.fn().mockResolvedValue({ id: 'venue' })
  const caller = adminAgentTaskRequestsRouter.createCaller({
    db: { venue: { findFirst }, agentIdentity: { findMany } },
    headers: new Headers(),
    session: { userId: 'admin', activeTenantId: 'other', role: 'STAFF', isPlatformAdmin: admin },
  } as unknown as TRPCContext)
  return { caller, findMany, findFirst }
}
describe('intake source routing candidate read', () => {
  it('rejects non-admin before reads', async () => {
    const { caller, findMany, findFirst } = setup(false)
    await expect(
      caller.listIntakeSourceAgentRoutingCandidates({ tenantId: 'tenant', venueId: 'venue' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(findFirst).not.toHaveBeenCalled()
    expect(findMany).not.toHaveBeenCalled()
  })
  it('refuses an unavailable tenant venue before returning client-wide identities', async () => {
    const { caller, findMany, findFirst } = setup()
    findFirst.mockResolvedValue(null as never)
    await expect(
      caller.listIntakeSourceAgentRoutingCandidates({ tenantId: 'tenant', venueId: 'foreign' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(findFirst).toHaveBeenCalledWith({
      where: { tenantId: 'tenant', id: 'foreign' },
      select: { id: true },
    })
    expect(findMany).not.toHaveBeenCalled()
  })
  it('keeps exact scope and authority filters while paging', async () => {
    const { caller, findMany } = setup()
    const createdAt = new Date('2026-09-10T00:00:00Z')
    findMany.mockResolvedValue([
      { id: 'a', name: 'Guide', createdAt },
      { id: 'b', name: 'More', createdAt },
    ])
    const result = await caller.listIntakeSourceAgentRoutingCandidates({
      tenantId: 'tenant',
      venueId: 'venue',
      limit: 1,
      cursor: { createdAt: createdAt.toISOString(), id: 'z' },
    })
    expect(result.nextCursor).toEqual({ createdAt: createdAt.toISOString(), id: 'a' })
    expect(result.items).toHaveLength(1)
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 2,
        where: expect.objectContaining({
          tenantId: 'tenant',
          enabled: true,
          agentType: 'CONTENT',
          OR: [
            { venueId: 'venue', accessScope: 'VENUE' },
            { venueId: null, accessScope: 'CLIENT' },
          ],
          accessCapabilities: { hasEvery: ['intake.read', 'content.draft'] },
          autonomousActions: { has: 'content.prepare-draft' },
          AND: expect.any(Array),
        }),
      }),
    )
  })
})
