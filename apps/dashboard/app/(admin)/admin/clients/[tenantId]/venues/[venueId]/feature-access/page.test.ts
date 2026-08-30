import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')
const shell = readFileSync(
  new URL('../../../../../../../../components/admin/ClientWorkspaceShell.tsx', import.meta.url),
  'utf8',
)

describe('venue feature access route', () => {
  it('is reachable, exact-scoped, and separates entitlement from provider activation', () => {
    expect(shell).toContain('href: `${venueRoot}/feature-access`')
    expect(shell).toContain("label: 'Feature access'")
    expect(page).toContain('caller.admin.getClientVenue({ tenantId, venueId })')
    expect(page).toContain('caller.admin.listProductEntitlements({ tenantId, venueId })')
    expect(page).toContain('VenueFeatureAccessControl')
    expect(page).toContain('No entitlement, billing record, or provider setting was changed')
  })
})
