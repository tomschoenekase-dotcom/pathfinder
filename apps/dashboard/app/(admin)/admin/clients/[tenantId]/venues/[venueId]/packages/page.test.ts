import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

describe('Internal Workspace venue-package review route', () => {
  it('makes exact-review DRAFT creation and lifecycle controls reachable', () => {
    expect(source).toContain('listVenuePackagesForReview')
    expect(source).toContain('getVenuePackageForReview')
    expect(source).toContain('limit: 25')
    expect(source).toContain('Older packages')
    expect(source).toContain('Stored venue-package payload JSON')
    expect(source).toContain('ReviewedVenuePackageDraftForm')
    expect(source).toContain('VenuePackageLifecycleControls')
    expect(source).toContain('create a reviewed DRAFT')
    expect(source).not.toMatch(/\.createDraft\./)
  })
})
