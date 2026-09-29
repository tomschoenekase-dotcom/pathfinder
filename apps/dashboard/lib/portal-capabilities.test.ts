import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  isManagerRole,
  isOwnerRole,
  resolvePaymentAvailable,
  resolveWeeklyReportsAvailable,
} from './portal-capabilities'

type Caller = Parameters<typeof resolvePaymentAvailable>[0]

function caller(overrides: {
  overview?: () => Promise<unknown>
  availability?: () => Promise<unknown>
}): Caller {
  return {
    billing: { overview: overrides.overview ?? vi.fn() },
    analytics: { getWeeklyReportAvailability: overrides.availability ?? vi.fn() },
  } as unknown as Caller
}

describe('portal capability gates', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('shows payment only when the environment switch and tenant billing both allow it', async () => {
    const overview = vi.fn(async () => ({ enabled: true }))
    vi.stubEnv('STRIPE_BILLING_UI_ENABLED', 'false')
    expect(await resolvePaymentAvailable(caller({ overview }))).toBe(false)
    expect(overview).not.toHaveBeenCalled()

    vi.stubEnv('STRIPE_BILLING_UI_ENABLED', 'true')
    expect(await resolvePaymentAvailable(caller({ overview }))).toBe(true)
    expect(
      await resolvePaymentAvailable(caller({ overview: async () => ({ enabled: false }) })),
    ).toBe(false)
    expect(
      await resolvePaymentAvailable(
        caller({ overview: async () => Promise.reject(new Error('private detail')) }),
      ),
    ).toBe(false)
  })

  it('shows reports only for an enabled venue and fails closed', async () => {
    expect(
      await resolveWeeklyReportsAvailable(
        caller({ availability: async () => ({ enabledVenueIds: ['venue-2'] }) }),
      ),
    ).toBe(true)
    expect(
      await resolveWeeklyReportsAvailable(
        caller({ availability: async () => ({ enabledVenueIds: [] }) }),
      ),
    ).toBe(false)
    expect(
      await resolveWeeklyReportsAvailable(
        caller({ availability: async () => Promise.reject(new Error('down')) }),
      ),
    ).toBe(false)
  })

  it('mirrors the server role mapping for UI hints only', () => {
    expect(isManagerRole('org:member', false)).toBe(false)
    expect(isManagerRole('org:manager', false)).toBe(true)
    expect(isManagerRole('org:admin', false)).toBe(true)
    expect(isManagerRole(null, true)).toBe(true)
    expect(isOwnerRole('org:manager', false)).toBe(false)
    expect(isOwnerRole('org:admin', false)).toBe(true)
    expect(isOwnerRole('org:owner', false)).toBe(true)
  })
})
