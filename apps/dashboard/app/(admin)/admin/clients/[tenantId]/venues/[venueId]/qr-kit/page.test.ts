import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')
const shell = readFileSync(
  new URL('../../../../../../../../components/admin/ClientWorkspaceShell.tsx', import.meta.url),
  'utf8',
)

describe('Internal Workspace QR launch kit route', () => {
  it('is reachable from venue navigation and stays exact-scoped and print-only', () => {
    expect(shell).toContain('href: `${venueRoot}/qr-kit`')
    expect(shell).toContain("label: 'QR launch kit'")
    expect(page).toContain('caller.admin.getClientVenue({ tenantId, venueId })')
    expect(page).toContain('buildGuestChatUrl')
    expect(page).toContain('.filter((place) => place.isActive)')
    expect(page).toContain('VenueQrKit')
    expect(page).not.toMatch(/approve|publish|deploy/i)
  })
})
