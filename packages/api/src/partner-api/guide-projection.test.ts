import { describe, expect, it } from 'vitest'

import { projectPartnerGuide } from './guide-projection'

const base = {
  distribution: { venueId: 'venue-1', app: { effective: true, reason: null } },
  venueSlug: 'museum',
  webOrigin: 'https://guide.example.com',
  appBackground: '#0d1116',
}

describe('partner guide projection', () => {
  it('returns only canonical app URLs and the allowlisted host background token', () => {
    expect(projectPartnerGuide(base)).toEqual({
      venueId: 'venue-1',
      urls: {
        app: 'https://guide.example.com/app/museum',
        compactApp: 'https://guide.example.com/app/museum?header=compact',
      },
      theme: { appBackground: '#0d1116' },
    })
  })

  it('omits the guide unless the canonical app distribution readback is effective', () => {
    expect(
      projectPartnerGuide({
        ...base,
        distribution: {
          venueId: 'venue-1',
          app: { effective: false, reason: 'ENTITLEMENT_DENIED' },
        },
      }),
    ).toBeNull()
  })

  it('fails closed if the canonical URL builder rejects the origin, slug, or color', () => {
    expect(projectPartnerGuide({ ...base, webOrigin: 'http://untrusted.example.com' })).toBeNull()
    expect(projectPartnerGuide({ ...base, venueSlug: 'Bad Slug' })).toBeNull()
    expect(projectPartnerGuide({ ...base, appBackground: 'url(javascript:alert(1))' })).toBeNull()
  })
})
