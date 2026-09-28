import { describe, expect, it } from 'vitest'

import { GUIDE_MODES, usesVisitorLocation } from './venue-configuration'

describe('guide modes', () => {
  it('lists the stored guide modes', () => {
    expect(GUIDE_MODES).toEqual(['location_aware', 'non_location', 'area_wide'])
  })

  it('treats area-wide guides as location-aware', () => {
    expect(usesVisitorLocation('location_aware')).toBe(true)
    expect(usesVisitorLocation('area_wide')).toBe(true)
    expect(usesVisitorLocation('non_location')).toBe(false)
    expect(usesVisitorLocation(null)).toBe(false)
    expect(usesVisitorLocation('unknown')).toBe(false)
  })
})
