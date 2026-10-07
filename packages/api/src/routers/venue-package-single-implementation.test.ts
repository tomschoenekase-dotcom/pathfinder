import { describe, expect, it } from 'vitest'

import * as core from '../lib/venue-package-core'
import * as routerModule from './venue-package'

describe('venue-package evidence has one implementation', () => {
  // A draft is saved through the router and approved through the core. When each kept its own
  // copy, one corrupted warning message made every package with a duplicate title fail approval.
  it('re-exports the core preview and evidence functions instead of copying them', () => {
    expect(routerModule.buildVenuePackagePreview).toBe(core.buildVenuePackagePreview)
    expect(routerModule.parseStoredVenuePackagePreview).toBe(core.parseStoredVenuePackagePreview)
    expect(routerModule.assertStoredVenuePackageEvidenceCurrent).toBe(
      core.assertStoredVenuePackageEvidenceCurrent,
    )
    expect(routerModule.latestTargetVersions).toBe(core.latestTargetVersions)
    expect(routerModule.VenuePackageApprovedBaseStaleError).toBe(
      core.VenuePackageApprovedBaseStaleError,
    )
  })
})
