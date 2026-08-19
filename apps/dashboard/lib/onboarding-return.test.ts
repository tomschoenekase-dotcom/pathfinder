import { describe, expect, it } from 'vitest'

import {
  onboardingReturnHref,
  resolveOnboardingReturn,
  withOnboardingReturn,
} from './onboarding-return'

describe('onboarding return continuity', () => {
  it('preserves query/hash ordering and encoded venue identity', () => {
    expect(onboardingReturnHref('venue / one', 'MATERIALS')).toBe(
      '/venues/venue%20%2F%20one/onboarding#materials',
    )
    expect(withOnboardingReturn('/venues/v/intake#website-source', 'v', 'MATERIALS')).toBe(
      '/venues/v/intake?returnTo=%2Fvenues%2Fv%2Fonboarding%23materials#website-source',
    )
  })

  it('accepts only the exact venue journey and known stage', () => {
    expect(resolveOnboardingReturn('/venues/v/onboarding#review', 'v', 'MATERIALS')).toBe(
      '/venues/v/onboarding#review',
    )
    for (const unsafe of [
      'https://evil.example',
      '/venues/other/onboarding#review',
      '/venues/v/onboarding#unknown',
      '/venues/%E0%A4%A/onboarding#review',
    ]) {
      expect(resolveOnboardingReturn(unsafe, 'v', 'MATERIALS')).toBe(
        '/venues/v/onboarding#materials',
      )
    }
  })
})
