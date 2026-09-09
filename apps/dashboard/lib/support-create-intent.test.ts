import { describe, expect, it } from 'vitest'

import { supportCreateDraft } from './support-create-intent'

const base = {
  hasRequestedRequest: false,
  requestedVenueId: 'venue_beta',
  selectedVenueId: 'venue_beta',
}

describe('support create intent', () => {
  it('opens the existing branding request for an exact accessible venue', () => {
    expect(supportCreateDraft({ ...base, intent: 'theme-preference' })).toEqual({
      category: 'BRANDING',
      subject: 'Guide appearance preference',
    })
  })

  it('preserves the existing visitor insight draft', () => {
    expect(supportCreateDraft({ ...base, intent: 'visitor-insight' })).toEqual({
      category: 'CONTENT_CORRECTION',
      subject: 'Visitor experience review',
    })
  })

  it('lets an exact request take precedence over a create intent', () => {
    expect(
      supportCreateDraft({ ...base, intent: 'theme-preference', hasRequestedRequest: true }),
    ).toBeNull()
  })

  it.each([
    {
      label: 'a different selected venue',
      intent: 'theme-preference',
      selectedVenueId: 'venue_alpha',
    },
    { label: 'a missing requested venue', intent: 'theme-preference', requestedVenueId: undefined },
    { label: 'an unknown intent', intent: 'unknown' },
    { label: 'an array intent', intent: ['theme-preference'] },
  ])('does not prefill for $label', (input) => {
    expect(supportCreateDraft({ ...base, ...input })).toBeNull()
  })
})
