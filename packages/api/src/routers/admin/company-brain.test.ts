import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  findMany: vi.fn(),
  createCandidate: vi.fn(),
  promote: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  withTenantIsolationBypass: mocks.bypass,
  createCompanyKnowledgeCandidateAction: mocks.createCandidate,
  promoteCompanyKnowledgeAction: mocks.promote,
  db: { companyKnowledgeItem: { findMany: mocks.findMany } },
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminCompanyBrainRouter } from './company-brain'

const testRouter = router({ companyBrain: adminCompanyBrainRouter })

function context(isPlatformAdmin: boolean): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'operator_1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin,
    },
  }
}

describe('Company Brain admin router', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects non-admin reads before platform bypass', async () => {
    await expect(
      testRouter.createCaller(context(false)).companyBrain.listCompanyBrain({}),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<TRPCError>)
    expect(mocks.bypass).not.toHaveBeenCalled()
  })

  it('returns only a bounded real-data projection', async () => {
    mocks.findMany.mockResolvedValue([])
    const result = await testRouter
      .createCaller(context(true))
      .companyBrain.listCompanyBrain({ status: 'CURRENT', limit: 25 })
    expect(result).toEqual({ schemaVersion: 'company-brain-admin.v1', items: [], truncated: false })
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 25 }))
  })

  it('creates and promotes a human-attributed first-class decision', async () => {
    mocks.createCandidate.mockResolvedValue({ id: 'knowledge_1' })
    mocks.promote.mockResolvedValue({ id: 'knowledge_1', promotionStatus: 'PROMOTED' })
    await testRouter.createCaller(context(true)).companyBrain.createCompanyDecision({
      requestId: '11111111-1111-4111-8111-111111111111',
      title: 'Custom character pricing',
      summary: 'Custom characters use add-on pricing.',
      decision: 'Charge the approved add-on price.',
      rationale: 'Custom production has material cost.',
      affectedSystems: ['billing'],
      scope: { productArea: 'characters' },
    })
    expect(mocks.createCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'DECISION',
        authority: 'AUTHORITATIVE_CURRENT',
        decision: expect.objectContaining({ status: 'ACTIVE' }),
        actor: { type: 'HUMAN', actorId: 'operator_1', role: 'PLATFORM_ADMIN' },
      }),
    )
    expect(mocks.promote).toHaveBeenCalled()
  })
})
