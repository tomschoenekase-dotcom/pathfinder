import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/jobs', () => ({
  enqueueEmbedKnowledgeEntry: vi.fn().mockResolvedValue(undefined),
}))

import { enqueueEmbedKnowledgeEntry } from '@pathfinder/jobs'
import { router } from '../core'
import type { TRPCContext } from '../context'
import { knowledgeRouter } from './knowledge'

const venueFindFirst = vi.fn()
const entryFindMany = vi.fn()
const entryFindFirst = vi.fn()
const entryCreate = vi.fn()
const entryUpdateMany = vi.fn()
const entryDeleteMany = vi.fn()

const mockDb = {
  venue: { findFirst: venueFindFirst },
  venueKnowledgeEntry: {
    findMany: entryFindMany,
    findFirst: entryFindFirst,
    create: entryCreate,
    updateMany: entryUpdateMany,
    deleteMany: entryDeleteMany,
  },
} as unknown as TRPCContext['db']

const baseCtx = { db: mockDb, headers: new Headers() }

function managerCtx(): TRPCContext {
  return {
    ...baseCtx,
    session: {
      userId: 'user_1',
      activeTenantId: 'tenant_1',
      role: 'MANAGER',
      isPlatformAdmin: false,
    },
  }
}

function staffCtx(): TRPCContext {
  return {
    ...baseCtx,
    session: {
      userId: 'user_1',
      activeTenantId: 'tenant_1',
      role: 'STAFF',
      isPlatformAdmin: false,
    },
  }
}

const testRouter = router({ knowledge: knowledgeRouter })
const enqueueEmbedKnowledgeEntryMock = vi.mocked(enqueueEmbedKnowledgeEntry)

const VENUE_ID = 'cvenueabc123456789012'
const ENTRY_ID = 'centryabc123456789012'

const entryRow = {
  id: ENTRY_ID,
  tenantId: 'tenant_1',
  venueId: VENUE_ID,
  title: 'Refund policy',
  category: 'Policy',
  content: 'Refunds are available within 30 days.',
  isEnabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe('knowledge router', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('knowledge.list returns only entries for the caller tenant and venue', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: VENUE_ID })
    entryFindMany.mockResolvedValueOnce([entryRow])

    const caller = testRouter.createCaller(staffCtx())
    const result = await caller.knowledge.list({ venueId: VENUE_ID })

    expect(result).toEqual([entryRow])
    expect(entryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: VENUE_ID, tenantId: 'tenant_1' } }),
    )
  })

  it('knowledge.create creates an entry and enqueues embedding', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: VENUE_ID })
    entryCreate.mockResolvedValueOnce(entryRow)

    const caller = testRouter.createCaller(managerCtx())
    const result = await caller.knowledge.create({
      venueId: VENUE_ID,
      title: 'Refund policy',
      category: 'Policy',
      content: 'Refunds are available within 30 days.',
      isEnabled: true,
    })

    expect(result).toEqual(entryRow)
    expect(entryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 'tenant_1', venueId: VENUE_ID }),
      }),
    )
    expect(enqueueEmbedKnowledgeEntryMock).toHaveBeenCalledWith({
      entryId: ENTRY_ID,
      tenantId: 'tenant_1',
    })
  })

  it('knowledge.create throws NOT_FOUND for a venue in another tenant', async () => {
    venueFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(managerCtx())

    await expect(
      caller.knowledge.create({
        venueId: VENUE_ID,
        title: 'Refund policy',
        category: 'Policy',
        content: 'Refunds are available within 30 days.',
        isEnabled: true,
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))
  })

  it('knowledge.update re-enqueues when content fields change', async () => {
    entryFindFirst
      .mockResolvedValueOnce({ id: ENTRY_ID })
      .mockResolvedValueOnce({ ...entryRow, content: 'Updated' })
    entryUpdateMany.mockResolvedValueOnce({ count: 1 })

    const caller = testRouter.createCaller(managerCtx())
    const result = await caller.knowledge.update({ id: ENTRY_ID, content: 'Updated' })

    expect(result).toMatchObject({ content: 'Updated' })
    expect(enqueueEmbedKnowledgeEntryMock).toHaveBeenCalledWith({
      entryId: ENTRY_ID,
      tenantId: 'tenant_1',
    })
  })

  it('knowledge.update does not re-enqueue for isEnabled-only changes', async () => {
    entryFindFirst
      .mockResolvedValueOnce({ id: ENTRY_ID })
      .mockResolvedValueOnce({ ...entryRow, isEnabled: false })
    entryUpdateMany.mockResolvedValueOnce({ count: 1 })

    const caller = testRouter.createCaller(managerCtx())
    const result = await caller.knowledge.update({ id: ENTRY_ID, isEnabled: false })

    expect(result).toMatchObject({ isEnabled: false })
    expect(enqueueEmbedKnowledgeEntryMock).not.toHaveBeenCalled()
  })

  it('knowledge.delete throws NOT_FOUND for cross-tenant IDs', async () => {
    entryFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(managerCtx())

    await expect(caller.knowledge.delete({ id: ENTRY_ID })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }),
    )
  })
})
