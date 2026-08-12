import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')
const shell = readFileSync(
  new URL('../../../../../../../../components/admin/ClientWorkspaceShell.tsx', import.meta.url),
  'utf8',
)

describe('Internal Workspace Guest design route', () => {
  it('is reachable from venue navigation and loads exact-scoped admin design evidence', () => {
    expect(shell).toContain('href: `${venueRoot}/guest-design`')
    expect(shell).toContain("label: 'Guest design'")
    expect(page).toContain('caller.admin.getGuestDesign({ tenantId, venueId })')
    expect(page).toContain('GuestDesignWorkspace')
    expect(page).not.toContain('ChatDesignForm')
  })
})
