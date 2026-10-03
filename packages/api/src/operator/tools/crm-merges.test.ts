import { describe, expect, it, vi } from 'vitest'

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
