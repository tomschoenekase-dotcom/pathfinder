import { describe, expect, it } from 'vitest'

import { CRM_FEATURE_POLICY, isCrmFeatureAvailable } from './feature-flags'

describe('CRM feature policy', () => {
  it('keeps deferred autonomous and Google-adjacent features server-off', () => {
    const enabled = {
      CRM_AUTONOMOUS_OUTREACH_ENABLED: 'true',
      CRM_CALENDAR_ENABLED: 'true',
      CRM_MEET_ENABLED: 'true',
      CRM_DRIVE_ENABLED: 'true',
      CRM_BOT_MODE_ENABLED: 'true',
    }
    for (const key of ['autonomousOutreach', 'calendar', 'meet', 'drive', 'botMode'] as const) {
      expect(CRM_FEATURE_POLICY[key].classification).toBe('off')
      expect(isCrmFeatureAvailable(key, 'platform-admin', enabled)).toBe(false)
    }
  })

  it('exposes the outreach pilot only to platform admins when explicitly enabled', () => {
    expect(isCrmFeatureAvailable('prospectOutreach', 'platform-admin', {})).toBe(false)
    expect(
      isCrmFeatureAvailable('prospectOutreach', 'platform-admin', {
        CRM_PROSPECT_OUTREACH_ENABLED: 'true',
      }),
    ).toBe(true)
    expect(
      isCrmFeatureAvailable('prospectOutreach', 'tenant-user', {
        CRM_PROSPECT_OUTREACH_ENABLED: 'true',
      }),
    ).toBe(false)
  })
})
