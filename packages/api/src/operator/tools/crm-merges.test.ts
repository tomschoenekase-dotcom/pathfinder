import { describe, expect, it, vi } from 'vitest'

import { errorBody, errorCode } from '../http'
import { crmOrganizationMergeKind } from '../kinds/crm-organization-merge'
import { crmMergeReadTools } from './crm-merges'

const args = {
  sourceOrganizationId: 'source_1',
  targetOrganizationId: 'target_1',
  expectedPlanHash: 'a'.repeat(64),
  note: 'Reviewed duplicate',
  operationId: '00000000-0000-4000-8000-000000000001',
}

describe('platform-wide organization merge scope', () => {
  it('reuses the authorized preview only within one context and refreshes on reauthorization', async () => {
    const plan = { planHash: args.expectedPlanHash, blockers: [] }
    const transaction = vi.fn().mockResolvedValue(plan)
    const context = {
      grant: { allTenants: true, userId: 'owner' },
      allowedUserIds: new Set(['owner']),
      database: { $transaction: transaction },
    }
    await crmOrganizationMergeKind.authorize!(args, context as never)
    expect(await crmOrganizationMergeKind.currentVersion(args, context as never)).toBe(
      args.expectedPlanHash,
    )
    expect(await crmOrganizationMergeKind.snapshot(args, context as never)).toBe(plan)
    expect(transaction).toHaveBeenCalledTimes(1)
    await crmOrganizationMergeKind.authorize!(args, context as never)
    expect(transaction).toHaveBeenCalledTimes(2)
    expect(await crmOrganizationMergeKind.snapshot(args, { ...context } as never)).toBe(plan)
    expect(transaction).toHaveBeenCalledTimes(3)
  })
  it.each([
    { allTenants: false, allowed: true },
    { allTenants: true, allowed: false },
  ])('denies a preview before looking up accounts: %o', async ({ allTenants, allowed }) => {
    const findUnique = vi.fn()
    await expect(
      crmMergeReadTools[0]!.handler(args, {
        grant: { allTenants, userId: 'owner' },
        config: { allowedUserIds: new Set(allowed ? ['owner'] : []) },
        database: { prospectOrganization: { findUnique } },
      } as never),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(findUnique).not.toHaveBeenCalled()
  })

  it.each([
    { allTenants: false, allowed: true },
    { allTenants: true, allowed: false },
  ])('denies a proposal before looking up accounts: %o', async ({ allTenants, allowed }) => {
    const findUnique = vi.fn()
    await expect(
      crmOrganizationMergeKind.authorize!(args, {
        grant: { allTenants, userId: 'owner' },
        allowedUserIds: new Set(allowed ? ['owner'] : []),
        database: { prospectOrganization: { findUnique } },
      } as never),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(findUnique).not.toHaveBeenCalled()
  })
})

describe('an unsafe merge plan is a named refusal with its blockers', () => {
  it('reports UNSAFE_MERGE and the blockers instead of an unclassified tool failure', async () => {
    const plan = {
      sourceOrganizationId: args.sourceOrganizationId,
      targetOrganizationId: args.targetOrganizationId,
      planHash: args.expectedPlanHash,
      sourceName: 'Example North',
      targetName: 'Example',
      counts: {},
      blockers: ['duplicate-pair-confirmed-distinct:pair_1'],
      sourceOpportunity: null,
      targetOpportunity: null,
    }
    const error = await crmOrganizationMergeKind.authorize!(args, {
      grant: { allTenants: true, userId: 'owner' },
      allowedUserIds: new Set(['owner']),
      database: { $transaction: vi.fn(async () => plan) },
    } as never).catch((caught: unknown) => caught)
    expect(errorCode(error)).toBe('UNSAFE_MERGE')
    expect(errorBody('UNSAFE_MERGE', 'crm.propose_organization_merge', 'req_1')).toMatchObject({
      error: 'UNSAFE_MERGE',
    })
  })
})
