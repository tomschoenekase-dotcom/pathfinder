import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

describe('native FULL release route', () => {
  it('keeps native history, detail, and lifecycle separate from compatibility packages', () => {
    expect(source).toContain('listNativeVenueDeployments')
    expect(source).toContain('getNativeVenueDeployment')
    expect(source).toContain('getNativeContentConvergence')
    expect(source).toContain('getNativeGuestReadActivationPreflight')
    expect(source).toContain('limit: 20')
    expect(source).toContain('NativeVenueDeploymentCreateForm')
    expect(source).toContain('NativeVenueDeploymentDetail')
    expect(source).toContain('NativeContentConvergenceCard')
    expect(source).toContain('NativeGuestReadActivationPreflightCard')
    expect(source).toContain('separate from compatibility venue packages')
    expect(source).not.toContain('VenuePackageLifecycleControls')
    expect(source).not.toContain('listVenuePackagesForReview')
  })
})
