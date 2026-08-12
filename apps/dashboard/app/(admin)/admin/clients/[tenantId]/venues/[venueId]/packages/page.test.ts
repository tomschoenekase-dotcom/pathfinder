import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

describe('Internal Workspace venue-package review route', () => {
  it('is bounded, exact-review oriented and exposes no lifecycle mutation controls', () => {
    expect(source).toContain('listVenuePackagesForReview')
    expect(source).toContain('getVenuePackageForReview')
    expect(source).toContain('limit: 25')
    expect(source).toContain('Older packages')
    expect(source).toContain('Stored venue-package payload JSON')
    expect(source).toContain('This surface')
    expect(source).toContain('read-only')
    expect(source).not.toMatch(/\.approve\.|\.applyPackage\.|\.revertPackage\.|\.createDraft\./)
  })
})
